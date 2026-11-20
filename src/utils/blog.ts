import { getCollection, type CollectionEntry } from 'astro:content';
import { isVisible } from './drafts';

export type Post = CollectionEntry<'blog'>;
export type Category = CollectionEntry<'blogCategories'>;
export type Series = CollectionEntry<'blogSeries'>;

export interface SeriesPart {
  post: Post;
  /**
   * Place in the series, counted over every part from the series' firstNumber
   * (0 or 1), so gaps in the editor's order don't show.
   */
  number: number;
  /** False for a draft in a production build: listed as coming soon, never linked. */
  visible: boolean;
}

export interface SeriesWithParts {
  series: Series;
  parts: SeriesPart[];
  visibleCount: number;
}

const byDateDesc = (a: Post, b: Post) => b.data.date.getTime() - a.data.date.getTime();

/** Posts that render in this build, newest first. */
export async function getPosts(): Promise<Post[]> {
  return (await getCollection('blog', isVisible)).sort(byDateDesc);
}

/**
 * Categories in the editor's order, each with its visible posts. A category
 * with nothing visible yet (all drafts, or empty) is left out, so the site
 * never links to an empty page.
 */
export async function getCategories(): Promise<Array<{ category: Category; posts: Post[] }>> {
  const [categories, posts] = await Promise.all([getCollection('blogCategories'), getPosts()]);
  return categories
    .sort((a, b) => a.data.position - b.data.position)
    .map((category) => ({ category, posts: posts.filter((p) => p.data.category?.id === category.id) }))
    .filter((c) => c.posts.length > 0);
}

/**
 * Every series that has at least one visible part. Parts include drafts on
 * purpose: they show up as "coming soon", so a reader can see where the
 * series is going.
 */
export async function getSeriesList(): Promise<SeriesWithParts[]> {
  const [seriesList, allPosts] = await Promise.all([getCollection('blogSeries'), getCollection('blog')]);
  return seriesList
    .map((series) => {
      const parts = allPosts
        .filter((p) => p.data.series?.id.id === series.id)
        .sort((a, b) => a.data.series!.order - b.data.series!.order || a.data.date.getTime() - b.data.date.getTime())
        .map((post, i) => ({ post, number: i + series.data.firstNumber, visible: isVisible(post) }));
      return { series, parts, visibleCount: parts.filter((p) => p.visible).length };
    })
    .filter((s) => s.visibleCount > 0);
}

/**
 * A part's title without a leading "Series Title #3 —" (or ":" / "-"), for
 * places that already say which series this is, like the series box.
 * Titles without that prefix come back unchanged.
 */
export function shortPartTitle(series: Series, post: Post): string {
  const escaped = series.data.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^${escaped}\\s*(?:#?\\d+)?\\s*[—–:-]\\s*`, 'i');
  return post.data.title.replace(prefix, '') || post.data.title;
}

/** Where a post sits in its series, with the nearest readable parts either side. */
export function findInSeries(seriesList: SeriesWithParts[], post: Post) {
  const entry = seriesList.find((s) => s.series.id === post.data.series?.id.id);
  if (!entry) return null;
  const index = entry.parts.findIndex((p) => p.post.id === post.id);
  if (index < 0) return null;
  const prev = entry.parts.slice(0, index).reverse().find((p) => p.visible) ?? null;
  const next = entry.parts.slice(index + 1).find((p) => p.visible) ?? null;
  return { ...entry, current: entry.parts[index], prev, next };
}

/** Short labels for a post card: its category name and, if any, "Series · Part n". */
export function cardLabels(post: Post, categories: Category[], seriesList: SeriesWithParts[]) {
  // A series label already says where the post belongs, so it replaces the category.
  const inSeries = findInSeries(seriesList, post);
  if (inSeries) return { series: `${inSeries.series.data.title} · Part ${inSeries.current.number}` };
  return { category: categories.find((c) => c.id === post.data.category?.id)?.data.name };
}
