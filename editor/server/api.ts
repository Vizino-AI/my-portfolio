import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Plugin } from 'vite';
import { HttpError, openBlogDb, type BlogDb, type Post, type Reference } from './db';

const IMAGE_MAX_WIDTH = 1600;
const COVER_SIZE = { width: 1600, height: 1066 };
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

interface Paths {
  root: string;
  db: string;
  media: string;
  originals: string;
}

/**
 * The editor's backend, mounted on Vite's own dev server so `npm run editor`
 * is one process. Bound to localhost only (see vite.config.ts): there is no
 * login, because nothing here is reachable from outside this machine.
 */
export function blogApi(root: string): Plugin {
  const paths: Paths = {
    root,
    db: path.join(root, 'db', 'blog.sqlite3'),
    media: path.join(root, 'public', 'images', 'blog'),
    originals: path.join(root, '_originals'),
  };

  return {
    name: 'blog-editor-api',
    configureServer(server) {
      const db = openBlogDb(paths.db, paths.media);
      server.httpServer?.on('close', () => db.close());

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // Served here rather than by Vite's publicDir: Vite only learns about
        // public files through its watcher, so a fresh upload would 404.
        if (url.pathname.startsWith('/images/blog/')) return serveMedia(paths, url.pathname, req, res, next);
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          assertSameOrigin(req);
          const result = await route(db, paths, req, url);
          sendJson(res, 200, result ?? { ok: true });
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500;
          if (status === 500) console.error(err);
          sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}

async function route(db: BlogDb, paths: Paths, req: IncomingMessage, url: URL): Promise<unknown> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.replace(/^\/api\//, '').split('/').map(decodeURIComponent);

  if (parts[0] === 'posts') {
    const slug = parts[1];
    if (!slug) {
      if (method === 'GET') return db.listPosts();
      if (method === 'POST') return createPost(db, await readJson(req));
    } else if (parts[2] === 'revisions' && method === 'GET') {
      return db.listRevisions(slug);
    } else if (!parts[2]) {
      if (method === 'GET') return db.getPost(slug) ?? notFound(slug);
      if (method === 'PUT') return db.savePost(slug, validatePost(await readJson(req)));
      if (method === 'DELETE') return db.deletePost(slug);
    }
  }

  if (parts[0] === 'revisions' && parts[1] && method === 'GET') {
    return db.getRevision(Number(parts[1])) ?? notFound(`revision ${parts[1]}`);
  }

  if (parts[0] === 'media' && method === 'GET') return db.listMedia();

  if (parts[0] === 'upload' && method === 'POST') {
    const kind = url.searchParams.get('kind');
    const slug = url.searchParams.get('slug');
    const filename = url.searchParams.get('filename') ?? 'upload';
    const alt = url.searchParams.get('alt');
    if (kind !== 'image' && kind !== 'video' && kind !== 'cover') throw new HttpError(400, 'Unknown upload kind');
    if (!slug || !SLUG_RE.test(slug)) throw new HttpError(400, 'Upload needs the post slug');
    return upload(db, paths, { kind, slug, filename, alt, body: await readBody(req) });
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * No login, so the one thing to stop is another web page in the same browser
 * calling this API (CSRF). Writes must carry the editor's own header — which a
 * cross-site form or no-cors fetch cannot add — and any Origin must be this one.
 */
function assertSameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin request refused');
  if (req.method !== 'GET' && req.headers['x-blog-editor'] !== '1') throw new HttpError(403, 'Missing editor header');
}

function notFound(what: string): never {
  throw new HttpError(404, `Not found: ${what}`);
}

function createPost(db: BlogDb, input: { title?: string; slug?: string }): Post {
  const title = (input.title ?? '').trim() || 'Untitled';
  let slug = input.slug?.trim() || slugify(title) || 'untitled';
  for (let n = 2; db.getPost(slug); n++) slug = `${slugify(title) || 'untitled'}-${n}`;
  return db.createPost({
    slug,
    title,
    date: localDate(),
    updatedAt: null,
    excerpt: '',
    cover: null,
    coverAlt: null,
    draft: true,
    body: '',
    references: [],
  });
}

/**
 * A draft can be saved half-written. Publishing (draft: false) needs everything
 * the site's schema and blog:push treat as required, so a bad post can't ship.
 */
function validatePost(input: Partial<Post>): Post {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const post: Post = {
    slug: str(input.slug).trim(),
    title: str(input.title).trim(),
    date: str(input.date).trim(),
    updatedAt: opt(input.updatedAt),
    excerpt: str(input.excerpt).trim(),
    cover: opt(input.cover),
    coverAlt: opt(input.coverAlt),
    draft: input.draft !== false,
    body: str(input.body),
    references: (Array.isArray(input.references) ? input.references : [])
      .map(
        (r: Partial<Reference>): Reference => ({
          title: str(r.title).trim(),
          url: opt(r.url),
          source: opt(r.source),
          note: opt(r.note),
        })
      )
      .filter((r) => r.title || r.url),
  };

  if (!SLUG_RE.test(post.slug)) throw new HttpError(400, 'Slug may only use lowercase letters, digits and single hyphens');
  if (!DATE_RE.test(post.date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  if (post.updatedAt && !DATE_RE.test(post.updatedAt)) throw new HttpError(400, 'Updated date must be YYYY-MM-DD');
  for (const ref of post.references) {
    if (!ref.title) ref.title = ref.url!;
    if (ref.url && !/^https?:\/\/\S+$/.test(ref.url)) {
      throw new HttpError(400, `Reference link must start with http:// or https:// — "${ref.url}"`);
    }
  }
  if (!post.draft) {
    const missing = (['title', 'excerpt', 'body'] as const).filter((k) => !post[k].trim());
    if (missing.length) throw new HttpError(400, `Can't publish without: ${missing.join(', ')}`);
  }
  return post;
}

async function upload(
  db: BlogDb,
  paths: Paths,
  { kind, slug, filename, alt, body }: { kind: 'image' | 'video' | 'cover'; slug: string; filename: string; alt: string | null; body: Buffer }
) {
  mkdirSync(paths.media, { recursive: true });
  const ext = path.extname(filename).toLowerCase();
  const base = slugify(path.basename(filename, ext)) || kind;
  let out: { name: string; data: Buffer; width: number | null; height: number | null };

  if (kind === 'video') {
    if (!['.mp4', '.webm', '.mov'].includes(ext)) throw new HttpError(400, 'Video must be .mp4, .webm or .mov');
    out = { name: uniqueName(paths.media, `${slug}-${base}`, ext), data: body, width: null, height: null };
  } else {
    let image: sharp.Sharp;
    try {
      image = sharp(body, { animated: true });
      await image.metadata();
    } catch {
      throw new HttpError(400, 'That file is not an image this editor can read');
    }
    keepOriginal(paths, `${slug}-${base}${ext || '.bin'}`, body);

    if (kind === 'cover') {
      // Covers follow the README's spec: landscape 1600x1066 JPEG, cropped from the centre.
      const data = await sharp(body)
        .rotate()
        .resize({ ...COVER_SIZE, fit: 'cover', position: 'attention' })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer();
      out = { name: `${slug}.jpg`, data, ...COVER_SIZE };
    } else if (ext === '.svg' || ext === '.gif') {
      // Vector art and animations lose what makes them worth using if re-encoded.
      const meta = await sharp(body).metadata();
      out = { name: uniqueName(paths.media, `${slug}-${base}`, ext), data: body, width: meta.width ?? null, height: meta.pageHeight ?? meta.height ?? null };
    } else {
      const { data, info } = await sharp(body)
        .rotate()
        .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      out = { name: uniqueName(paths.media, `${slug}-${base}`, '.webp'), data, width: info.width, height: info.height };
    }
  }

  writeFileSync(path.join(paths.media, out.name), out.data);
  const media = {
    path: `/images/blog/${out.name}`,
    kind,
    postSlug: slug,
    alt: alt || null,
    width: out.width,
    height: out.height,
    bytes: out.data.length,
    createdAt: new Date().toISOString(),
  };
  db.addMedia(media);
  return { ...media, filename: out.name, originalBytes: body.length };
}

function keepOriginal(paths: Paths, name: string, data: Buffer) {
  mkdirSync(paths.originals, { recursive: true });
  const ext = path.extname(name);
  writeFileSync(path.join(paths.originals, uniqueName(paths.originals, path.basename(name, ext), ext)), data);
}

function uniqueName(dir: string, base: string, ext: string) {
  let name = `${base}${ext}`;
  for (let n = 2; existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
  return name;
}

export function slugify(text: string) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File is larger than 100 MB');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** Static files with Range support, which <video> needs to seek. */
function serveMedia(paths: Paths, pathname: string, req: IncomingMessage, res: ServerResponse, next: () => void) {
  const file = path.join(paths.media, path.basename(decodeURIComponent(pathname)));
  if (!existsSync(file)) return next();
  const size = statSync(file).size;
  res.setHeader('Content-Type', MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', size);
  createReadStream(file).pipe(res);
}
