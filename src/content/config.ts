import { defineCollection, reference, z } from 'astro:content';
import { sqliteBlogLoader, sqliteCategoryLoader, sqliteSeriesLoader } from './loaders/sqlite-blog';

const DB_PATH = 'db/blog.sqlite3';

const work = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    tagline: z.string(),
    category: z.enum(['fullstack-cloud-ai', 'fullstack-local-ai', 'static']),
    year: z.string(),
    role: z.string(),
    duration: z.string().optional(),
    featured: z.boolean().default(true),
    order: z.number(),
    cover: z.string().optional(),
    coverAlt: z.string().optional(),
    gallery: z
      .array(z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() }))
      .default([]),
    stack: z.object({
      frontend: z.array(z.string()).default([]),
      backend: z.array(z.string()).default([]),
      ai: z.array(z.string()).default([]),
      infra: z.array(z.string()).default([]),
    }),
    links: z
      .object({
        live: z.string().url().optional(),
        github: z.string().url().optional(),
      })
      .default({}),
    highlights: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    draft: z.boolean().default(false),
  }),
});

// Written in the editor's 分類與系列 dialog.
const blogCategories = defineCollection({
  loader: sqliteCategoryLoader({ dbPath: DB_PATH }),
  schema: z.object({
    name: z.string(),
    description: z.string().default(''),
    position: z.number(),
  }),
});

const blogSeries = defineCollection({
  loader: sqliteSeriesLoader({ dbPath: DB_PATH }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    status: z.enum(['ongoing', 'complete']),
    /** What the first part is called: 1 ("Part 1") or 0 (a "Part 0" overview). */
    firstNumber: z.union([z.literal(0), z.literal(1)]).default(1),
  }),
});

const blog = defineCollection({
  loader: sqliteBlogLoader({ dbPath: DB_PATH }),
  schema: z.object({
    title: z.string(),
    date: z.date(),
    updatedAt: z.date().optional(),
    excerpt: z.string(),
    cover: z.string().optional(),
    coverAlt: z.string().optional(),
    draft: z.boolean().default(false),
    references: z
      .array(
        z.object({
          title: z.string(),
          url: z.string().url().optional(),
          source: z.string().optional(),
          note: z.string().optional(),
        })
      )
      .default([]),
    // reference() makes the build fail on a post pointing at a missing category or series.
    category: reference('blogCategories').optional(),
    series: z
      .object({
        id: reference('blogSeries'),
        // Where the editor put it; the site numbers parts from this order, starting at the series' firstNumber.
        order: z.number(),
      })
      .optional(),
  }),
});

export const collections = { work, blog, blogCategories, blogSeries };
