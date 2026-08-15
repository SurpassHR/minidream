import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';

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
  // 思考强度（pi --thinking）：off/minimal/low/medium/high/xhigh/max；空字符串 = pi 默认
  thinkingLevel?: string;
  onThinkingLevelChange?: (level: string) => void;
  // 项目标识：变化时（挂载/切换项目）从后端加载该项目持久化的聊天历史
  historyKey?: string;
  // agent 活动回传（MCP 工具调用 → WS 广播）：显示在模型栏下方
  activity?: { text: string; at: number } | null;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  // 用户已发送标记：历史加载是异步的，若加载完成前用户已发消息，不覆盖进行中的对话
  const dirtyRef = useRef(false);

  // 挂载与 historyKey 变化（切换项目）时加载后端持久化的聊天历史；
  // 切换项目先清空（避免残留上一项目消息）再加载；失败静默（保持空对话）
  useEffect(() => {
    dirtyRef.current = false;
    setMsgs([]);
    let disposed = false;
    void client.listChatHistory().then((history) => {
      if (!disposed && !dirtyRef.current) {
        setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
      }
    }).catch(() => {});
    return () => { disposed = true; };
  }, [props.historyKey]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    dirtyRef.current = true;
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
      {props.activity && (
        <div className="agent-activity" title={`${props.activity.text} · ${new Date(props.activity.at).toLocaleTimeString()}`}>
          ⚙ {props.activity.text}
        </div>
      )}
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
          <select
            className="agent-model-select"
            aria-label="思考强度"
            title="pi --thinking：控制模型推理深度（越高思考越充分，响应越慢）"
            value={props.thinkingLevel ?? ''}
            onChange={(e) => props.onThinkingLevelChange?.(e.target.value)}
          >
            <option value="">思考：默认</option>
            <option value="off">思考：关闭</option>
            <option value="minimal">思考：最低</option>
            <option value="low">思考：低</option>
            <option value="medium">思考：中</option>
            <option value="high">思考：高</option>
            <option value="xhigh">思考：极高</option>
            <option value="max">思考：最大</option>
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
            <div className="bubble">
              {/* agent 回复用 Markdown 渲染（流式追加时容忍未闭合片段）；用户消息保持纯文本 */}
              {m.who === 'agent' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
              ) : m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="agent-input">
        <textarea
          placeholder="对画布提问，或 @ 引用节点…（Enter 发送 · Shift+Enter 换行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送；Shift+Enter 保留 textarea 默认换行行为
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button onClick={send}>发送</button>
      </div>
    </div>
  );
}
