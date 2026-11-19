import { useEditorState, type Editor } from '@tiptap/react';
import type { ReactNode } from 'react';

function Btn({ on, active, disabled, title, children }: { on: () => void; active?: boolean; disabled?: boolean; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`tb-btn ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      aria-label={title}
      // Keep the editor's selection: a mousedown on a button would otherwise blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
    >
      {children}
    </button>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

export function Toolbar({ editor, onLink, onImage, onVideo }: { editor: Editor; onLink: () => void; onImage: () => void; onVideo: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : e.isActive('heading', { level: 4 }) ? 'h4' : 'p',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      language: (e.getAttributes('codeBlock').language as string | null) ?? '',
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();

  return (
    <div className="toolbar-wrap">
      <div className="toolbar" role="toolbar" aria-label="格式">
        <select
          className="tb-select"
          value={s.block}
          aria-label="段落樣式"
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'p') c().setParagraph().run();
            else c().setHeading({ level: Number(v.slice(1)) as 2 | 3 | 4 }).run();
          }}
        >
          <option value="p">內文</option>
          <option value="h2">標題 H2</option>
          <option value="h3">標題 H3</option>
          <option value="h4">標題 H4</option>
        </select>

        <span className="tb-sep" />
        <Btn title={`粗體 (${mod}B)`} active={s.bold} on={() => c().toggleBold().run()}>
          <b>B</b>
        </Btn>
        <Btn title={`斜體 (${mod}I)`} active={s.italic} on={() => c().toggleItalic().run()}>
          <i>I</i>
        </Btn>
        <Btn title="刪除線" active={s.strike} on={() => c().toggleStrike().run()}>
          <s>S</s>
        </Btn>
        <Btn title={`行內程式碼 (${mod}E)`} active={s.code} on={() => c().toggleCode().run()}>
          <code>{'<>'}</code>
        </Btn>
        <Btn title={`連結 (${mod}K)`} active={s.link} on={onLink}>
          🔗
        </Btn>

        <span className="tb-sep" />
        <Btn title="項目清單" active={s.bullet} on={() => c().toggleBulletList().run()}>
          • 清單
        </Btn>
        <Btn title="編號清單" active={s.ordered} on={() => c().toggleOrderedList().run()}>
          1. 清單
        </Btn>
        <Btn title="引言" active={s.quote} on={() => c().toggleBlockquote().run()}>
          ❝
        </Btn>
        <Btn title="程式碼區塊" active={s.codeBlock} on={() => c().toggleCodeBlock().run()}>
          {'{ }'}
        </Btn>
        <Btn title="分隔線" on={() => c().setHorizontalRule().run()}>
          ―
        </Btn>

        <span className="tb-sep" />
        <Btn title="插入圖片" on={onImage}>
          圖片
        </Btn>
        <Btn title="插入影片" on={onVideo}>
          影片
        </Btn>
        <Btn title="插入表格" on={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          表格
        </Btn>

        <span className="tb-sep" />
        <Btn title={`復原 (${mod}Z)`} disabled={!s.canUndo} on={() => c().undo().run()}>
          ↶
        </Btn>
        <Btn title={`重做 (${mod}⇧Z)`} disabled={!s.canRedo} on={() => c().redo().run()}>
          ↷
        </Btn>
      </div>

      {s.codeBlock && (
        <div className="toolbar toolbar--context">
          <label>
            程式語言
            <input
              list="languages"
              value={s.language}
              placeholder="例如 ts、bash、markdown"
              onChange={(e) => editor.chain().updateAttributes('codeBlock', { language: e.target.value.trim() || null }).run()}
            />
          </label>
          <datalist id="languages">
            {['bash', 'ts', 'tsx', 'js', 'json', 'python', 'ruby', 'go', 'sql', 'html', 'css', 'yaml', 'markdown', 'diff'].map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
      )}

      {s.table && (
        <div className="toolbar toolbar--context">
          <span>表格</span>
          <Btn title="上方加一列" on={() => c().addRowBefore().run()}>↑ 加列</Btn>
          <Btn title="下方加一列" on={() => c().addRowAfter().run()}>↓ 加列</Btn>
          <Btn title="左側加一欄" on={() => c().addColumnBefore().run()}>← 加欄</Btn>
          <Btn title="右側加一欄" on={() => c().addColumnAfter().run()}>→ 加欄</Btn>
          <Btn title="刪除這一列" on={() => c().deleteRow().run()}>刪列</Btn>
          <Btn title="刪除這一欄" on={() => c().deleteColumn().run()}>刪欄</Btn>
          <Btn title="刪除整個表格" on={() => c().deleteTable().run()}>刪除表格</Btn>
        </div>
      )}
    </div>
  );
}
