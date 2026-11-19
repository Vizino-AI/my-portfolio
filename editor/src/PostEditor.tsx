import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { api, SITE_ORIGIN, type Post, type Reference } from './api';
import { buildExtensions } from './extensions';
import { lineDiff, normalizeForCompare, toEditorMarkdown } from './markdown';
import { Toolbar } from './Toolbar';
import { ImageDialog, LinkBar, RevisionsDialog, VideoDialog } from './dialogs';

type SaveState =
  | { status: 'saved'; at: Date | null }
  | { status: 'dirty' }
  | { status: 'saving' }
  | { status: 'error'; message: string };

const AUTOSAVE_MS = 1200;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getMarkdown(editor: Editor): string {
  return (editor.storage as any).markdown.getMarkdown();
}

/** Loads Markdown into the editor and reports any line the save would change. */
export function loadMarkdown(editor: Editor, md: string) {
  editor.commands.setContent(toEditorMarkdown(md), { emitUpdate: false });
  return lineDiff(normalizeForCompare(md), normalizeForCompare(getMarkdown(editor)));
}

export function PostEditor({
  slug,
  onSaved,
  onSlugChange,
  onDeleted,
}: {
  slug: string;
  onSaved: () => void;
  onSlugChange: (slug: string) => void;
  onDeleted: () => void;
}) {
  const [post, setPost] = useState<Post | null>(null);
  const [loadError, setLoadError] = useState('');
  const [save, setSave] = useState<SaveState>({ status: 'saved', at: null });
  const [fidelity, setFidelity] = useState<ReturnType<typeof lineDiff>>([]);
  const [showFidelity, setShowFidelity] = useState(false);
  const [dialog, setDialog] = useState<null | 'image' | 'video' | 'revisions'>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [words, setWords] = useState(0);
  const [coverBust, setCoverBust] = useState(0);

  // Refs, because autosave and paste handlers outlive any one render.
  const postRef = useRef<Post | null>(null);
  const originalSlug = useRef(slug);
  const bodyTouched = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const pending = useRef(false);

  const editor = useEditor({
    extensions: useMemo(() => buildExtensions(), []),
    content: '',
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'true', lang: 'en' },
      handlePaste: (_view, event) => uploadDropped(event.clipboardData?.files),
      handleDrop: (_view, event) => uploadDropped((event as DragEvent).dataTransfer?.files),
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          setLinkOpen(true);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      bodyTouched.current = true;
      setWords(countWords(e.getText()));
      markDirtyRef.current();
    },
  });
  // The editor's callbacks are created once; they reach the latest render through refs.
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  // Console handle for debugging: window.__editor.storage.markdown.getMarkdown()
  if (import.meta.env.DEV) (window as any).__editor = editor;

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    if (!editor) return;
    // A rename from this editor's own save changes the prop too; nothing to reload.
    if (postRef.current && slug === originalSlug.current) return;
    let cancelled = false;
    originalSlug.current = slug;
    bodyTouched.current = false;
    api.getPost(slug).then(
      (p) => {
        if (cancelled) return;
        postRef.current = p;
        setPost(p);
        setFidelity(loadMarkdown(editor, p.body));
        setWords(countWords(editor.getText()));
        setSave({ status: 'saved', at: null });
      },
      (e) => !cancelled && setLoadError(e.message)
    );
    return () => {
      cancelled = true;
    };
  }, [slug, editor]);

  /* -------------------------------------------------------------- saving */

  const doSave = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current;
    if (!editor || !postRef.current) return false;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (inFlight.current) {
      pending.current = true;
      await inFlight.current;
      return true;
    }
    const current: Post = {
      ...postRef.current,
      // An untouched body is saved exactly as loaded, never re-serialized.
      body: bodyTouched.current ? getMarkdown(editor) : postRef.current.body,
    };
    setSave({ status: 'saving' });
    let ok = false;
    inFlight.current = (async () => {
      try {
        const saved = await api.savePost(originalSlug.current, current);
        ok = true;
        if (saved.slug !== originalSlug.current) {
          originalSlug.current = saved.slug;
          onSlugChange(saved.slug);
        }
        postRef.current = { ...postRef.current!, slug: saved.slug, body: current.body };
        // Once the body has been re-serialized the load-time diff no longer applies.
        // bodyTouched stays set: typing during this save must not be dropped by the next one.
        if (bodyTouched.current) setFidelity([]);
        setSave({ status: 'saved', at: new Date() });
        onSaved();
      } catch (e) {
        setSave({ status: 'error', message: (e as Error).message });
      }
    })();
    await inFlight.current;
    inFlight.current = null;
    if (pending.current) {
      pending.current = false;
      return doSave();
    }
    return ok;
  }, [onSaved, onSlugChange]);

  const markDirty = useCallback(() => {
    setSave((s) => (s.status === 'saving' ? s : { status: 'dirty' }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
  }, [doSave]);
  const markDirtyRef = useRef(markDirty);
  markDirtyRef.current = markDirty;

  const update = useCallback(
    (patch: Partial<Post>) => {
      postRef.current = { ...postRef.current!, ...patch };
      setPost(postRef.current);
      markDirty();
    },
    [markDirty]
  );

  // ⌘S saves now; leaving with unsaved changes asks first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (save.status === 'dirty' || save.status === 'saving' || save.status === 'error') e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [doSave, save.status]);

  // Flush a pending autosave when this post is closed (switching posts).
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        void doSaveRef.current();
      }
    },
    []
  );

  /* -------------------------------------------------------------- media */

  function uploadDropped(files: FileList | undefined | null): boolean {
    const images = [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length || !editor) return false;
    (async () => {
      for (const file of images) {
        try {
          const r = await api.upload(file, { kind: 'image', slug: originalSlug.current });
          editor.chain().focus().insertContent({ type: 'media', attrs: { kind: 'image', src: r.path, alt: '', title: '', poster: '', caption: '', html: '' } }).run();
        } catch (e) {
          setSave({ status: 'error', message: `上傳失敗：${(e as Error).message}` });
        }
      }
    })();
    return true;
  }

  async function uploadCover(file: File | undefined) {
    if (!file || !post) return;
    try {
      const r = await api.upload(file, { kind: 'cover', slug: originalSlug.current, alt: post.coverAlt ?? undefined });
      update({ cover: `${r.filename}` });
      // Same filename on re-upload: bust the browser cache for the preview.
      setCoverBust(Date.now());
    } catch (e) {
      setSave({ status: 'error', message: `封面上傳失敗：${(e as Error).message}` });
    }
  }

  /* ------------------------------------------------------- publish/delete */

  async function setDraft(draft: boolean) {
    if (!post) return;
    if (!draft && !confirm('發佈後，下次部署就會出現在正式網站。確定發佈？')) return;
    update({ draft });
    const ok = await doSave();
    if (!ok && !draft) update({ draft: true });
  }

  async function deleteDraft() {
    if (!post?.draft) return;
    if (!confirm(`刪除草稿「${post.title}」？\n\n版本紀錄會保留，之後仍可從資料庫找回。`)) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    try {
      await api.deletePost(originalSlug.current);
      onDeleted();
    } catch (e) {
      setSave({ status: 'error', message: (e as Error).message });
    }
  }

  function restore(rev: Post) {
    if (!editor) return;
    const { slug: _slug, ...rest } = rev; // a revision never renames the post
    loadMarkdown(editor, rev.body);
    bodyTouched.current = true;
    update(rest);
    setDialog(null);
  }

  /* -------------------------------------------------------------- render */

  if (loadError) return <div className="empty">讀取失敗：{loadError}</div>;
  if (!post || !editor) return <div className="empty">載入中…</div>;

  return (
    <div className="post-editor">
      <section className="writing">
        <div className="writing__top">
          <Toolbar editor={editor} onLink={() => setLinkOpen(true)} onImage={() => setDialog('image')} onVideo={() => setDialog('video')} />
          {linkOpen && <LinkBar editor={editor} onClose={() => setLinkOpen(false)} />}
        </div>

        <div className="writing__scroll">
          {fidelity.length > 0 && (
            <div className="notice">
              <p>
                這篇文章有 {fidelity.length} 行在編輯器裡會被改寫（例如空白或符號的寫法）。內容不變；只要不改內文，就會原樣保存。
                <button type="button" className="link-btn" onClick={() => setShowFidelity((v) => !v)}>
                  {showFidelity ? '收起' : '看差異'}
                </button>
              </p>
              {showFidelity && (
                <ol className="diff">
                  {fidelity.slice(0, 40).map((d) => (
                    <li key={d.line}>
                      <span className="diff__line">第 {d.line} 行</span>
                      <del>{d.before === null ? '(無此行)' : d.before || '(空行)'}</del>
                      <ins>{d.after === null ? '(無此行)' : d.after || '(空行)'}</ins>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          <article className="paper">
            <textarea
              className="paper__title"
              value={post.title}
              rows={1}
              placeholder="文章標題"
              onChange={(e) => update({ title: e.target.value.replace(/\n/g, ' ') })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  editor.commands.focus('start');
                }
              }}
              ref={autoGrow}
            />
            <EditorContent editor={editor} />
          </article>
        </div>

        <footer className="statusbar">
          <SaveIndicator state={save} onRetry={() => void doSave()} />
          <span>
            {words} 字 · 約 {Math.max(1, Math.ceil(words / 200))} 分鐘閱讀
          </span>
        </footer>
      </section>

      <MetaPanel
        post={post}
        update={update}
        slug={originalSlug.current}
        coverBust={coverBust}
        onCover={uploadCover}
        onPublish={() => setDraft(false)}
        onUnpublish={() => setDraft(true)}
        onDelete={deleteDraft}
        onRevisions={() => setDialog('revisions')}
      />

      {dialog === 'image' && <ImageDialog editor={editor} slug={originalSlug.current} onClose={() => setDialog(null)} />}
      {dialog === 'video' && <VideoDialog editor={editor} slug={originalSlug.current} onClose={() => setDialog(null)} />}
      {dialog === 'revisions' && <RevisionsDialog slug={originalSlug.current} onRestore={restore} onClose={() => setDialog(null)} />}
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const fit = () => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  fit();
  el.oninput = fit;
}

function countWords(text: string) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.status === 'saving') return <span className="save save--busy">儲存中…</span>;
  if (state.status === 'dirty') return <span className="save save--dirty">有未儲存的變更</span>;
  if (state.status === 'error')
    return (
      <span className="save save--error">
        儲存失敗：{state.message}{' '}
        <button type="button" className="link-btn" onClick={onRetry}>
          重試
        </button>
      </span>
    );
  return (
    <span className="save save--ok">
      {state.at ? `已儲存 ${state.at.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : '已是最新'}
    </span>
  );
}

/* ---------------------------------------------------------------- Meta panel */

function MetaPanel({
  post,
  update,
  slug,
  coverBust,
  onCover,
  onPublish,
  onUnpublish,
  onDelete,
  onRevisions,
}: {
  post: Post;
  update: (p: Partial<Post>) => void;
  slug: string;
  coverBust: number;
  onCover: (f: File | undefined) => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  onRevisions: () => void;
}) {
  const [slugDraft, setSlugDraft] = useState(post.slug);
  useEffect(() => setSlugDraft(post.slug), [post.slug]);
  const slugValid = SLUG_RE.test(slugDraft);

  return (
    <aside className="meta">
      <div className="meta__actions">
        {post.draft ? (
          <button type="button" className="primary" onClick={onPublish}>
            發佈
          </button>
        ) : (
          <button type="button" onClick={onUnpublish}>
            改回草稿
          </button>
        )}
        <a className="btn" href={`${SITE_ORIGIN}/blog/${slug}`} target="_blank" rel="noreferrer" title="需要另外執行 npm run dev">
          在網站預覽 ↗
        </a>
      </div>

      <section className="meta__section">
        <h3>文章資訊</h3>
        <label className="field">
          <span>網址代稱 slug</span>
          <input
            value={slugDraft}
            onChange={(e) => setSlugDraft(e.target.value.toLowerCase())}
            onBlur={() => {
              if (slugValid && slugDraft !== post.slug) {
                if (post.draft || confirm('這篇已發佈，改 slug 會讓舊網址失效。確定要改？')) update({ slug: slugDraft });
                else setSlugDraft(post.slug);
              }
            }}
            aria-invalid={!slugValid}
          />
          {!slugValid && <small className="error">只能用小寫英文、數字和單一連字號</small>}
          <small className="hint">/blog/{slugDraft}</small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>發佈日期</span>
            <input type="date" value={post.date} onChange={(e) => e.target.value && update({ date: e.target.value })} />
          </label>
          <label className="field">
            <span>更新日期（選填）</span>
            <input type="date" value={post.updatedAt ?? ''} onChange={(e) => update({ updatedAt: e.target.value || null })} />
          </label>
        </div>
        <label className="field">
          <span>
            摘要 <small className={post.excerpt.length > 160 ? 'error' : 'hint'}>{post.excerpt.length}/160</small>
          </span>
          <textarea rows={4} value={post.excerpt} onChange={(e) => update({ excerpt: e.target.value })} placeholder="列表頁與搜尋結果顯示的一兩句話" />
        </label>
      </section>

      <section className="meta__section">
        <h3>封面</h3>
        {post.cover ? (
          <img className="meta__cover" src={`/images/blog/${post.cover}?v=${coverBust}`} alt="" />
        ) : (
          <p className="hint">還沒有封面。上傳後會自動裁成 1600×1066 JPEG。</p>
        )}
        <div className="field-row">
          <label className="btn file-btn">
            {post.cover ? '更換封面' : '上傳封面'}
            <input type="file" accept="image/*" onChange={(e) => onCover(e.target.files?.[0])} />
          </label>
          {post.cover && (
            <button type="button" onClick={() => update({ cover: null })}>
              移除
            </button>
          )}
        </div>
        <label className="field">
          <span>封面替代文字</span>
          <input value={post.coverAlt ?? ''} onChange={(e) => update({ coverAlt: e.target.value || null })} />
        </label>
      </section>

      <References refs={post.references} onChange={(references) => update({ references })} />

      <section className="meta__section meta__section--quiet">
        <button type="button" onClick={onRevisions}>
          版本紀錄
        </button>
        {post.draft && (
          <button type="button" className="danger" onClick={onDelete}>
            刪除草稿
          </button>
        )}
      </section>
    </aside>
  );
}

function References({ refs, onChange }: { refs: Reference[]; onChange: (r: Reference[]) => void }) {
  const set = (i: number, patch: Partial<Reference>) => onChange(refs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...refs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <section className="meta__section">
      <h3>參考資料</h3>
      <p className="hint">會以「Sources」清單顯示在文章最後。</p>
      <ol className="refs">
        {refs.map((r, i) => {
          const badUrl = !!r.url && !/^https?:\/\/\S+$/.test(r.url);
          return (
            <li key={i} className="ref">
              <input value={r.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="標題" aria-label="標題" />
              <input value={r.url ?? ''} onChange={(e) => set(i, { url: e.target.value || null })} placeholder="https://…" aria-label="網址" aria-invalid={badUrl} />
              {badUrl && <small className="error">網址需以 http:// 或 https:// 開頭</small>}
              <input value={r.source ?? ''} onChange={(e) => set(i, { source: e.target.value || null })} placeholder="來源（作者 / 媒體，選填）" aria-label="來源" />
              <input value={r.note ?? ''} onChange={(e) => set(i, { note: e.target.value || null })} placeholder="備註（選填）" aria-label="備註" />
              <div className="ref__tools">
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="上移">
                  ↑
                </button>
                <button type="button" className="icon-btn" disabled={i === refs.length - 1} onClick={() => move(i, 1)} aria-label="下移">
                  ↓
                </button>
                <button type="button" className="icon-btn" onClick={() => onChange(refs.filter((_, j) => j !== i))} aria-label="刪除">
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" onClick={() => onChange([...refs, { title: '', url: null, source: null, note: null }])}>
        + 新增參考資料
      </button>
    </section>
  );
}

