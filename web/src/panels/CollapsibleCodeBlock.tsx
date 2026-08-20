/**
 * 可折叠 + 可复制的代码块组件
 * 用于 ReactMarkdown 的 components.pre 替换
 */
import { isValidElement, useState, type ReactNode } from 'react';
import { Icon } from '../icons';

/* ── 辅助函数 ─────────────────────────────────────── */

/** 递归提取 React 节点中的纯文本 */
function codeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(codeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return codeText(node.props.children);
  return '';
}

/** 复制文本到剪贴板（兼容无 Clipboard API 的环境） */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('复制失败');
}

/* ── 组件 ─────────────────────────────────────────── */

export function CollapsibleCodeBlock(props: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const [collapsed, setCollapsed] = useState(true); // 默认折叠

  const codeChild = Array.isArray(props.children)
    ? props.children.find((child) => isValidElement(child))
    : props.children;
  const codeElement = isValidElement<{ className?: string; children?: ReactNode }>(codeChild)
    ? codeChild
    : null;
  const className = codeElement?.props.className ?? '';
  const language = className.match(/language-([\w-]+)/)?.[1];
  const source = codeText(codeElement?.props.children ?? props.children).replace(/\n$/, '');

  const copy = async () => {
    try {
      await copyText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={`chat-code-block ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="chat-code-toolbar">
        <span className="chat-code-language">{language ?? '代码'}</span>
        <div className="chat-code-actions">
          <button
            type="button"
            className={`chat-code-copy ${wrapped ? 'is-active' : ''}`}
            aria-label={wrapped ? '取消自动换行' : '自动换行'}
            title={wrapped ? '取消自动换行' : '自动换行'}
            data-testid="toggle-wrap-btn"
            onClick={() => setWrapped((w) => !w)}
          >
            <Icon name="wrap-text" />
            {wrapped ? '取消换行' : '自动换行'}
          </button>
          <button
            type="button"
            className="chat-code-copy"
            aria-label={copied ? '已复制' : '复制代码'}
            onClick={() => { void copy(); }}
          >
            {copied ? <><Icon name="check" />已复制</> : <><Icon name="copy" />复制</>}
          </button>
          <button
            type="button"
            className={`chat-code-toggle ${collapsed ? 'is-collapsed' : ''}`}
            aria-label={collapsed ? '展开代码' : '折叠代码'}
            title={collapsed ? '展开代码' : '折叠代码'}
            data-testid="toggle-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
          >
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
      {!collapsed && (
        <pre className={`chat-code-pre ${wrapped ? 'is-wrapped' : ''}`}>{props.children}</pre>
      )}
    </div>
  );
}
