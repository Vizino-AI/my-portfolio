import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * The editor's only door into db/blog.sqlite3.
 *
 * Journal mode stays at SQLite's default (DELETE), not WAL: the Astro dev
 * server watches the .sqlite3 file itself, and in WAL mode writes land in the
 * -wal file first, so the site would not notice a save.
 */

export interface Reference {
  title: string;
  url: string | null;
  source: string | null;
  note: string | null;
}

export interface Post {
  slug: string;
  title: string;
  date: string;
  updatedAt: string | null;
  excerpt: string;
  cover: string | null;
  coverAlt: string | null;
  draft: boolean;
  body: string;
  references: Reference[];
  /** Slug of the post's one category. */
  category: string | null;
  /** Slug of the series this post is a part of, and where it sits in it (1, 2, …). */
  series: string | null;
  seriesOrder: number | null;
}

export interface PostSummary {
  slug: string;
  title: string;
  date: string;
  draft: boolean;
  excerpt: string;
  lastSavedAt: string | null;
  category: string | null;
  series: string | null;
  seriesOrder: number | null;
}

export interface Category {
  slug: string;
  name: string;
  description: string;
  position: number;
  postCount: number;
}

export type SeriesStatus = 'ongoing' | 'complete';

export interface Series {
  slug: string;
  title: string;
  description: string;
  status: SeriesStatus;
  /** What the site calls the first part: 1 ("Part 1, 2, 3…") or 0, for a series that opens with a "Part 0" overview. */
  firstNumber: 0 | 1;
  /** Every part, drafts included, in reading order. */
  parts: Array<{ slug: string; title: string; order: number; draft: boolean }>;
}

export interface Revision {
  id: number;
  savedAt: string;
  title: string;
  words: number;
}

export interface Media {
  path: string;
  kind: 'image' | 'video' | 'cover';
  postSlug: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  createdAt: string;
}

interface PostRow {
  slug: string;
  title: string;
  date: string;
  updated_at: string | null;
  excerpt: string;
  cover: string | null;
  cover_alt: string | null;
  draft: number;
  body_md: string;
  category_slug: string | null;
  series_slug: string | null;
  series_order: number | null;
}

/** Autosaves within this window overwrite the latest revision instead of adding one. */
const REVISION_WINDOW_MS = 10 * 60 * 1000;
const REVISIONS_KEPT_PER_POST = 100;

export function openBlogDb(dbPath: string, mediaDir: string) {
  const db = new Database(dbPath);
  migrate(db);
  backfillMedia(db, mediaDir);

  /**
   * Tells the Astro dev server a post changed. On macOS, writes through this
   * long-lived connection often raise no file-watcher event at all (a short-
   * lived sqlite3 CLI write does), so the site would keep showing the old post.
   * Bumping the mtime always does.
   */
  const notifySite = () => {
    const now = new Date();
    utimesSync(dbPath, now, now);
  };

  const rowToPost = (row: PostRow): Post => ({
    slug: row.slug,
    title: row.title,
    date: row.date,
    updatedAt: row.updated_at,
    excerpt: row.excerpt,
    cover: row.cover,
    coverAlt: row.cover_alt,
    draft: Boolean(row.draft),
    body: row.body_md,
    references: db
      .prepare(
        'SELECT title, url, source, note FROM post_references WHERE post_slug = ? ORDER BY position'
      )
      .all(row.slug) as Reference[],
    category: row.category_slug,
    series: row.series_slug,
    seriesOrder: row.series_order,
  });

  function getPost(slug: string): Post | null {
    const row = db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug) as PostRow | undefined;
    return row ? rowToPost(row) : null;
  }

  function listPosts(): PostSummary[] {
    return (
      db
        .prepare(
          `SELECT p.slug, p.title, p.date, p.draft, p.excerpt,
                  p.category_slug AS category, p.series_slug AS series, p.series_order AS seriesOrder,
                  (SELECT MAX(saved_at) FROM post_revisions r WHERE r.post_slug = p.slug) AS last_saved_at
           FROM posts p
           ORDER BY p.draft DESC, p.date DESC, p.slug`
        )
        .all() as Array<Omit<PostSummary, 'draft' | 'lastSavedAt'> & { draft: number; last_saved_at: string | null }>
    ).map(({ draft, last_saved_at, ...rest }) => ({
      ...rest,
      draft: Boolean(draft),
      lastSavedAt: last_saved_at,
    }));
  }

  function snapshot(post: Post) {
    return JSON.stringify(post);
  }

  function recordRevision(post: Post) {
    const now = new Date();
    const latest = db
      .prepare('SELECT id, saved_at, snapshot FROM post_revisions WHERE post_slug = ? ORDER BY id DESC LIMIT 1')
      .get(post.slug) as { id: number; saved_at: string; snapshot: string } | undefined;
    const snap = snapshot(post);
    if (latest?.snapshot === snap) return;
    if (latest && now.getTime() - Date.parse(latest.saved_at) < REVISION_WINDOW_MS) {
      db.prepare('UPDATE post_revisions SET saved_at = ?, snapshot = ? WHERE id = ?').run(
        now.toISOString(),
        snap,
        latest.id
      );
    } else {
      db.prepare('INSERT INTO post_revisions (post_slug, saved_at, snapshot) VALUES (?, ?, ?)').run(
        post.slug,
        now.toISOString(),
        snap
      );
    }
    db.prepare(
      `DELETE FROM post_revisions WHERE post_slug = ? AND id NOT IN (
         SELECT id FROM post_revisions WHERE post_slug = ? ORDER BY id DESC LIMIT ?)`
    ).run(post.slug, post.slug, REVISIONS_KEPT_PER_POST);
  }

  /**
   * A post may only point at a category and series that exist, and two parts
   * of one series can't share a place in it, or the site couldn't tell which
   * is part 2.
   */
  function checkTaxonomy(post: Post) {
    if (post.category && !db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(post.category)) {
      throw new HttpError(400, `Category "${post.category}" no longer exists. Pick another one.`);
    }
    if (!post.series) return;
    if (!db.prepare('SELECT 1 FROM series WHERE slug = ?').get(post.series)) {
      throw new HttpError(400, `Series "${post.series}" no longer exists. Pick another one.`);
    }
    const clash = db
      .prepare('SELECT title FROM posts WHERE series_slug = ? AND series_order = ? AND slug != ?')
      .get(post.series, post.seriesOrder, post.slug) as { title: string } | undefined;
    if (clash) throw new HttpError(409, `Part ${post.seriesOrder} of this series is already "${clash.title}"`);
  }

  const writePost = db.transaction((post: Post) => {
    checkTaxonomy(post);
    db.prepare(
      `INSERT INTO posts (slug, title, date, updated_at, excerpt, cover, cover_alt, draft, body_md,
                          category_slug, series_slug, series_order)
       VALUES (@slug, @title, @date, @updatedAt, @excerpt, @cover, @coverAlt, @draft, @body,
               @category, @series, @seriesOrder)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, date = excluded.date, updated_at = excluded.updated_at,
         excerpt = excluded.excerpt, cover = excluded.cover, cover_alt = excluded.cover_alt,
         draft = excluded.draft, body_md = excluded.body_md,
         category_slug = excluded.category_slug, series_slug = excluded.series_slug,
         series_order = excluded.series_order`
    ).run({ ...post, draft: post.draft ? 1 : 0 });

    db.prepare('DELETE FROM post_references WHERE post_slug = ?').run(post.slug);
    const insertRef = db.prepare(
      `INSERT INTO post_references (post_slug, position, title, url, source, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    post.references.forEach((ref, i) =>
      insertRef.run(post.slug, i, ref.title, ref.url || null, ref.source || null, ref.note || null)
    );
  });

  /**
   * Saves a post. `originalSlug` is the slug the client loaded the post under;
   * when it differs from `post.slug`, the post is renamed and its references,
   * revisions and media move with it.
   */
  const savePost = db.transaction((originalSlug: string, post: Post) => {
    const existing = getPost(originalSlug);
    if (!existing) throw new HttpError(404, `No post "${originalSlug}"`);

    if (post.slug !== originalSlug) {
      if (getPost(post.slug)) throw new HttpError(409, `Slug "${post.slug}" is already taken`);
      db.prepare('UPDATE posts SET slug = ? WHERE slug = ?').run(post.slug, originalSlug);
      for (const table of ['post_references', 'post_revisions', 'media']) {
        db.prepare(`UPDATE ${table} SET post_slug = ? WHERE post_slug = ?`).run(post.slug, originalSlug);
      }
    }

    // The first save of a post that predates the editor keeps a copy of how it
    // was, so the version written by blog:push is always one click away.
    const hasRevision = db.prepare('SELECT 1 FROM post_revisions WHERE post_slug = ? LIMIT 1').get(post.slug);
    if (!hasRevision) {
      db.prepare('INSERT INTO post_revisions (post_slug, saved_at, snapshot) VALUES (?, ?, ?)').run(
        post.slug,
        new Date(0).toISOString(),
        snapshot({ ...existing, slug: post.slug })
      );
    }

    writePost(post);
    recordRevision(post);
    return getPost(post.slug)!;
  });

  function savePostAndNotify(originalSlug: string, post: Post): Post {
    const saved = savePost(originalSlug, post);
    notifySite();
    return saved;
  }

  function createPost(post: Post): Post {
    if (getPost(post.slug)) throw new HttpError(409, `Slug "${post.slug}" is already taken`);
    writePost(post);
    recordRevision(post);
    notifySite();
    return getPost(post.slug)!;
  }

  /** Revisions are kept on delete, so a deleted draft can still be found and restored. */
  function deletePost(slug: string) {
    const post = getPost(slug);
    if (!post) throw new HttpError(404, `No post "${slug}"`);
    if (!post.draft) throw new HttpError(400, 'Only drafts can be deleted. Unpublish it first.');
    db.transaction(() => {
      recordRevision(post);
      db.prepare('DELETE FROM post_references WHERE post_slug = ?').run(slug);
      db.prepare('DELETE FROM posts WHERE slug = ?').run(slug);
    })();
    notifySite();
  }

  function listRevisions(slug: string): Revision[] {
    const rows = db
      .prepare('SELECT id, saved_at, snapshot FROM post_revisions WHERE post_slug = ? ORDER BY id DESC')
      .all(slug) as Array<{ id: number; saved_at: string; snapshot: string }>;
    return rows.map((r) => {
      const post = JSON.parse(r.snapshot) as Post;
      return {
        id: r.id,
        savedAt: r.saved_at,
        title: post.title,
        words: post.body.trim() ? post.body.trim().split(/\s+/).length : 0,
      };
    });
  }

  function getRevision(id: number): Post | null {
    const row = db.prepare('SELECT snapshot FROM post_revisions WHERE id = ?').get(id) as
      | { snapshot: string }
      | undefined;
    return row ? (JSON.parse(row.snapshot) as Post) : null;
  }

  function listMedia(): Media[] {
    return (
      db.prepare('SELECT * FROM media ORDER BY created_at DESC, path').all() as Array<Record<string, unknown>>
    ).map(mediaFromRow);
  }

  function addMedia(m: Media) {
    db.prepare(
      `INSERT INTO media (path, kind, post_slug, alt, width, height, bytes, created_at)
       VALUES (@path, @kind, @postSlug, @alt, @width, @height, @bytes, @createdAt)
       ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, post_slug = excluded.post_slug,
         alt = excluded.alt, width = excluded.width, height = excluded.height,
         bytes = excluded.bytes, created_at = excluded.created_at`
    ).run(m);
  }

  /* ------------------------------------------------- categories & series */

  function listCategories(): Category[] {
    return db
      .prepare(
        `SELECT c.slug, c.name, c.description, c.position,
                (SELECT COUNT(*) FROM posts p WHERE p.category_slug = c.slug) AS postCount
         FROM categories c ORDER BY c.position, c.name`
      )
      .all() as Category[];
  }

  function listSeries(): Series[] {
    const rows = db.prepare('SELECT slug, title, description, status, first_number AS firstNumber FROM series ORDER BY created_at, slug').all() as Array<
      Omit<Series, 'parts'>
    >;
    const parts = db.prepare(
      `SELECT slug, title, series_order AS "order", draft FROM posts
       WHERE series_slug = ? ORDER BY series_order, date, slug`
    );
    return rows.map((s) => ({
      ...s,
      parts: (parts.all(s.slug) as Array<{ slug: string; title: string; order: number; draft: number }>).map((p) => ({
        ...p,
        draft: Boolean(p.draft),
      })),
    }));
  }

  /** Renaming a slug moves every post that points at it, in the same transaction. */
  const saveCategory = db.transaction((originalSlug: string | null, c: Omit<Category, 'postCount'>) => {
    if (c.slug !== originalSlug && db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(c.slug)) {
      throw new HttpError(409, `Category slug "${c.slug}" is already taken`);
    }
    if (originalSlug === null) {
      const next = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM categories').get() as { n: number }).n;
      db.prepare('INSERT INTO categories (slug, name, description, position) VALUES (?, ?, ?, ?)').run(
        c.slug,
        c.name,
        c.description,
        next
      );
    } else {
      const res = db
        .prepare('UPDATE categories SET slug = ?, name = ?, description = ?, position = ? WHERE slug = ?')
        .run(c.slug, c.name, c.description, c.position, originalSlug);
      if (!res.changes) throw new HttpError(404, `No category "${originalSlug}"`);
      if (c.slug !== originalSlug) {
        db.prepare('UPDATE posts SET category_slug = ? WHERE category_slug = ?').run(c.slug, originalSlug);
      }
    }
  });

  /** Swaps a category with its neighbour; `direction` -1 moves it up the list. */
  const moveCategory = db.transaction((slug: string, direction: -1 | 1) => {
    const list = listCategories();
    const i = list.findIndex((c) => c.slug === slug);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const set = db.prepare('UPDATE categories SET position = ? WHERE slug = ?');
    list.forEach((c, n) => set.run(n, c.slug));
  });

  /** In use means in use: posts have to be moved out first, so none silently loses its category. */
  function deleteCategory(slug: string) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE category_slug = ?').get(slug) as { n: number };
    if (used.n) throw new HttpError(400, `${used.n} post(s) are still in this category. Move them first.`);
    if (!db.prepare('DELETE FROM categories WHERE slug = ?').run(slug).changes) throw new HttpError(404, `No category "${slug}"`);
  }

  const saveSeries = db.transaction((originalSlug: string | null, s: Omit<Series, 'parts'>) => {
    if (s.slug !== originalSlug && db.prepare('SELECT 1 FROM series WHERE slug = ?').get(s.slug)) {
      throw new HttpError(409, `Series slug "${s.slug}" is already taken`);
    }
    if (originalSlug === null) {
      db.prepare('INSERT INTO series (slug, title, description, status, first_number, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        s.slug,
        s.title,
        s.description,
        s.status,
        s.firstNumber,
        new Date().toISOString()
      );
    } else {
      const res = db
        .prepare('UPDATE series SET slug = ?, title = ?, description = ?, status = ?, first_number = ? WHERE slug = ?')
        .run(s.slug, s.title, s.description, s.status, s.firstNumber, originalSlug);
      if (!res.changes) throw new HttpError(404, `No series "${originalSlug}"`);
      if (s.slug !== originalSlug) {
        db.prepare('UPDATE posts SET series_slug = ? WHERE series_slug = ?').run(s.slug, originalSlug);
      }
    }
  });

  function deleteSeries(slug: string) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE series_slug = ?').get(slug) as { n: number };
    if (used.n) throw new HttpError(400, `${used.n} post(s) are still in this series. Take them out first.`);
    if (!db.prepare('DELETE FROM series WHERE slug = ?').run(slug).changes) throw new HttpError(404, `No series "${slug}"`);
  }

  const withNotify =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      const result = fn(...args);
      notifySite();
      return result;
    };

  return {
    listCategories,
    saveCategory: withNotify(saveCategory),
    moveCategory: withNotify(moveCategory),
    deleteCategory: withNotify(deleteCategory),
    listSeries,
    saveSeries: withNotify(saveSeries),
    deleteSeries: withNotify(deleteSeries),
    getPost,
    listPosts,
    savePost: savePostAndNotify,
    createPost,
    deletePost,
    listRevisions,
    getRevision,
    listMedia,
    addMedia,
    close: () => db.close(),
  };
}

export type BlogDb = ReturnType<typeof openBlogDb>;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

function mediaFromRow(r: Record<string, unknown>): Media {
  return {
    path: r.path as string,
    kind: r.kind as Media['kind'],
    postSlug: (r.post_slug as string) ?? null,
    alt: (r.alt as string) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    bytes: r.bytes as number,
    createdAt: r.created_at as string,
  };
}

/**
 * Additive only: never alters or drops what the site's loader and the
 * blog:pull/blog:push scripts depend on in `posts`.
 */
function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      updated_at TEXT,
      excerpt TEXT NOT NULL,
      cover TEXT,
      cover_alt TEXT,
      draft INTEGER NOT NULL DEFAULT 0,
      body_md TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_slug TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      source TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS post_references_by_post ON post_references (post_slug, position);

    CREATE TABLE IF NOT EXISTS post_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_slug TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS post_revisions_by_post ON post_revisions (post_slug, id);

    CREATE TABLE IF NOT EXISTS media (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      post_slug TEXT,
      alt TEXT,
      width INTEGER,
      height INTEGER,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS series (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'complete')),
      first_number INTEGER NOT NULL DEFAULT 1 CHECK (first_number IN (0, 1)),
      created_at TEXT NOT NULL
    );
  `);

  // Added after the series table first shipped; same additive rule as below.
  const seriesColumns = new Set((db.prepare('PRAGMA table_info(series)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!seriesColumns.has('first_number')) {
    db.exec('ALTER TABLE series ADD COLUMN first_number INTEGER NOT NULL DEFAULT 1 CHECK (first_number IN (0, 1))');
  }

  // New nullable columns on posts. ADD COLUMN leaves every existing row and
  // the columns blog:push writes untouched; it just can't say IF NOT EXISTS.
  const columns = new Set((db.prepare('PRAGMA table_info(posts)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of [
    ['category_slug', 'TEXT'],
    ['series_slug', 'TEXT'],
    ['series_order', 'INTEGER'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS posts_by_series ON posts (series_slug, series_order)');
}

/** Registers files that were put in public/images/blog/ by hand before the editor existed. */
async function backfillMedia(db: Database.Database, mediaDir: string) {
  if (!existsSync(mediaDir)) return;
  const known = new Set(
    (db.prepare('SELECT path FROM media').all() as Array<{ path: string }>).map((r) => r.path)
  );
  const covers = new Set(
    (db.prepare('SELECT cover FROM posts WHERE cover IS NOT NULL').all() as Array<{ cover: string }>).map(
      (r) => r.cover
    )
  );
  const slugs = (db.prepare('SELECT slug FROM posts').all() as Array<{ slug: string }>).map((r) => r.slug);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO media (path, kind, post_slug, alt, width, height, bytes, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
  );

  for (const file of readdirSync(mediaDir)) {
    const webPath = `/images/blog/${file}`;
    if (known.has(webPath) || file.startsWith('.')) continue;
    const full = path.join(mediaDir, file);
    const stat = statSync(full);
    const isVideo = /\.(mp4|webm|mov)$/i.test(file);
    let width: number | null = null;
    let height: number | null = null;
    if (!isVideo) {
      try {
        const meta = await sharp(full).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        continue; // not an image sharp understands; leave it out of the library
      }
    }
    const owner = slugs.filter((s) => file.startsWith(s)).sort((a, b) => b.length - a.length)[0] ?? null;
    insert.run(
      webPath,
      covers.has(file) ? 'cover' : isVideo ? 'video' : 'image',
      owner,
      width,
      height,
      stat.size,
      stat.mtime.toISOString()
    );
  }
}
