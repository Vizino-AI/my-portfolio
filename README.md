# Portfolio site

![Homepage screenshot](public/images/screenshot.png)

Portfolio and services site for Yu-Wen Chen (Katness), published under the brand
name **Vizino AI** at <https://portfolio.vizino.ai>. Static site, no backend, no
runtime database, no user accounts.

This README is the single source of truth for how the project is put together.
If you are an AI agent working here, read it fully before editing — several
conventions below are not enforced by tooling and are easy to break by accident.

---

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` → http://localhost:4321 |
| Production build | `npm run build` → `dist/` |
| Preview the build | `npm run preview` |
| Type-check | `npm run check` |
| What CI runs | `npm ci && npm run check && npm run build` |
| Blog writing tool (local only) | `npm run editor` → http://127.0.0.1:4322 |
| Pull a blog post out of SQLite for editing | `npm run blog:pull -- <slug>` |
| Push an edited post back into SQLite | `npm run blog:push -- <slug>` |
| Regenerate the default OG image | `node scripts/make-og.mjs` |
| Convert PNG screenshots to WebP | `node scripts/optimize-images.mjs` |
| Screenshot live sites | `node scripts/shoot.mjs` (see Known gaps) |

## Definition of done

A change is not finished until all three hold:

1. `npm run check` reports 0 errors
2. `npm run build` completes with the expected page count
3. **This README reflects the change**

`.github/workflows/ci.yml` runs steps 1 and 2 on every push and on pull requests
into `main`, so a red build is visible even if you forget. There is still no test
suite, which means these two commands are the whole of the automated signal —
run them locally rather than discovering a failure in CI.

Step 3 is not optional and has no automated check at all, which is exactly why it
has to be a habit. If a change alters a command, a directory, a schema, a
workflow, a convention, or a deliberate non-goal described below, update that
section in the same commit. A README that has drifted out of date is worse than
a short one: the next person, or the next agent, will follow it confidently in
the wrong direction.

---

## Tech stack, and why

| Choice | Reason |
|---|---|
| **Astro**, static output | The site is content that needs to be discoverable and load fast. Static HTML with near-zero JS is the correct shape for that; a client-rendered SPA would be the wrong trade. |
| **Hand-written CSS**, no framework | Roughly a dozen components. Design tokens in `src/styles/tokens.css` cover it. Tailwind would add a build dependency and a class vocabulary for no gain at this size. |
| **Content Collections + Zod** | Case-study frontmatter is validated at build time, so a malformed entry fails the build rather than rendering broken. |
| **Vercel** | Static hosting plus analytics; matches the static output. |
| **TypeScript** | `npm run check` is the only correctness gate here, so types are carrying real weight. |
| **React + Tiptap**, `editor/` only | Rich-text editing needs a real editor component. It is a local tool that writes the database; none of it ships to the site, which stays static. |

## Directory map

```
.github/workflows/    CI — type-check and build on every push
astro.config.mjs      Site URL, sitemap integration
db/blog.sqlite3       Blog content (read-only at build time; committed to the repo)
editor/               Local blog writing tool (npm run editor) — never part of the build
public/               Served verbatim — images, favicon, robots.txt, OG image
scripts/              One-off maintenance scripts, not part of the build
src/
  components/         Presentational .astro components
  content/
    config.ts         Zod schemas for both collections
    loaders/          Custom Astro content loader for the SQLite blog
    work/             Case studies, one Markdown file per project
  data/               Static site data (profile, category labels)
  layouts/            BaseLayout — SEO, OG tags, Person JSON-LD
  pages/              Routes; [slug].astro files use getStaticPaths
  styles/             tokens.css (variables) then global.css (reset + base)
  utils/              Build-time helpers — drafts.ts owns the draft rule
_originals/           Pre-optimisation source images (gitignored)
_drafts/              Working area — see Blog workflow and Hidden sections
```

## Content model

Two collections, defined in `src/content/config.ts`.

**`work`** — case studies as Markdown in `src/content/work/`, one file per
project, validated by Zod.

**`blog`** — posts stored in `db/blog.sqlite3`, loaded by a custom loader at
`src/content/loaders/sqlite-blog.ts`. The database is opened read-only during
the build; nothing queries it at runtime. In dev the loader watches the file, so
edits appear without a restart.

| Table | Holds | Read by the site? |
|---|---|---|
| `posts` | One row per post: metadata plus the body as Markdown in `body_md` | Yes |
| `post_references` | The post's Sources list, ordered by `position`, rendered after the body | Yes |
| `post_revisions` | A JSON snapshot per save; saves within 10 minutes share one row, 100 kept per post | No — editor only |
| `media` | Every file in `public/images/blog/`, with kind, owning post, size and dimensions | No — editor only |

The editor creates the last three tables on first run (additive only — it never
alters `posts`), and the loader treats a missing `post_references` as "no
references", so an older database still builds.

### Draft handling — read this before adding content

Both collections have a `draft` boolean, and every query honours it through one
shared helper:

```ts
import { isVisible } from '../utils/drafts';
getCollection('work', isVisible)
getCollection('blog', isVisible)
```

`src/utils/drafts.ts` holds the whole rule: **drafts render in `npm run dev` so
you can preview them, and never appear in a production build** — excluded from
listings, from their own page, and from the sitemap. A draft article also shows
a "Draft — visible locally only" badge in dev so the two states are never
confused.

Always pass `isVisible` rather than writing the filter inline. Four call sites
previously each spelled it out, which is how the two collections drifted apart
in the first place.

`src/content/work/zenfolio.md` is currently `draft: true` on purpose: its
`highlights` are derived from seeded test transactions, not real usage, and its
frontmatter carries a TODO for the real figures. Set it to `false` once those
numbers are in.

## Blog workflow

Write in the editor, with `npm run dev` running alongside for the real preview:

```bash
npm run editor   # http://127.0.0.1:4322 — writes straight to db/blog.sqlite3
npm run dev      # http://localhost:4321 — picks up every save
```

The editor is a React + Tiptap single-page app served by Vite, with a small API
(`editor/server/`) mounted on the same dev server. It lists posts, creates
drafts, autosaves about a second after typing stops, and handles publish /
unpublish, metadata, cover, references and version history. A post becomes
public on the next deploy after it is published *and* `db/blog.sqlite3` is
committed.

**The body is still stored as Markdown**, so the site's rendering, Shiki code
highlighting, the outline and `blog:pull`/`blog:push` are unchanged. The editor
converts in both directions (`editor/src/markdown.ts`, `editor/src/extensions.tsx`)
and preserves this blog's own conventions exactly:

- image, then `*caption*` on the next line → one figure with an editable caption
- `<video …></video>`, then `*caption*` → video, tag kept verbatim
- `<iframe …></iframe>`, blank line, `*caption*` → YouTube / Vimeo embed
- any other HTML block → an editable raw-HTML block, written back verbatim
- code fences grow past any backtick run inside them (the CRAFTS prompt needs four)
- tables keep the `|---|---|` delimiter row

Opening a post never rewrites it: an untouched body is saved exactly as loaded.
If loading shows that a later save *would* change some lines (for example
`* item` becomes `- item`), the editor says so and lists them before anything
is written. All three current posts round-trip with zero changed lines — keep
it that way when touching either file above.

**Uploads** go to `public/images/blog/` named `<slug>-<name>`, with the untouched
file copied to `_originals/`. Photos and screenshots are resized to 1600px wide
and converted to WebP; SVG and GIF are kept as they are; a cover is cropped to
1600×1066 JPEG and saved as `<slug>.jpg`. Videos are stored as uploaded — the
editor warns above 20 MB, since they land in Git; use a YouTube / Vimeo embed
for anything long.

**No login, by design**: the server binds to 127.0.0.1 only. Because any web page
open in the same browser could still call it, writes must carry an
`X-Blog-Editor` header and a matching `Origin`, and CORS is off.

**Two macOS quirks the code works around** — do not "simplify" them away:

- The editor bumps the database file's mtime after each write
  (`notifySite` in `editor/server/db.ts`). Writes through its long-lived
  connection often raise no file-watcher event, so the dev site would keep
  showing the old post.
- The loader listens for `add` as well as `change`, since a SQLite write can
  surface as unlink + add.

**`blog:pull` / `blog:push`** still work for editing a post as a plain Markdown
file:

```bash
npm run blog:pull -- my-post-slug   # db/blog.sqlite3 → _drafts/my-post-slug.md
# edit _drafts/my-post-slug.md
npm run blog:push -- my-post-slug   # _drafts/my-post-slug.md → db/blog.sqlite3
```

They only know the `posts` table: references are left alone, and a push records
no revision. `_drafts/` is a scratch area, gitignored. Only the database is the
real store — do not treat a file in `_drafts/` as the source of truth.

## Images

**Blog covers** go in `public/images/blog/` as **landscape 1600x1066 JPEG**.
The editor's cover upload produces exactly this; the notes below are for adding
one by hand.
The article view renders a cover at its natural aspect ratio with no crop, so a
portrait image becomes a full-screen wall before the first paragraph. The card
listing crops to 1200x630 independently. Keep the untouched original in
`_originals/` — `scripts/optimize-images.mjs` does not cover this directory, so
resizing is manual.

Screenshots land in `public/images/work/` as PNG, then
`node scripts/optimize-images.mjs` converts them to WebP (max width 1920) and
moves the originals to `_originals/`. Reference the `.webp` filename from
frontmatter. `src/utils/imageSize.ts` reads dimensions at build time so images
carry width/height and do not cause layout shift.

## Design system

All values live in `src/styles/tokens.css` — colour, type scale, spacing,
easing. `global.css` imports it and sets the reset and base typography.
Component styles stay in the component's own `<style>` block.

**Deliberately not done.** These are choices, not omissions — do not add them
without asking:

- No gradients, drop shadows, or glassmorphism
- No dark mode
- No accent colour beyond `--c-accent` (`#0B5D51`), used only for links and hover
- No CSS framework
- No client-side JS beyond what a component genuinely needs
- English only, no i18n

## Case study page structure

`src/pages/work/[slug].astro` renders, in order: title and tagline → MetaBar
(year / role / duration / live and GitHub links) → full-width cover → StatRow
(`highlights`) → the Markdown body → ProjectNav (previous / next project).

The Markdown body is expected to open with `## Overview`, then `## My Role`,
then `## Architecture`. Three further sections — Technical Deep Dive, Outcome,
Reflection — were written and then removed from all five case studies; the text
is preserved in `_drafts/<slug>.md` below the separator and can be pasted back
onto the end of the corresponding file in `src/content/work/`.

---

## Known gaps

Real problems, recorded so they are not rediscovered:

- **No tests.** CI runs `npm run check` and `npm run build`, but nothing asserts
  that a page renders what it should. A broken layout or a wrong link ships.
- **`scripts/shoot.mjs` only runs on the original author's machine.** Line 1
  imports Playwright through an absolute path into an unrelated local project.
  It needs Playwright as a real devDependency before anyone else can run it.
- **Voice is inconsistent across pages.** `index.astro` and `about.astro` speak
  as one person; `how-we-work.astro` and `engagement-model.astro` still use
  "we" and "our". Pick one before the next content pass.
- **`featured` is set to `true` on every case study**, so the filter in
  `index.astro` currently selects everything. Harmless, but the field is not
  doing any work.
- **`db/blog.sqlite3` is a binary committed to Git**, so post edits produce
  opaque diffs and can conflict badly. Acceptable for one author; revisit if
  that changes. Revision snapshots make the file grow with every writing
  session (100 kept per post).
- **The editor has no automated tests either.** The round-trip guarantee is
  checked by opening each post and confirming the editor shows no "would be
  rewritten" notice.
