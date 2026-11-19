import { useCallback, useEffect, useState } from 'react';
import { api, type PostSummary } from './api';
import { PostEditor } from './PostEditor';

function slugFromHash() {
  const m = location.hash.match(/^#\/posts\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  const [slug, setSlug] = useState<string | null>(slugFromHash);
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // Bumped when a different post is opened, so the editor starts fresh; a
  // rename of the open post keeps the same editor (and the cursor).
  const [session, setSession] = useState(0);

  const refresh = useCallback(() => {
    api.listPosts().then(setPosts, (e) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    const onHash = () => {
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

  const shown = posts?.filter((p) => filter === 'all' || (filter === 'draft' ? p.draft : !p.draft));

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
              <span>{posts?.filter((p) => v === 'all' || (v === 'draft' ? p.draft : !p.draft)).length ?? ''}</span>
            </button>
          ))}
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
    </div>
  );
}
