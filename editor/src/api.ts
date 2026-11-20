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
  category: string | null;
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
  /** What the site calls the first part: 1, or 0 for a series that opens with a "Part 0". */
  firstNumber: 0 | 1;
  parts: Array<{ slug: string; title: string; order: number; draft: boolean }>;
}

export interface Taxonomy {
  categories: Category[];
  series: Series[];
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

  taxonomy: () => request<Taxonomy>('GET', '/api/taxonomy'),
  createCategory: (c: Partial<Category>) => request<{ ok: true }>('POST', '/api/categories', c),
  saveCategory: (originalSlug: string, c: Partial<Category>) => request<{ ok: true }>('PUT', `/api/categories/${enc(originalSlug)}`, c),
  moveCategory: (slug: string, direction: -1 | 1) => request<{ ok: true }>('POST', `/api/categories/${enc(slug)}/move`, { direction }),
  deleteCategory: (slug: string) => request<{ ok: true }>('DELETE', `/api/categories/${enc(slug)}`),
  createSeries: (s: Partial<Series>) => request<{ ok: true }>('POST', '/api/series', s),
  saveSeries: (originalSlug: string, s: Partial<Series>) => request<{ ok: true }>('PUT', `/api/series/${enc(originalSlug)}`, s),
  deleteSeries: (slug: string) => request<{ ok: true }>('DELETE', `/api/series/${enc(slug)}`),

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
