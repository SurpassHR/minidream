import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { client } from '../api/client';
import { Icon } from '../icons';
import { resolveBoardPrompt, resolvePrompt, withArmorBreak } from './roles';
import { AiButton, EmptyState, ErrorBanner } from './role-ui';
import type { SessionMeta, StoryBoard } from '../types';

export interface ChatMsg { who: 'user' | 'agent'; text: string }

// 六步答案约定格式解析：按行匹配 `stepId: 内容`，非法行忽略（导出便于测试）
export function parseStoryAnswers(text: string): Record<string, string> {
  const STEP_IDS = ['theme', 'protagonist', 'support', 'antagonist', 'scenes', 'ending'];
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(theme|protagonist|support|antagonist|scenes|ending):\s*(.+)$/.exec(line.trim());
    if (m && STEP_IDS.includes(m[1]!)) {
      out[m[1]!] = m[2]!.trim();
    }
  }
  return out;
}

// 会话更新时间 → 短日期：当天显示 HH:mm，否则 MM-DD（同 AGENT 面板）
function fmtSessionDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function StoryChat(props: {
  projectName: string;
  // 总结成稿成功回调：携带解析出的答案（父组件先 saveStory 再 completeStory 入库）
  onSummarized: (answers: Record<string, string>) => void;
  // 提示词库（角色系统提示词；未配置键回退内置默认）
  prompts?: Record<string, string>;
  // 破甲预设：开启且文本非空时插入到所有系统提示词之前
  armorBreak?: string;
  armorBreakEnabled?: boolean;
  // 默认模型与思考强度（来自全局设置；透传到 /api/story/chat body，缺省走 pi 默认）
  agentModel?: string;
  thinkingLevel?: string;
  // 剧本项目（board）：boardId 归组会话 + 项目级系统提示词（board → 全局 → 内置）
  board?: StoryBoard | null;
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  // 多会话：会话列表 + 当前会话 id（左侧列表面板）
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); // 发送/总结共用 busy（防并发）
  const [action, setAction] = useState<'summarize' | null>(null);
  // 当前剧本项目 id（归组会话 + 后端解析项目级提示词/RAG）
  const boardId = props.board?.id ?? null;

  // 发送/总结完成后重新拉取会话列表：后端在首条用户消息后自动命名会话并 bump updatedAt，
  // 不刷新则当前会话一直显示「新会话」直到页面重载
  const refreshSessions = () => {
    void client.listStorySessions(boardId).then((r) => setSessions(r.sessions)).catch(() => {});
  };

  // 项目/剧本项目切换或挂载时：加载会话列表 → 无会话自动新建 → 加载当前会话历史
  useEffect(() => {
    setMsgs([]);
    setLoaded(false);
    setError(''); // 切项目清残留错误（新项目可能有独立状态）
    let disposed = false;
    const load = async () => {
      try {
        let r = await client.listStorySessions(boardId);
        if (!r.activeId) r = await client.createStorySession(boardId);
        if (disposed) return;
        setSessions(r.sessions);
        setActiveId(r.activeId);
        if (r.activeId) {
          const history = await client.getStoryChatHistory(r.activeId);
          if (!disposed) {
            setMsgs(history.map((m) => ({ who: m.who, text: m.text })));
          }
        }
        if (!disposed) setLoaded(true);
      } catch {
        if (!disposed) { setError('加载对话历史失败'); setLoaded(true); }
      }
    };
    void load();
    return () => { disposed = true; };
    // boardId 变化 = 切换剧本项目：整套提示词 + RAG + 会话列表一起切换
  }, [props.projectName, boardId]);

  // 追加流式 chunk 到最后一条 agent 消息
  const appendStream = (chunk: string) => {
    setMsgs((m) => {
      const next = [...m];
      const last = next[next.length - 1];
      if (last && last.who === 'agent') {
        next[next.length - 1] = { ...last, text: last.text + chunk };
      } else {
        next.push({ who: 'agent', text: chunk });
      }
      return next;
    });
  };

  // 新建会话：流式中禁止（busy 期间切换会打乱正在落盘/流式的会话上下文）
  const newSession = async () => {
    if (busy) return;
    const r = await client.createStorySession(boardId).catch(() => null);
    if (!r) return;
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setError(''); // 新空会话清残留错误（旧会话可能报过加载/格式错误）
    setMsgs([]);
  };

  // 点选历史会话：流式中禁止
  const selectSession = (id: string) => {
    if (busy) return;
    if (id === activeId) return;
    setActiveId(id);
    setMsgs([]);
    void client.getStoryChatHistory(id).then((history) => {
      setMsgs(history.map((m) => ({ who: m.who, text: m.text })));
    }).catch(() => {});
  };

  const renameSession = async (s: SessionMeta) => {
    const title = window.prompt('会话标题', s.title);
    if (!title || title.trim() === '' || title === s.title) return;
    const r = await client.renameStorySession(s.id, title.trim(), boardId).catch(() => null);
    if (r) setSessions(r.sessions);
  };

  // 删除会话：流式中禁止（否则在途流式 POST 会落盘到刚删除的会话，幽灵 AI 文本进入空视图）
  const deleteSession = async (s: SessionMeta) => {
    if (busy) return;
    if (!window.confirm(`删除会话「${s.title}」？其消息将一并删除。`)) return;
    let r = await client.deleteStorySession(s.id, boardId).catch(() => null);
    if (!r) return;
    if (!r.activeId) {
      // 删光会话：自动新建一个空会话，避免下次发送聊进 UI 看不见的会话（后端自动创建，UI 无从得知）
      const created = await client.createStorySession(boardId).catch(() => null);
      r = created ?? r;
    }
    setSessions(r.sessions);
    setActiveId(r.activeId);
    setMsgs([]);
    if (r.activeId) {
      void client.getStoryChatHistory(r.activeId).then((history) => {
        setMsgs(history.map((m) => ({ who: m.who, text: m.text })));
      }).catch(() => {});
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setError('');
    setMsgs((m) => [...m, { who: 'user', text }]);
    // 剧本项目存在时：systemPrompt 交给后端从 board 解析（board.storyTeller → 全局 → 内置）
    const sysPrompt = boardId ? undefined : resolvePrompt(props.prompts, 'storyTeller');
    client.storyChat(text, appendStream, props.agentModel || undefined, props.thinkingLevel || undefined, undefined, activeId, sysPrompt, boardId)
      .catch(() => appendStream('\n\n（agent 连接失败）'))
      .finally(() => { setBusy(false); refreshSessions(); });
  };

  // 跑一次「总结成稿」：让 AI 基于全部对话输出六步答案。
  // 发送的 message 是组装好的角色+指令 prompt；persistAs 标记（「（请总结成稿）」）
  // 让后端落盘时用标记替代长指令原文——避免长指令消耗 100 条历史上限并污染下次对话上下文。
  // 流式累积输出 → 解析六步答案 → 回调父组件。
  // try/catch/finally：连接失败时只提示连接失败，跳过解析与回调（
  // 避免与「未识别到答案格式」同时出现两条矛盾提示）。
  const runAction = async () => {
    if (busy) return;
    setBusy(true);
    setAction('summarize');
    setError('');
    // 剧本项目存在：消息只带项目 storySummarize 指令（后端注入项目 storyTeller 人格 + 跳过 RAG）；
    // 无项目（旧路径）：消息带完整 storyTeller + storySummarize，systemPrompt 由前端解析全局/内置
    const summarizePrompt = boardId
      ? resolveBoardPrompt(props.board, props.prompts, 'storySummarize')
      : `${resolvePrompt(props.prompts, 'storyTeller')}\n\n${resolvePrompt(props.prompts, 'storySummarize')}`;
    const prompt = withArmorBreak(summarizePrompt, props.armorBreak, props.armorBreakEnabled);
    let acc = '';
    setMsgs((m) => [...m, { who: 'user', text: '（请总结成稿）' }]);
    try {
      await client.storyChat(prompt, (chunk) => {
        acc += chunk;
        appendStream(chunk);
      }, props.agentModel || undefined, props.thinkingLevel || undefined, '（请总结成稿）', activeId, undefined, boardId);
      const answers = parseStoryAnswers(acc);
      if (Object.keys(answers).length === 0) {
        setError('未识别到答案格式，请重试');
      } else {
        props.onSummarized(answers);
      }
    } catch {
      appendStream('\n\n（agent 连接失败）');
    } finally {
      setBusy(false);
      setAction(null);
      refreshSessions(); // 总结也落盘消息：刷新列表同步标题/updatedAt
    }
  };

  const summarize = () => runAction();

  if (!loaded) {
    return <div className="chat-wrap"><div className="role-loading">加载中…</div></div>;
  }

  return (
    <div className="chat-wrap">
      {/* 左侧会话列表面板：新建 / 点选 / 重命名 / 删除 */}
      <div className="session-panel" data-testid="session-panel">
        <button type="button" className="btn-ghost session-new" data-testid="session-new" onClick={() => { void newSession(); }}>＋ 新建会话</button>
        <div className="session-list">
          {sessions.map((s) => (
            <div key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`} data-testid={`session-item-${s.id}`}>
              <button type="button" className="session-select" onClick={() => selectSession(s.id)}>
                <span className="session-title">{s.title}</span>
                <span className="session-date">{fmtSessionDate(s.updatedAt)}</span>
              </button>
              <div className="session-acts">
                <button type="button" className="session-act" data-testid={`session-rename-${s.id}`} title="重命名"
                  onClick={() => { void renameSession(s); }}><Icon name="pencil" /></button>
                <button type="button" className="session-act" data-testid={`session-del-${s.id}`} title="删除"
                  onClick={() => { void deleteSession(s); }}><Icon name="trash" /></button>
              </div>
            </div>
          ))}
          {sessions.length === 0 && <div className="session-empty">暂无会话</div>}
        </div>
      </div>
      <div className="chat-main">
        <div className="chat-msgs">
          {msgs.length === 0 && (
            <EmptyState icon={<Icon name="chat" />} text="还没有对话，从任意创意开始吧——主题、角色、情节都可以聊" />
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`chat-msg ${m.who}`}>
              <div className="chat-who">{m.who === 'user' ? 'YOU' : 'AI · 编剧'}</div>
              <div className="chat-bubble">
                {m.who === 'agent' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                ) : m.text}
              </div>
            </div>
          ))}
          {busy && <div className="chat-thinking"><Icon name="loader" /> AI 思考中…</div>}
        </div>
        <div className="chat-input-row">
          <textarea
            className="ne-input chat-input" data-testid="chat-input"
            placeholder="和编剧聊聊你的故事…（Enter 发送 · Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
          />
          <button className="btn-primary" onClick={send} disabled={busy || !input.trim()}>发送</button>
        </div>
        <div className="chat-actions">
          <AiButton busy={busy && action === 'summarize'} onClick={summarize}><Icon name="sparkles" />总结成稿</AiButton>
          <span className="chat-hint">总结成稿：对话 → 完整故事文档入库</span>
        </div>
        {error && <ErrorBanner text={error} />}
      </div>
    </div>
  );
}
