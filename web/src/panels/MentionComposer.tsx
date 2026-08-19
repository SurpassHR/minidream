import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AssetMentionMenu, type MentionAsset } from './AssetMentionPicker';
import { Icon } from '../icons';

function mentionParts(value: string, assets: MentionAsset[]): Array<{ text: string; asset?: MentionAsset }> {
  const names = [...assets].sort((a, b) => b.name.length - a.name.length);
  const parts: Array<{ text: string; asset?: MentionAsset }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    let match: { start: number; end: number; asset: MentionAsset } | null = null;
    for (const asset of names) {
      const start = value.indexOf(`@${asset.name}`, cursor);
      if (start < 0) continue;
      const end = start + asset.name.length + 1;
      if (!match || start < match.start || (start === match.start && end > match.end)) {
        match = { start, end, asset };
      }
    }
    if (!match) {
      parts.push({ text: value.slice(cursor) });
      break;
    }
    if (match.start > cursor) parts.push({ text: value.slice(cursor, match.start) });
    parts.push({ text: value.slice(match.start, match.end), asset: match.asset });
    cursor = match.end;
  }
  if (value.length === 0) parts.push({ text: '' });
  return parts;
}

function editorText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return '\n';
  return Array.from(node.childNodes).map(editorText).join('');
}

function editorTextLength(node: Node): number {
  return editorText(node).length;
}

function readEditorValue(target: HTMLElement): string {
  const syntheticValue = (target as HTMLElement & { value?: unknown }).value;
  if (target.querySelector('br')) return editorText(target);
  return typeof syntheticValue === 'string' ? syntheticValue : editorText(target);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

function mentionMarkup(value: string, assets: MentionAsset[], testIdPrefix: 'chat' | 'agent'): string {
  return mentionParts(value, assets).map((part) => {
    if (!part.asset) return escapeHtml(part.text);
    const asset = part.asset;
    return `<span class="asset-mention-token" data-testid="${testIdPrefix}-asset-token-${escapeHtml(asset.id)}" data-asset-token="true" data-asset-id="${escapeHtml(asset.id)}" contenteditable="false" role="button" tabindex="-1" title="点击查看素材详情">${escapeHtml(part.text)}</span>`;
  }).join('');
}

interface EditorSelection {
  start: number;
  end: number;
}

function textOffset(root: HTMLElement, target: Node, offset: number): number {
  let total = 0;
  let found = false;
  const visit = (node: Node) => {
    if (found) return;
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        total += Math.min(offset, node.textContent?.length ?? 0);
      } else {
        for (let i = 0; i < Math.min(offset, node.childNodes.length); i++) {
          total += editorTextLength(node.childNodes[i]!);
        }
      }
      found = true;
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
    if (!found && node.nodeType === Node.TEXT_NODE) total += node.textContent?.length ?? 0;
    if (!found && node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') total += 1;
  };
  visit(root);
  return total;
}

function captureEditorSelection(editor: HTMLElement): EditorSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return null;
  const anchor = textOffset(editor, selection.anchorNode!, selection.anchorOffset);
  const focus = textOffset(editor, selection.focusNode!, selection.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

function restoreEditorSelection(editor: HTMLElement, saved: EditorSelection): void {
  const length = editorTextLength(editor);
  const start = Math.max(0, Math.min(saved.start, length));
  const end = Math.max(start, Math.min(saved.end, length));
  const locate = (target: number): { node: Node; offset: number } => {
    let remaining = target;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      last = node;
      const nodeLength = node.textContent?.length ?? 0;
      if (remaining <= nodeLength) return { node, offset: remaining };
      remaining -= nodeLength;
    }
    return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: editor, offset: 0 };
  };
  const from = locate(start);
  const to = locate(end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function MentionComposer(props: {
  value: string;
  assets: MentionAsset[];
  placeholder: string;
  testId: string;
  className?: string;
  disabled?: boolean;
  mentionOpen: boolean;
  mentionItems: MentionAsset[];
  mentionActiveIndex: number;
  mentionTestIdPrefix: 'chat' | 'agent';
  onChange: (value: string) => void;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectMention: (asset: MentionAsset) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(props.onChange);
  const syntheticValueRef = useRef<string | null>(null);
  const previousValue = useRef(props.value);
  const composingRef = useRef(false);
  const skipNextInputRef = useRef(false);
  const pendingSelectionRef = useRef<EditorSelection | null>(null);
  const [detailAsset, setDetailAsset] = useState<MentionAsset | null>(null);
  onChangeRef.current = props.onChange;

  // contenteditable 没有原生 value 属性，但测试工具和现有调用方仍按输入控件
  // 通过 fireEvent.change({ target: { value } }) 驱动它。提供虚拟访问器，
  // 只保存测试事件的值，不直接改写 DOM，避免破坏 React 管理的 token 节点。
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setAttribute('placeholder', props.placeholder);
    if (!Object.prototype.hasOwnProperty.call(editor, 'value')) {
      Object.defineProperty(editor, 'value', {
        configurable: true,
        get: () => syntheticValueRef.current ?? editor.textContent ?? '',
        set: (next: unknown) => { syntheticValueRef.current = String(next ?? ''); },
      });
    }
    const handleNativeChange = () => {
      onChangeRef.current(readEditorValue(editor));
    };
    editor.addEventListener('change', handleNativeChange);
    return () => editor.removeEventListener('change', handleNativeChange);
  }, [props.placeholder]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && document.activeElement === editor && previousValue.current !== props.value) {
      const saved = pendingSelectionRef.current;
      if (saved) {
        restoreEditorSelection(editor, saved);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    pendingSelectionRef.current = null;
    syntheticValueRef.current = null;
    previousValue.current = props.value;
  }, [props.value]);

  return (
    <div className={`mention-composer${props.className ? ` ${props.className}` : ''}`}>
      <div
        ref={editorRef}
        className="mention-editor"
        data-testid={props.testId}
        data-placeholder={props.placeholder}
        contentEditable={!props.disabled}
        aria-disabled={props.disabled || undefined}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onCompositionStart={() => {
          composingRef.current = true;
          skipNextInputRef.current = false;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          skipNextInputRef.current = true;
          if (props.disabled) return;
          pendingSelectionRef.current = captureEditorSelection(event.currentTarget);
          syntheticValueRef.current = null;
          props.onChange(readEditorValue(event.currentTarget));
        }}
        onInput={(event) => {
          if (props.disabled) return;
          if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
          if (skipNextInputRef.current) {
            skipNextInputRef.current = false;
            return;
          }
          pendingSelectionRef.current = captureEditorSelection(event.currentTarget);
          syntheticValueRef.current = null;
          props.onChange(readEditorValue(event.currentTarget));
        }}
        onPaste={props.disabled ? undefined : props.onPaste}
        onKeyDown={props.disabled ? undefined : props.onKeyDown}
        onClick={(event) => {
          const token = (event.target as HTMLElement).closest<HTMLElement>('[data-asset-token]');
          if (!token) return;
          event.preventDefault();
          const asset = props.assets.find((item) => item.id === token.dataset.assetId);
          if (asset) setDetailAsset(asset);
        }}
        dangerouslySetInnerHTML={{ __html: mentionMarkup(props.value, props.assets, props.mentionTestIdPrefix) }}
      />
      <AssetMentionMenu
        items={props.mentionOpen ? props.mentionItems : []}
        activeIndex={props.mentionActiveIndex}
        onSelect={props.onSelectMention}
        testIdPrefix={props.mentionTestIdPrefix}
      />
      <AssetDetailModal asset={detailAsset} onClose={() => setDetailAsset(null)} />
    </div>
  );
}

export function AssetDetailModal(props: { asset: MentionAsset | null; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.asset || props.asset.kind !== 'txt') {
      setContent(null);
      setError('');
      return;
    }
    let disposed = false;
    setContent(null);
    setError('');
    void fetch(`/api/assets/${encodeURIComponent(props.asset.id)}/content`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({})) as { content?: string; message?: string };
        if (!res.ok) throw new Error(body.message ?? '读取文本素材失败');
        if (!disposed) setContent(body.content ?? '');
      })
      .catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : '读取文本素材失败'); });
    return () => { disposed = true; };
  }, [props.asset]);

  if (!props.asset) return null;
  return (
    <div className="dialog-mask asset-detail-mask" role="dialog" aria-label={`素材详情：${props.asset.name}`} onClick={props.onClose}>
      <div className="dialog dialog-wide asset-detail-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-title"><Icon name={props.asset.kind === 'txt' ? 'file-text' : props.asset.kind === 'img' ? 'image' : 'video'} /> 素材详情</div>
        <div className="asset-preview-name">{props.asset.name}</div>
        {props.asset.kind === 'img' && (
          <>
            <img className="asset-preview-image" src={`/api/assets/${encodeURIComponent(props.asset.id)}/file`} alt={props.asset.name} />
            {props.asset.caption && <div className="asset-preview-caption">{props.asset.caption}</div>}
          </>
        )}
        {props.asset.kind === 'vid' && (
          <video className="asset-preview-video" src={`/api/assets/${encodeURIComponent(props.asset.id)}/file`} controls muted playsInline preload="metadata" />
        )}
        {props.asset.kind === 'txt' && (error ? <div className="ne-error">读取失败：{error}</div> : content === null ? <div className="asset-preview-loading">读取中…</div> : <pre className="asset-preview-text">{content}</pre>)}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
