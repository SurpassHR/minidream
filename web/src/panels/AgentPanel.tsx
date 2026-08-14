import { useState } from 'react';

export interface ChatMsg { who: 'user' | 'agent'; text: string }

export function AgentPanel(props: {
  chips: string[];
  onChipsChange: (chips: string[]) => void;
  onSend: (text: string, chips: string[]) => ChatMsg[];
  // 可选流式通道：发送后由外部（真实 agent 桥）逐块推送文本，追加到消息流最后一条 agent 消息
  onStream?: (text: string, chips: string[], push: (chunk: string) => void) => void;
  // 模型切换（内置 agent 下拉）：列表来自 /api/agent/models；空字符串 = pi 默认模型
  models?: Array<{ id: string; provider: string; thinking: boolean }>;
  selectedModel?: string;
  onModelChange?: (model: string) => void;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setMsgs((m) => [...m, ...props.onSend(text, props.chips)]);
    // 流式通道：分块逐步追加到最后一条 agent 消息
    props.onStream?.(text, props.chips, (chunk) => {
      setMsgs((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.who === 'agent') {
          next[next.length - 1] = { ...last, text: last.text + chunk };
        }
        return next;
      });
    });
  };

  return (
    <div className="agent-body">
      {(props.models?.length ?? 0) > 0 && (
        <div className="agent-model-bar">
          <select
            className="agent-model-select"
            aria-label="选择模型"
            value={props.selectedModel ?? ''}
            onChange={(e) => props.onModelChange?.(e.target.value)}
          >
            <option value="">默认模型（pi 配置）</option>
            {props.models!.map((m) => (
              <option key={m.id} value={m.id}>
                {m.provider}/{m.id.split('/').slice(1).join('/')}{m.thinking ? ' · 思考' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="chips">
        {props.chips.map((c) => (
          <span key={c} className="chip">
            {c}
            <span
              className="x" role="button" tabIndex={0}
              onClick={() => props.onChipsChange(props.chips.filter((x) => x !== c))}
            >✕</span>
          </span>
        ))}
      </div>
      <div className="msgs">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.who}`}>
            <div className="who">{m.who === 'user' ? 'YOU' : 'PI · AGENT'}</div>
            <div className="bubble">{m.text}</div>
          </div>
        ))}
      </div>
      <div className="agent-input">
        <input
          placeholder="对画布提问，或 @ 引用节点…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button onClick={send}>发送</button>
      </div>
    </div>
  );
}
