import { Node, type AnyExtension } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlock from '@tiptap/extension-code-block';
import Image from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import { fenceFor, serializeMedia, type MediaAttrs } from './markdown';

/* prosemirror-markdown's serializer state, as much of it as these nodes use. */
interface MdState {
  out: string;
  inTable?: boolean;
  write(s?: string): void;
  text(s: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: unknown): void;
  renderInline(node: unknown): void;
}

/** Writes a multi-line string so each line gets the surrounding list/quote prefix. */
function writeLines(state: MdState, text: string) {
  text.split('\n').forEach((line, i) => {
    if (i) state.out += '\n';
    state.write(line);
  });
}

/* ------------------------------------------------------------------ Media */

function MediaView({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const a = node.attrs as MediaAttrs;
  return (
    <NodeViewWrapper className={`media-node ${selected ? 'is-selected' : ''}`} data-drag-handle>
      <div className="media-node__frame" contentEditable={false}>
        {a.kind === 'image' && <img src={a.src} alt={a.alt} />}
        {a.kind === 'video' && <video src={a.src} poster={a.poster || undefined} controls muted playsInline preload="metadata" />}
        {a.kind === 'embed' && <iframe src={a.src} title={a.title || 'Embed'} allowFullScreen />}
        <button type="button" className="media-node__remove" onClick={() => deleteNode()} title="移除">
          ×
        </button>
      </div>
      <div className="media-node__fields" contentEditable={false}>
        {a.kind === 'image' && (
          <label>
            <span>替代文字 alt</span>
            <input
              value={a.alt}
              placeholder="描述圖片內容，給螢幕閱讀器與 SEO 使用"
              onChange={(e) => updateAttributes({ alt: e.target.value })}
            />
          </label>
        )}
        <label>
          <span>圖說</span>
          <input
            value={a.caption}
            placeholder="選填，顯示在下方的斜體說明（可用 Markdown 連結）"
            onChange={(e) => updateAttributes({ caption: e.target.value })}
          />
        </label>
        {a.kind !== 'image' && a.html && (
          <p className="media-node__hint">
            {a.kind === 'video' ? '影片' : '嵌入'}標籤會原樣保留：{a.src}
          </p>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const Media = Node.create({
  name: 'media',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const keys: Array<keyof MediaAttrs> = ['kind', 'src', 'alt', 'title', 'poster', 'caption', 'html'];
    return Object.fromEntries(keys.map((k) => [k, { default: k === 'kind' ? 'image' : '' }]));
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-media]',
        getAttrs: (el) => {
          try {
            return JSON.parse((el as HTMLElement).getAttribute('data-media') ?? '{}');
          } catch {
            return false;
          }
        },
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-media': JSON.stringify(node.attrs) }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MediaView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: { attrs: MediaAttrs }) {
          writeLines(state, serializeMedia(node.attrs));
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/* ---------------------------------------------------------------- Raw HTML */

function RawHtmlView({ node, updateAttributes, deleteNode }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className="raw-html-node">
      <div className="raw-html-node__head" contentEditable={false}>
        <span>HTML 區塊（原樣輸出）</span>
        <button type="button" onClick={() => deleteNode()}>
          移除
        </button>
      </div>
      <textarea
        value={node.attrs.html}
        spellCheck={false}
        rows={Math.min(12, String(node.attrs.html).split('\n').length + 1)}
        onChange={(e) => updateAttributes({ html: e.target.value })}
      />
    </NodeViewWrapper>
  );
}

export const RawHtml = Node.create({
  name: 'rawHtml',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return { html: { default: '' } };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-raw-html]',
        getAttrs: (el) => ({ html: (el as HTMLElement).getAttribute('data-raw-html') ?? '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-raw-html': node.attrs.html }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawHtmlView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: { attrs: { html: string } }) {
          writeLines(state, node.attrs.html);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/* -------------------------------------------- Serializer overrides (fidelity) */

/** The default writes ``` regardless of content, which breaks a block that itself contains ```. */
const FencedCodeBlock = CodeBlock.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: { textContent: string; attrs: { language?: string } }) {
          const fence = fenceFor(node.textContent);
          state.write(fence + (node.attrs.language || '') + '\n');
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
}).configure({ languageClassPrefix: 'language-', defaultLanguage: null });

/** Same output as the default, but with the |---|---| delimiter row the existing posts use. */
const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MdState, node: any) {
          const rows: any[] = [];
          node.forEach((row: any) => rows.push(row));
          const simple =
            rows.length > 0 &&
            rows.every((row, i) => {
              let ok = true;
              row.forEach((cell: any) => {
                const isHeader = cell.type.name === 'tableHeader';
                if (isHeader !== (i === 0) || cell.childCount > 1 || cell.attrs.colspan > 1 || cell.attrs.rowspan > 1) ok = false;
              });
              return ok;
            });
          if (!simple) {
            // Rare: merged cells or multi-paragraph cells. Fall back to HTML so nothing is lost.
            writeLines(state, tableToHtml(node));
            state.closeBlock(node);
            return;
          }
          state.inTable = true;
          rows.forEach((row, i) => {
            state.write('| ');
            let j = 0;
            row.forEach((cell: any) => {
              if (j++) state.write(' | ');
              if (cell.firstChild?.textContent.trim()) state.renderInline(cell.firstChild);
            });
            state.write(' |');
            state.ensureNewLine();
            if (i === 0) {
              state.write('|' + Array.from({ length: row.childCount }, () => '---').join('|') + '|');
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {},
      },
    };
  },
});

function tableToHtml(node: any): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = '<table>\n';
  node.forEach((row: any) => {
    html += '<tr>';
    row.forEach((cell: any) => {
      const tag = cell.type.name === 'tableHeader' ? 'th' : 'td';
      const span =
        (cell.attrs.colspan > 1 ? ` colspan="${cell.attrs.colspan}"` : '') +
        (cell.attrs.rowspan > 1 ? ` rowspan="${cell.attrs.rowspan}"` : '');
      html += `<${tag}${span}>${esc(cell.textContent)}</${tag}>`;
    });
    html += '</tr>\n';
  });
  return html + '</table>';
}

/* ------------------------------------------------------------- Extension set */

export function buildExtensions(placeholder = '從這裡開始寫…'): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false, // Markdown has no underline; it would be saved as raw HTML
      heading: { levels: [2, 3, 4] }, // the post title is the page's h1
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: null, target: null },
      },
    }),
    FencedCodeBlock,
    Image.configure({ inline: true }),
    MarkdownTable.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Media,
    RawHtml,
    Placeholder.configure({ placeholder }),
    Markdown.configure({
      html: true,
      tightLists: true,
      bulletListMarker: '-',
      linkify: false,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: false,
    }),
  ];
}
