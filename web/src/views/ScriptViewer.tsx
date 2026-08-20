import { useState } from 'react';
import { Icon } from '../icons';

// 只读代码视图：行号 + 自定义高亮（object / <...> / [...]）。
// 零依赖：单行 tokenizer → React span 渲染（文本节点天然转义，无注入风险）。
export type ScriptToken = { text: string; kind: 'plain' | 'object' | 'angle' | 'square' };

// 单行扫描：优先级 <> > [] > 单词（词边界天然成立）。
// 普通单词独立成 plain token（如 myobjects），object 关键字大小写不敏感精确匹配。
// 正则需要捕获组内部分：外层捕获组 (…) 命中后 m[0] 即完整 token。
export function tokenizeScriptLine(line: string): ScriptToken[] {
  const tokens: ScriptToken[] = [];
  const re = /(<[^<>]*>|\[[^\[\]]*\]|[A-Za-z0-9_]+)/i;
  let rest = line;
  for (;;) {
    const m = re.exec(rest);
    if (!m) {
      if (rest) tokens.push({ text: rest, kind: 'plain' });
      return tokens;
    }
    const hit = m[0]!;
    if (m.index > 0) tokens.push({ text: rest.slice(0, m.index), kind: 'plain' });
    const kind: ScriptToken['kind'] = hit.startsWith('<')
      ? 'angle'
      : hit.startsWith('[')
        ? 'square'
        : hit.toLowerCase() === 'object'
          ? 'object'
          : 'plain';
    tokens.push({ text: hit, kind });
    rest = rest.slice(m.index + hit.length);
  }
}

export function ScriptViewer(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(true);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略剪贴板写入失败
    }
  };

  const lines = props.text.replace(/\r\n/g, '\n').split('\n');
  return (
    <div className="script-viewer-container" data-testid="script-viewer-container">
      <div className="script-viewer-toolbar">
        <span className="script-viewer-badge">markdown</span>
        <div className="script-viewer-actions">
          <button
            type="button"
            className={`script-viewer-btn ${wrapped ? 'is-active' : ''}`}
            onClick={() => setWrapped((w) => !w)}
            title={wrapped ? '取消换行' : '自动换行'}
            data-testid="script-toggle-wrap-btn"
          >
            <Icon name="wrap-text" />
            <span>{wrapped ? '取消换行' : '自动换行'}</span>
          </button>
          <button
            type="button"
            className="script-viewer-btn"
            onClick={() => { void handleCopy(); }}
            title="复制代码"
            data-testid="script-copy-btn"
          >
            <Icon name={copied ? 'check' : 'copy'} />
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <div
        className={`script-viewer ${wrapped ? 'is-wrapped' : ''}`}
        data-testid="script-viewer"
      >
        {lines.map((ln, i) => (
          <div key={i} className="script-line" data-testid={`script-line-${i + 1}`}>
            <span className="script-no">{i + 1}</span>
            <span className="script-code">
              {tokenizeScriptLine(ln).map((t, j) =>
                t.kind === 'plain' ? t.text : (
                  <span key={j} className={`tok-${t.kind}`}>{t.text}</span>
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

