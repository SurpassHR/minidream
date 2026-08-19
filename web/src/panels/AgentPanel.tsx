import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';
import { agentChat } from '../api/agent';
import { Icon } from '../icons';
import { ConfirmDialog } from './ConfirmDialog';
import { TextInputDialog } from './TextInputDialog';
import type { SessionMeta } from '../types';

export interface ChatMsg { who: 'user' | 'agent'; text: string }

// 会话更新时间 → 短日期：当天显示 HH:mm，否则 MM-DD
function fmtSessionDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function AgentPanel(props: {
  chips: string[];
  onChipsChange: (chips: string[]) => void;
  onSend: (text: string, chips: string[], sessionId?: string | null) => ChatMsg[];
  // 可选流式通道：发送后由外部（真实 agent 桥）逐块推送文本，追加到消息流最后一条 agent 消息；
  // 未提供时面板自行请求 agentChat（测试/独立挂载仍可流式渲染）。
  // 返回 Promise 时面板进入 streaming 锁（期间禁止切换/新建/删除会话，防旧会话流式污染新视图）；
  // 同步调用（无 Promise）不锁，保持旧行为。
  onStream?: (text: string, chips: string[], push: (chunk: string) => void, sessionId?: string | null) => Promise<void> | void;
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
  // 多会话：会话列表 + 当前会话 id + 会话条下拉开关
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  // 流式锁：onStream 返回 Promise（真实 agent 桥）或面板自行 agentChat 时置 true；
  // 期间禁止会话切换/新建/删除——否则旧会话的流式 push 会污染新选中的视图
  const [streaming, setStreaming] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [sessionDialogBusy, setSessionDialogBusy] = useState(false);
  // 用户已发送标记：历史加载是异步的，若加载完成前用户已发消息，不覆盖进行中的对话
  const dirtyRef = useRef(false);

  // 发送完成后重新拉取会话列表：后端在首条用户消息后自动命名会话并 bump updatedAt，
  // 不刷新则当前会话一直显示「新会话」直到页面重载
  const refreshSessions = () => {
    void client.listAgentSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  };

  // 挂载与 historyKey 变化（切换项目）时：加载会话列表 → 无会话自动新建 → 加载当前会话消息；
  // 失败静默（保持空对话；发送时若 activeId 为 null 后端回退到当前会话兜底）
  useEffect(() => {
    dirtyRef.current = false;
    setMsgs([]);
    setPickOpen(false);
    let disposed = false;
    const load = async () => {
      try {
        let r = await client.listAgentSessions();
        if (!r.activeId) r = await client.createAgentSession();
        if (disposed) return;
        setSessions(r.sessions);
        setActiveId(r.activeId);
        if (r.activeId) {
          const history = await client.listChatHistory(r.activeId);
          if (!disposed && !dirtyRef.current) {
            setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
          }
        }
      } catch { /* 加载失败静默：activeId 为 null 时发送仍可用，后端回退到当前会话兜底 */ }
    };
    void load();
    return () => { disposed = true; };
  }, [props.historyKey]);

  const currentTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';

  const newSession = async () => {
    if (streaming) return; // 流式中禁止：切换会打乱正在流式的会话上下文
    const r = await client.createAgentSession().catch(() => null);
    if (!r) return;
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setPickOpen(false);
    dirtyRef.current = false;
    setMsgs([]);
  };

  const selectSession = (id: string) => {
    if (streaming) return; // 流式中禁止：旧会话流式会污染新选中的视图
    if (id === activeId) return;
    setActiveId(id);
    dirtyRef.current = false;
    setMsgs([]);
    void client.listChatHistory(id).then((history) => {
      setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
    }).catch(() => {});
  };

  const renameSession = (s: SessionMeta) => setRenameTarget(s);
  const submitRenameSession = async (title: string) => {
    const target = renameTarget;
    if (!target) return;
    setSessionDialogBusy(true);
    const r = await client.renameAgentSession(target.id, title).catch(() => null);
    if (r) {
      setSessions(r.sessions);
      setRenameTarget(null);
    }
    setSessionDialogBusy(false);
  };

  const deleteSession = (s: SessionMeta) => {
    if (streaming) return; // 流式中禁止：在途流式 POST 会落盘到刚删除的会话
    setDeleteTarget(s);
  };
  const confirmDeleteSession = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    let r = await client.deleteAgentSession(target.id).catch(() => null);
    if (!r) return;
    if (!r.activeId) {
      // 删光会话：自动新建一个空会话，避免下次发送聊进 UI 看不见的会话（后端自动创建，UI 无从得知）
      const created = await client.createAgentSession().catch(() => null);
      r = created ?? r;
    }
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setPickOpen(false);
    dirtyRef.current = false;
    setMsgs([]);
    if (r.activeId) {
      void client.listChatHistory(r.activeId).then((history) => {
        setMsgs(history.map((h) => ({ who: h.who, text: h.text })));
      }).catch(() => {});
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text) return;
    dirtyRef.current = true;
    setInput('');
    setMsgs((m) => [...m, ...props.onSend(text, props.chips, activeId)]);
    // 流式通道：分块逐步追加到最后一条 agent 消息
    const push = (chunk: string) => {
      setMsgs((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.who === 'agent') {
          next[next.length - 1] = { ...last, text: last.text + chunk };
        } else {
          // 无 agent 占位消息时（外部未提供占位）：新建一条 agent 消息承载流
          next.push({ who: 'agent', text: chunk });
        }
        return next;
      });
    };
    if (props.onStream) {
      const res = props.onStream(text, props.chips, push, activeId) as Promise<void> | void;
      if (res && typeof res.then === 'function') {
        // Promise 流式通道（真实 agent 桥）：进入流式锁，完成后解锁并刷新会话列表
        setStreaming(true);
        void res.then(
          () => { setStreaming(false); refreshSessions(); },
          () => { setStreaming(false); refreshSessions(); },
        );
      }
      // 同步 onStream（无 Promise，如测试 mock）：不锁，保持旧行为
    } else {
      // 无外部流式通道：面板自行请求 agentChat（chips 名称保留，内容由外部注入）
      setStreaming(true);
      void agentChat(text, props.chips.map((c) => ({ name: c, content: '' })), push, undefined, undefined, activeId)
        .catch(() => push('\n（agent 连接失败）'))
        .finally(() => { setStreaming(false); refreshSessions(); });
    }
  };

  return (
    <div className="agent-body">
      {props.activity && (
        <div className="agent-activity" title={`${props.activity.text} · ${new Date(props.activity.at).toLocaleTimeString()}`}>
          <Icon name="gear" /> {props.activity.text}
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
            ><Icon name="x" /></span>
          </span>
        ))}
      </div>
      {/* 会话条（多会话下拉）：新建 / 点选 / 重命名 / 删除 */}
      <div className="agent-sessions">
        <button
          type="button" className="btn-ghost agent-session-new" data-testid="agent-session-new"
          title="新建会话" onClick={() => { void newSession(); }}
        >＋ 新建</button>
        <div className="agent-session-pick">
          <button
            type="button" className="agent-session-current" data-testid="agent-session-current"
            onClick={() => setPickOpen(true)}
          >会话：{currentTitle}</button>
          {pickOpen && (
            <>
              <div className="agent-session-menu" data-testid="agent-session-menu">
                {sessions.map((s) => (
                  <div key={s.id} className={`agent-session-item${s.id === activeId ? ' active' : ''}`}>
                    <button type="button" className="agent-session-select" onClick={() => { selectSession(s.id); setPickOpen(false); }}>
                      <span className="agent-session-title">{s.title}</span>
                      <span className="agent-session-date">{fmtSessionDate(s.updatedAt)}</span>
                    </button>
                    <button type="button" className="agent-session-act" data-testid={`agent-session-rename-${s.id}`}
                      title="重命名" onClick={() => { void renameSession(s); }}><Icon name="pencil" /></button>
                    <button type="button" className="agent-session-act" data-testid={`agent-session-del-${s.id}`}
                      title="删除" onClick={() => { void deleteSession(s); }}><Icon name="trash" /></button>
                  </div>
                ))}
                {sessions.length === 0 && <div className="agent-session-empty">暂无会话</div>}
              </div>
              <div className="agent-session-mask" onClick={() => setPickOpen(false)} />
            </>
          )}
        </div>
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
      <TextInputDialog
        open={renameTarget !== null}
        title="重命名会话"
        body="为这段画布讨论保留一个容易识别的标题。"
        defaultValue={renameTarget?.title ?? ''}
        placeholder="例如：镜头节奏分析"
        confirmLabel="保存名称"
        busy={sessionDialogBusy}
        onConfirm={(value) => { void submitRenameSession(value); }}
        onCancel={() => { if (!sessionDialogBusy) setRenameTarget(null); }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        body={`删除「${deleteTarget?.title ?? ''}」？其中的消息也会一并删除。`}
        confirmLabel="确认删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { void confirmDeleteSession(); }}
      />
    </div>
  );
}
