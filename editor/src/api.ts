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

export interface UploadResult extends Media {
  filename: string;
  originalBytes: number;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'X-Blog-Editor': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  listPosts: () => request<PostSummary[]>('GET', '/api/posts'),
  getPost: (slug: string) => request<Post>('GET', `/api/posts/${enc(slug)}`),
  createPost: (title: string) => request<Post>('POST', '/api/posts', { title }),
  savePost: (originalSlug: string, post: Post) => request<Post>('PUT', `/api/posts/${enc(originalSlug)}`, post),
  deletePost: (slug: string) => request<{ ok: true }>('DELETE', `/api/posts/${enc(slug)}`),
  listRevisions: (slug: string) => request<Revision[]>('GET', `/api/posts/${enc(slug)}/revisions`),
  getRevision: (id: number) => request<Post>('GET', `/api/revisions/${id}`),
  listMedia: () => request<Media[]>('GET', '/api/media'),

  async upload(file: File, opts: { kind: 'image' | 'video' | 'cover'; slug: string; alt?: string }) {
    const params = new URLSearchParams({ kind: opts.kind, slug: opts.slug, filename: file.name });
    if (opts.alt) params.set('alt', opts.alt);
    const res = await fetch(`/api/upload?${params}`, { method: 'POST', body: file, headers: { 'X-Blog-Editor': '1' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
    return data as UploadResult;
  },
};

export const SITE_ORIGIN = 'http://localhost:4321';

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
