import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Loader } from 'astro/loaders';

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

interface ReferenceRow {
  post_slug: string;
  title: string;
  url: string | null;
  source: string | null;
  note: string | null;
}

/**
 * `new Date('2026-08-22')` parses as UTC midnight, which then renders as the
 * previous day in any timezone behind UTC. Parsing the parts and building a
 * local-midnight Date keeps the calendar date stable regardless of the
 * machine's timezone (dev laptop vs. build server).
 */
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function sqliteBlogLoader({ dbPath }: { dbPath: string }): Loader {
  return {
    name: 'sqlite-blog-loader',
    load: async ({ store, config, parseData, renderMarkdown, generateDigest, logger, watcher }) => {
      const absPath = fileURLToPath(new URL(dbPath, config.root));

      async function sync() {
        const db = new Database(absPath, { readonly: true });
        const rows = db.prepare('SELECT * FROM posts').all() as PostRow[];
        // post_references is created by the editor (npm run editor); a database
        // that has never been opened by it simply has no references yet.
        const hasReferences = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'post_references'")
          .get();
        const referenceRows = hasReferences
          ? (db
              .prepare('SELECT post_slug, title, url, source, note FROM post_references ORDER BY post_slug, position')
              .all() as ReferenceRow[])
          : [];
        db.close();

        const referencesBySlug = new Map<string, ReferenceRow[]>();
        for (const ref of referenceRows) {
          const list = referencesBySlug.get(ref.post_slug) ?? [];
          list.push(ref);
          referencesBySlug.set(ref.post_slug, list);
        }

        store.clear();

        for (const row of rows) {
          const references = (referencesBySlug.get(row.slug) ?? []).map((ref) => ({
            title: ref.title,
            url: ref.url ?? undefined,
            source: ref.source ?? undefined,
            note: ref.note ?? undefined,
          }));
          const data = await parseData({
            id: row.slug,
            data: {
              title: row.title,
              date: parseLocalDate(row.date),
              updatedAt: row.updated_at ? parseLocalDate(row.updated_at) : undefined,
              excerpt: row.excerpt,
              cover: row.cover ?? undefined,
              coverAlt: row.cover_alt ?? undefined,
              draft: Boolean(row.draft),
              references,
            },
          });

          const rendered = await renderMarkdown(row.body_md);

          store.set({
            id: row.slug,
            data,
            body: row.body_md,
            rendered,
            digest: generateDigest(JSON.stringify({ row, references })),
          });
        }

        logger.info(`Loaded ${rows.length} post(s) from SQLite`);
      }

      await sync();

      // In dev, watch the .sqlite3 file itself so edits show up without restarting the server.
      // On macOS a SQLite write often reaches the watcher as unlink + add rather
      // than change, so add counts too. The editor saves every second or so
      // while typing; the debounce keeps one sync from racing the next.
      if (watcher) {
        watcher.add(absPath);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onEvent = (changedPath: string) => {
          if (changedPath !== absPath) return;
          clearTimeout(timer);
          timer = setTimeout(async () => {
            if (!existsSync(absPath)) return;
            await sync();
            logger.info('Reloaded posts after blog.sqlite3 change');
          }, 150);
        };
        watcher.on('change', onEvent);
        watcher.on('add', onEvent);
      }
    },
  };
}
