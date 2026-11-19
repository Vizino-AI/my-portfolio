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
}

export interface PostSummary {
  slug: string;
  title: string;
  date: string;
  draft: boolean;
  excerpt: string;
  lastSavedAt: string | null;
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

  const writePost = db.transaction((post: Post) => {
    db.prepare(
      `INSERT INTO posts (slug, title, date, updated_at, excerpt, cover, cover_alt, draft, body_md)
       VALUES (@slug, @title, @date, @updatedAt, @excerpt, @cover, @coverAlt, @draft, @body)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, date = excluded.date, updated_at = excluded.updated_at,
         excerpt = excluded.excerpt, cover = excluded.cover, cover_alt = excluded.cover_alt,
         draft = excluded.draft, body_md = excluded.body_md`
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

  return {
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
  `);
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
