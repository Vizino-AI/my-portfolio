import { useCallback, useEffect, useState } from 'react';
import { api, type PostSummary, type Taxonomy } from './api';
import { PostEditor } from './PostEditor';
import { TaxonomyDialog, type TaxonomyRename } from './taxonomy';

/** '' = everything; 'c:<slug>' / 's:<slug>' = one category or series; 'c:' = uncategorized. */
type GroupFilter = string;

function slugFromHash() {
  const m = location.hash.match(/^#\/posts\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  const [slug, setSlug] = useState<string | null>(slugFromHash);
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const [group, setGroup] = useState<GroupFilter>('');
  const [taxonomy, setTaxonomy] = useState<Taxonomy>({ categories: [], series: [] });
  const [managing, setManaging] = useState(false);
  const [lastRename, setLastRename] = useState<TaxonomyRename | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // Bumped when a different post is opened, so the editor starts fresh; a
  // rename of the open post keeps the same editor (and the cursor).
  const [session, setSession] = useState(0);

  // Series part lists depend on posts too, so both reload together.
  const refresh = useCallback(() => {
    api.listPosts().then(setPosts, (e) => setError(e.message));
    api.taxonomy().then(setTaxonomy, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => {
      setManaging(false);
      setSlug(slugFromHash());
      setSession((n) => n + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refresh]);

  const open = useCallback((s: string | null) => {
    history.pushState(null, '', s ? `#/posts/${encodeURIComponent(s)}` : '#/');
    setSlug(s);
    setSession((n) => n + 1);
  }, []);

  const renamed = useCallback((s: string) => {
    history.replaceState(null, '', `#/posts/${encodeURIComponent(s)}`);
    setSlug(s);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const post = await api.createPost(newTitle);
      setCreating(false);
      setNewTitle('');
      refresh();
      open(post.slug);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const inGroup = (p: PostSummary) =>
    !group ||
    (group.startsWith('c:') ? (p.category ?? '') === group.slice(2) : p.series === group.slice(2));
  const byStatus = (p: PostSummary, v: typeof filter) => v === 'all' || (v === 'draft' ? p.draft : !p.draft);
  const shown = posts
    ?.filter((p) => inGroup(p) && byStatus(p, filter))
    // Within one series, list it in reading order rather than by date.
    .sort((a, b) => (group.startsWith('s:') ? (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0) : 0));
  const categoryName = (slug: string | null) => taxonomy.categories.find((c) => c.slug === slug)?.name;

  return (
    <div className="app">
      <nav className="sidebar" aria-label="文章">
        <header className="sidebar__head">
          <h1>部落格</h1>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            + 新文章
          </button>
        </header>

        {creating && (
          <form className="new-post" onSubmit={create}>
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="文章標題（英文，用來產生網址）" onKeyDown={(e) => e.key === 'Escape' && setCreating(false)} />
            <div className="field-row">
              <button type="submit" className="primary">
                建立草稿
              </button>
              <button type="button" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </form>
        )}

        <div className="segmented" role="radiogroup" aria-label="篩選">
          {(
            [
              ['all', '全部'],
              ['draft', '草稿'],
              ['published', '已發佈'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={filter === v} className={filter === v ? 'is-active' : ''} onClick={() => setFilter(v)}>
              {label}
              <span>{posts?.filter((p) => inGroup(p) && byStatus(p, v)).length ?? ''}</span>
            </button>
          ))}
        </div>

        <div className="group-filter">
          <select value={group} onChange={(e) => setGroup(e.target.value)} aria-label="依分類或系列篩選">
            <option value="">所有分類與系列</option>
            {taxonomy.categories.length > 0 && (
              <optgroup label="分類">
                {taxonomy.categories.map((c) => (
                  <option key={c.slug} value={`c:${c.slug}`}>
                    {c.name}
                  </option>
                ))}
                <option value="c:">未分類</option>
              </optgroup>
            )}
            {taxonomy.series.length > 0 && (
              <optgroup label="系列">
                {taxonomy.series.map((s) => (
                  <option key={s.slug} value={`s:${s.slug}`}>
                    {s.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" onClick={() => setManaging(true)} title="新增、改名或刪除分類與系列">
            管理
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        <ul className="post-list">
          {shown?.map((p) => (
            <li key={p.slug}>
              <button type="button" className={p.slug === slug ? 'is-active' : ''} onClick={() => open(p.slug)}>
                <span className="post-list__title">{p.title || '（未命名）'}</span>
                <span className="post-list__meta">
                  <span className={`badge ${p.draft ? 'badge--draft' : 'badge--live'}`}>{p.draft ? '草稿' : '已發佈'}</span>
                  {p.date}
                  {p.series && p.seriesOrder && group === `s:${p.series}` ? (
                    <span>· 順序 {p.seriesOrder}</span>
                  ) : (
                    categoryName(p.category) && <span>· {categoryName(p.category)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {shown?.length === 0 && <li className="hint">沒有文章</li>}
        </ul>
      </nav>

      <main className="main">
        {slug ? (
          <PostEditor
            key={session}
            slug={slug}
            taxonomy={taxonomy}
            lastRename={lastRename}
            onManageTaxonomy={() => setManaging(true)}
            onSaved={refresh}
            onSlugChange={renamed}
            onDeleted={() => {
              refresh();
              open(null);
            }}
          />
        ) : (
          <div className="empty">
            <h2>選一篇文章開始寫</h2>
            <p>或按「+ 新文章」建立草稿。所有變更自動儲存到 db/blog.sqlite3。</p>
          </div>
        )}
      </main>

      {managing && <TaxonomyDialog taxonomy={taxonomy} onChanged={refresh} onRenamed={setLastRename} onClose={() => setManaging(false)} />}
    </div>
  );
}
