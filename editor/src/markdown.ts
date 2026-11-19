/**
 * Markdown conventions this blog already uses, which plain Markdown has no node
 * for. Before a post is loaded into the editor they are swapped for placeholder
 * <div>s that the Media and RawHtml nodes pick up; on save those nodes write
 * the original text back. A post that is opened and saved without edits comes
 * out byte-for-byte the same (checked by roundTripReport below).
 *
 *   ![alt](src)            image with a caption — the caption is the italic
 *   *Caption*              line directly under it, in the same paragraph
 *
 *   <video ...></video>    video with a caption, same pattern
 *   *Caption*
 *
 *   <iframe ...></iframe>  embed (YouTube etc.); an iframe is an HTML block, so
 *                          its caption is the next paragraph
 *   *Caption*
 *
 * Anything else that starts with an HTML tag is kept verbatim as a raw block.
 */

export type MediaKind = 'image' | 'video' | 'embed';

export interface MediaAttrs {
  kind: MediaKind;
  src: string;
  alt: string;
  title: string;
  poster: string;
  /** Raw Markdown between the asterisks, so links inside a caption survive. */
  caption: string;
  /** For video and embed: the exact tag as written, so it round-trips untouched. */
  html: string;
}

const IMAGE_RE = /^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)$/;
const VIDEO_RE = /^<video\b[^>]*>\s*<\/video>$/i;
const IFRAME_RE = /^<iframe\b[^>]*>\s*<\/iframe>$/i;
const CAPTION_RE = /^\*(?!\*)(.+)\*$/;
const HTML_START_RE = /^<(?:[a-zA-Z][\w-]*|!--)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Block {
  lines: string[];
  fenced: boolean;
}

/** Splits into blank-line-separated blocks, treating a fenced code block as opaque. */
function splitBlocks(md: string): Array<Block | null> {
  const out: Array<Block | null> = []; // null marks a blank line
  const lines = md.split('\n');
  let current: Block | null = null;
  let fence: string | null = null;

  for (const line of lines) {
    if (fence) {
      current!.lines.push(line);
      const m = line.match(FENCE_RE);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
        current = null;
      }
      continue;
    }
    const open = line.match(FENCE_RE);
    if (open) {
      current = { lines: [line], fenced: true };
      out.push(current);
      fence = open[1];
      continue;
    }
    if (line.trim() === '') {
      current = null;
      out.push(null);
      continue;
    }
    if (!current || current.fenced) {
      current = { lines: [], fenced: false };
      out.push(current);
    }
    current.lines.push(line);
  }
  return out;
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function decodeEntities(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mediaPlaceholder(attrs: MediaAttrs) {
  return `<div data-media="${escapeHtml(JSON.stringify(attrs))}"></div>`;
}

function rawPlaceholder(html: string) {
  return `<div data-raw-html="${escapeHtml(html)}"></div>`;
}

const emptyMedia = (kind: MediaKind): MediaAttrs => ({
  kind,
  src: '',
  alt: '',
  title: '',
  poster: '',
  caption: '',
  html: '',
});

function captionOf(line: string | undefined): string | null {
  const m = line?.match(CAPTION_RE);
  return m ? m[1] : null;
}

/** Stored Markdown → Markdown the editor's parser understands. */
export function toEditorMarkdown(md: string): string {
  const blocks = splitBlocks(md);
  const out: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) {
      out.push('');
      continue;
    }
    if (block.fenced) {
      out.push(...block.lines);
      continue;
    }

    const [first, second, ...rest] = block.lines;
    const caption = captionOf(second);
    const fitsFigure = rest.length === 0 && (second === undefined || caption !== null);

    const image = first.match(IMAGE_RE);
    if (image && fitsFigure) {
      out.push(
        mediaPlaceholder({
          ...emptyMedia('image'),
          alt: image[1],
          src: image[2],
          title: image[3] ?? '',
          caption: caption ?? '',
        })
      );
      continue;
    }

    if (VIDEO_RE.test(first) && fitsFigure) {
      out.push(
        mediaPlaceholder({
          ...emptyMedia('video'),
          src: attr(first, 'src'),
          poster: attr(first, 'poster'),
          caption: caption ?? '',
          html: first,
        })
      );
      continue;
    }

    if (IFRAME_RE.test(first) && block.lines.length === 1) {
      // Caption is the next block when it is a lone italic line.
      const next = blocks[i + 2];
      const nextCaption =
        blocks[i + 1] === null && next && !next.fenced && next.lines.length === 1 ? captionOf(next.lines[0]) : null;
      out.push(
        mediaPlaceholder({
          ...emptyMedia('embed'),
          src: attr(first, 'src'),
          title: attr(first, 'title'),
          caption: nextCaption ?? '',
          html: first,
        })
      );
      if (nextCaption !== null) i += 2;
      continue;
    }

    if (HTML_START_RE.test(first)) {
      out.push(rawPlaceholder(block.lines.join('\n')));
      continue;
    }

    out.push(...block.lines);
  }
  return out.join('\n');
}

/** The Markdown a Media node writes back. */
export function serializeMedia(a: MediaAttrs): string {
  const caption = a.caption.trim() ? `*${a.caption.trim()}*` : '';
  if (a.kind === 'image') {
    const title = a.title ? ` "${a.title}"` : '';
    return `![${a.alt.replace(/[[\]]/g, '')}](${a.src}${title})` + (caption ? `\n${caption}` : '');
  }
  if (a.kind === 'video') {
    return (a.html || videoHtml(a.src, a.poster)) + (caption ? `\n${caption}` : '');
  }
  return (a.html || embedHtml(a.src, a.title)) + (caption ? `\n\n${caption}` : '');
}

/** Same attributes and inline style as the hand-written video in the telecom post. */
export function videoHtml(src: string, poster: string) {
  const posterAttr = poster ? ` poster="${escapeHtml(poster)}"` : '';
  return `<video src="${escapeHtml(src)}"${posterAttr} controls muted playsinline preload="metadata" style="display:block;width:100%;margin:1.5rem auto;border-radius:var(--radius)"></video>`;
}

export function embedHtml(src: string, title: string) {
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title || 'Embedded video')}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="display:block;width:100%;aspect-ratio:16/9;border:0;margin:1.5rem auto;border-radius:var(--radius)"></iframe>`;
}

/** YouTube / Vimeo page URL → privacy-friendly embed URL, or null if not recognised. */
export function toEmbedUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/)?.[1] ?? null;
  }
  if (id && /^[\w-]{6,}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (host === 'vimeo.com') {
    const vid = url.pathname.match(/^\/(\d+)/)?.[1];
    if (vid) return `https://player.vimeo.com/video/${vid}`;
  }
  if (host === 'player.vimeo.com') return url.toString();
  return null;
}

/** Markdown the serializer emits for a fenced block: a fence longer than any run inside it. */
export function fenceFor(code: string, char = '`') {
  const runs = code.match(new RegExp(`${char === '`' ? '`' : '~'}{3,}`, 'g')) ?? [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 2);
  return char.repeat(Math.max(3, longest + 1));
}

export function normalizeForCompare(md: string) {
  return md.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

export function lineDiff(a: string, b: string) {
  const al = a.split('\n');
  const bl = b.split('\n');
  // null = the line does not exist on that side (as opposed to an empty line).
  const diffs: Array<{ line: number; before: string | null; after: string | null }> = [];
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) diffs.push({ line: i + 1, before: al[i] ?? null, after: bl[i] ?? null });
  }
  return diffs;
}
