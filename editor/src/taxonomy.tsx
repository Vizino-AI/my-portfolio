import { useState } from 'react';
import { api, type Category, type Series, type SeriesStatus, type Taxonomy } from './api';
import { Modal, Tabs } from './dialogs';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A slug rename moves the posts in the database, but the post open in the
 * editor holds its own copy and would save the old slug back. This tells it.
 */
export interface TaxonomyRename {
  field: 'category' | 'series';
  from: string;
  to: string;
}

type Run = (action: () => Promise<unknown>, rename?: TaxonomyRename) => Promise<boolean>;

/**
 * Where categories and series are created, renamed and removed. A post picks
 * from these in its own side panel; nothing here edits a post directly,
 * except that a slug rename carries every post along with it.
 */
export function TaxonomyDialog({
  taxonomy,
  onChanged,
  onRenamed,
  onClose,
}: {
  taxonomy: Taxonomy;
  onChanged: () => void;
  onRenamed: (r: TaxonomyRename) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'categories' | 'series'>('categories');
  const [error, setError] = useState('');

  const run: Run = async (action, rename) => {
    setError('');
    try {
      await action();
      if (rename && rename.from !== rename.to) onRenamed(rename);
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <Modal title="分類與系列" onClose={onClose} wide>
      <Tabs
        value={tab}
        options={[
          ['categories', `分類（${taxonomy.categories.length}）`],
          ['series', `系列（${taxonomy.series.length}）`],
        ]}
        onChange={(t) => {
          setTab(t);
          setError('');
        }}
      />
      {error && <p className="error">{error}</p>}
      {tab === 'categories' ? <Categories categories={taxonomy.categories} run={run} /> : <SeriesList series={taxonomy.series} run={run} />}
    </Modal>
  );
}

/* ---------------------------------------------------------------- categories */

function Categories({ categories, run }: { categories: Category[]; run: Run }) {
  const [name, setName] = useState('');

  return (
    <div className="taxonomy">
      <p className="hint">每篇文章最多一個分類。網站會為每個分類產生一頁：/blog/category/slug。</p>
      <ol className="taxonomy__list">
        {categories.map((c, i) => (
          <CategoryRow
            key={c.slug}
            category={c}
            first={i === 0}
            last={i === categories.length - 1}
            run={run}
          />
        ))}
        {categories.length === 0 && <li className="hint">還沒有分類。</li>}
      </ol>
      <form
        className="taxonomy__add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.createCategory({ name }))) setName('');
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新分類名稱，例如 Vibe Coding" aria-label="新分類名稱" />
        <button type="submit" className="primary" disabled={!name.trim()}>
          新增分類
        </button>
      </form>
    </div>
  );
}

function CategoryRow({
  category,
  first,
  last,
  run,
}: {
  category: Category;
  first: boolean;
  last: boolean;
  run: Run;
}) {
  const [draft, setDraft] = useState(category);
  const changed = draft.name !== category.name || draft.slug !== category.slug || draft.description !== category.description;
  const slugValid = SLUG_RE.test(draft.slug);

  async function save() {
    if (
      draft.slug !== category.slug &&
      category.postCount > 0 &&
      !confirm(`改 slug 會讓 /blog/category/${category.slug} 失效，換成 /blog/category/${draft.slug}。確定？`)
    )
      return;
    // Position comes from the live row: ↑/↓ may have moved it since this draft was taken.
    await run(() => api.saveCategory(category.slug, { ...draft, position: category.position }), {
      field: 'category',
      from: category.slug,
      to: draft.slug,
    });
  }

  return (
    <li className="taxonomy__item">
      <div className="field-row">
        <label className="field">
          <span>名稱</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>slug</span>
          <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })} aria-invalid={!slugValid} />
        </label>
      </div>
      <label className="field">
        <span>說明（顯示在分類頁上方，選填）</span>
        <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </label>
      <div className="taxonomy__tools">
        <span className="hint">{category.postCount} 篇文章</span>
        <button type="button" className="icon-btn" disabled={first} onClick={() => run(() => api.moveCategory(category.slug, -1))} aria-label="上移">
          ↑
        </button>
        <button type="button" className="icon-btn" disabled={last} onClick={() => run(() => api.moveCategory(category.slug, 1))} aria-label="下移">
          ↓
        </button>
        <button
          type="button"
          className="danger"
          disabled={category.postCount > 0}
          title={category.postCount > 0 ? '先把文章移到別的分類' : undefined}
          onClick={() => confirm(`刪除分類「${category.name}」？`) && run(() => api.deleteCategory(category.slug))}
        >
          刪除
        </button>
        <button type="button" className="primary" disabled={!changed || !slugValid || !draft.name.trim()} onClick={save}>
          儲存
        </button>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------- series */

function SeriesList({ series, run }: { series: Series[]; run: Run }) {
  const [title, setTitle] = useState('');

  return (
    <div className="taxonomy">
      <p className="hint">
        系列是一組照順序讀的文章。文章在自己的側欄選系列和第幾篇；網站會產生 /blog/series/slug，並在每篇文章裡顯示系列目錄和上一篇／下一篇。
      </p>
      <ol className="taxonomy__list">
        {series.map((s) => (
          <SeriesRow key={s.slug} series={s} run={run} />
        ))}
        {series.length === 0 && <li className="hint">還沒有系列。</li>}
      </ol>
      <form
        className="taxonomy__add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.createSeries({ title }))) setTitle('');
        }}
      >
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新系列標題（英文，用來產生網址）" aria-label="新系列標題" />
        <button type="submit" className="primary" disabled={!title.trim()}>
          新增系列
        </button>
      </form>
    </div>
  );
}

function SeriesRow({ series, run }: { series: Series; run: Run }) {
  const [draft, setDraft] = useState(series);
  const changed =
    draft.title !== series.title || draft.slug !== series.slug || draft.description !== series.description || draft.status !== series.status ||
    draft.firstNumber !== series.firstNumber;
  const slugValid = SLUG_RE.test(draft.slug);
  const published = series.parts.filter((p) => !p.draft).length;

  async function save() {
    if (
      draft.slug !== series.slug &&
      published > 0 &&
      !confirm(`改 slug 會讓 /blog/series/${series.slug} 失效，換成 /blog/series/${draft.slug}。確定？`)
    )
      return;
    await run(() => api.saveSeries(series.slug, draft), { field: 'series', from: series.slug, to: draft.slug });
  }

  return (
    <li className="taxonomy__item">
      <div className="field-row">
        <label className="field">
          <span>標題</span>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </label>
        <label className="field">
          <span>slug</span>
          <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })} aria-invalid={!slugValid} />
        </label>
        <label className="field taxonomy__status">
          <span>狀態</span>
          <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as SeriesStatus })}>
            <option value="ongoing">連載中</option>
            <option value="complete">已完結</option>
          </select>
        </label>
        <label className="field taxonomy__status">
          <span>網站編號</span>
          <select value={draft.firstNumber} onChange={(e) => setDraft({ ...draft, firstNumber: e.target.value === '0' ? 0 : 1 })}>
            <option value={1}>從 Part 1 開始</option>
            <option value={0}>從 Part 0 開始</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>說明（顯示在系列頁上方，選填）</span>
        <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </label>
      {series.parts.length > 0 && (
        <ol className="taxonomy__parts">
          {series.parts.map((p, i) => (
            <li key={p.slug}>
              <span className="taxonomy__part-no">Part {i + draft.firstNumber}</span>
              <a href={`#/posts/${encodeURIComponent(p.slug)}`}>{p.title || '（未命名）'}</a>
              {p.draft && <span className="badge badge--draft">草稿</span>}
            </li>
          ))}
        </ol>
      )}
      <div className="taxonomy__tools">
        <span className="hint">
          {series.parts.length} 篇（{published} 篇已發佈）
        </span>
        <button
          type="button"
          className="danger"
          disabled={series.parts.length > 0}
          title={series.parts.length > 0 ? '先把文章移出這個系列' : undefined}
          onClick={() => confirm(`刪除系列「${series.title}」？`) && run(() => api.deleteSeries(series.slug))}
        >
          刪除
        </button>
        <button type="button" className="primary" disabled={!changed || !slugValid || !draft.title.trim()} onClick={save}>
          儲存
        </button>
      </div>
    </li>
  );
}
