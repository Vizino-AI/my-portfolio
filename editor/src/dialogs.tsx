import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { api, formatBytes, type Media, type Post, type Revision } from './api';
import { embedHtml, toEmbedUrl, videoHtml, type MediaAttrs } from './markdown';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="關閉">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={value === v ? 'is-active' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function insertMedia(editor: Editor, attrs: Partial<MediaAttrs>) {
  editor
    .chain()
    .focus()
    .insertContent({ type: 'media', attrs: { kind: 'image', src: '', alt: '', title: '', poster: '', caption: '', html: '', ...attrs } })
    .run();
}

/* ------------------------------------------------------------------ Image */

export function ImageDialog({ editor, slug, onClose }: { editor: Editor; slug: string; onClose: () => void }) {
  const [tab, setTab] = useState<'upload' | 'library' | 'url'>('upload');
  const [src, setSrc] = useState('');
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [library, setLibrary] = useState<Media[] | null>(null);

  useEffect(() => {
    if (tab === 'library' && !library) api.listMedia().then((m) => setLibrary(m.filter((x) => x.kind !== 'video')), (e) => setError(e.message));
  }, [tab, library]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.upload(file, { kind: 'image', slug, alt });
      setSrc(r.path);
      setNote(`已上傳 ${r.filename}：${formatBytes(r.originalBytes)} → ${formatBytes(r.bytes)}${r.width ? `，${r.width}×${r.height}` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="插入圖片" onClose={onClose} wide={tab === 'library'}>
      <Tabs value={tab} onChange={setTab} options={[['upload', '上傳'], ['library', '媒體庫'], ['url', '網址']]} />

      {tab === 'upload' && (
        <div className="field">
          <input type="file" accept="image/*" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
          <p className="hint">JPG / PNG 會自動縮到最寬 1600px 並轉成 WebP；SVG、GIF 保持原檔。原圖另存在 _originals/。</p>
        </div>
      )}

      {tab === 'library' && (
        <div className="media-grid">
          {!library && <p className="hint">載入中…</p>}
          {library?.map((m) => (
            <button
              key={m.path}
              type="button"
              className={`media-grid__item ${src === m.path ? 'is-active' : ''}`}
              onClick={() => {
                setSrc(m.path);
                if (m.alt && !alt) setAlt(m.alt);
              }}
              title={m.path}
            >
              <img src={m.path} alt="" loading="lazy" />
              <span>{m.path.split('/').pop()}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'url' && (
        <label className="field">
          <span>圖片網址</span>
          <input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://… 或 /images/blog/…" />
        </label>
      )}

      {busy && <p className="hint">上傳並壓縮中…</p>}
      {note && <p className="hint hint--ok">{note}</p>}
      {error && <p className="error">{error}</p>}
      {src && tab !== 'library' && <img className="dialog-preview" src={src} alt="" />}

      <label className="field">
        <span>替代文字 alt</span>
        <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="描述圖片內容" />
      </label>
      <label className="field">
        <span>圖說（選填）</span>
        <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="顯示在圖片下方的斜體說明" />
      </label>

      <footer className="modal__actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!src || busy}
          onClick={() => {
            insertMedia(editor, { kind: 'image', src, alt, caption });
            onClose();
          }}
        >
          插入
        </button>
      </footer>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Video */

const LARGE_VIDEO = 20 * 1024 * 1024;

export function VideoDialog({ editor, slug, onClose }: { editor: Editor; slug: string; onClose: () => void }) {
  const [tab, setTab] = useState<'upload' | 'embed'>('upload');
  const [src, setSrc] = useState('');
  const [poster, setPoster] = useState('');
  const [embedUrl, setEmbedUrl] = useState('');
  const [embedTitle, setEmbedTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  async function upload(file: File | undefined, kind: 'video' | 'image') {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.upload(file, { kind, slug });
      if (kind === 'video') {
        setSrc(r.path);
        setNote(
          `已上傳 ${r.filename}（${formatBytes(r.bytes)}）` +
            (r.bytes > LARGE_VIDEO ? '。檔案偏大，會直接進 Git repo；長影片建議改用 YouTube / Vimeo 嵌入。' : '')
        );
      } else {
        setPoster(r.path);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const embedSrc = toEmbedUrl(embedUrl);

  return (
    <Modal title="插入影片" onClose={onClose}>
      <Tabs value={tab} onChange={setTab} options={[['upload', '上傳影片檔'], ['embed', 'YouTube / Vimeo']]} />

      {tab === 'upload' ? (
        <>
          <label className="field">
            <span>影片檔（MP4 / WebM）</span>
            <input type="file" accept="video/mp4,video/webm,video/quicktime" disabled={busy} onChange={(e) => upload(e.target.files?.[0], 'video')} />
          </label>
          <label className="field">
            <span>封面畫格（選填，播放前顯示）</span>
            <input type="file" accept="image/*" disabled={busy} onChange={(e) => upload(e.target.files?.[0], 'image')} />
          </label>
          {src && <video className="dialog-preview" src={src} poster={poster || undefined} controls muted />}
        </>
      ) : (
        <>
          <label className="field">
            <span>影片網址</span>
            <input value={embedUrl} onChange={(e) => setEmbedUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
          </label>
          {embedUrl && !embedSrc && <p className="error">認不得這個網址，支援 YouTube 與 Vimeo。</p>}
          <label className="field">
            <span>影片標題（給螢幕閱讀器）</span>
            <input value={embedTitle} onChange={(e) => setEmbedTitle(e.target.value)} />
          </label>
          {embedSrc && <iframe className="dialog-preview dialog-preview--embed" src={embedSrc} title="預覽" />}
        </>
      )}

      {busy && <p className="hint">上傳中…</p>}
      {note && <p className="hint hint--ok">{note}</p>}
      {error && <p className="error">{error}</p>}

      <label className="field">
        <span>圖說（選填）</span>
        <input value={caption} onChange={(e) => setCaption(e.target.value)} />
      </label>

      <footer className="modal__actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || (tab === 'upload' ? !src : !embedSrc)}
          onClick={() => {
            if (tab === 'upload') insertMedia(editor, { kind: 'video', src, poster, caption, html: videoHtml(src, poster) });
            else insertMedia(editor, { kind: 'embed', src: embedSrc!, title: embedTitle, caption, html: embedHtml(embedSrc!, embedTitle) });
            onClose();
          }}
        >
          插入
        </button>
      </footer>
    </Modal>
  );
}

/* -------------------------------------------------------------- Revisions */

export function RevisionsDialog({ slug, onRestore, onClose }: { slug: string; onRestore: (post: Post) => void; onClose: () => void }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<{ id: number; post: Post } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listRevisions(slug).then(setRevisions, (e) => setError(e.message));
  }, [slug]);

  async function pick(id: number) {
    try {
      setSelected({ id, post: await api.getRevision(id) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const fmt = (iso: string) =>
    Date.parse(iso) === 0 ? '開始使用編輯器前的版本' : new Date(iso).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Modal title="版本紀錄" onClose={onClose} wide>
      <p className="hint">自動儲存時，10 分鐘內的修改併成同一個版本；每篇保留最近 100 個版本。</p>
      {error && <p className="error">{error}</p>}
      <div className="revisions">
        <ul className="revisions__list">
          {revisions?.length === 0 && <li className="hint">還沒有版本紀錄</li>}
          {revisions?.map((r, i) => (
            <li key={r.id}>
              <button type="button" className={selected?.id === r.id ? 'is-active' : ''} onClick={() => pick(r.id)}>
                <strong>{fmt(r.savedAt)}</strong>
                <span>
                  {i === 0 ? '目前版本 · ' : ''}
                  {r.words} 字
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="revisions__preview">
          {selected ? (
            <>
              <h3>{selected.post.title}</h3>
              <pre>{selected.post.body}</pre>
              <button type="button" className="primary" onClick={() => onRestore(selected.post)}>
                還原成這個版本
              </button>
            </>
          ) : (
            <p className="hint">選一個版本預覽</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ Link editing */

export function LinkBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [href, setHref] = useState(() => editor.getAttributes('link').href ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  function apply() {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else chain.setLink({ href: url }).run();
    onClose();
  }

  return (
    <form
      className="link-bar"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <span>連結</span>
      <input ref={input} value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://…" onKeyDown={(e) => e.key === 'Escape' && onClose()} />
      <button type="submit" className="primary">
        套用
      </button>
      {editor.isActive('link') && (
        <>
          <a href={editor.getAttributes('link').href} target="_blank" rel="noreferrer">
            開啟
          </a>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
              onClose();
            }}
          >
            移除連結
          </button>
        </>
      )}
      <button type="button" onClick={onClose}>
        取消
      </button>
    </form>
  );
}
