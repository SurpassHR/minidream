import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchGenerateData,
  sendChat,
  fetchWorkflows,
  fetchComfyStatus,
  cancelJob,
  openJobEvents,
  createSession,
  deleteSession as apiDeleteSession,
  fetchSessions,
  fetchSessionMessages,
  renameSession as apiRenameSession,
  selectSession as apiSelectSession,
  updateLastMessage,
  type ChatMessage,
  type ChatStage,
  type ComfyStatus,
  type GenerateData,
  type JobEvent,
  type SkillCard,
  type WorkflowSpec,
} from './api';
import Rail from './components/Rail';
import Sidebar, { type Conversation } from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import SkillCards from './components/SkillCards';
import Composer, { type ComposerSubmitOpts } from './components/Composer';
import ChatView from './components/ChatView';
import './App.css';

/** 把 SSE 事件合并进消息 stages */
function mergeJobEvent(msg: ChatMessage, evt: JobEvent): ChatMessage {
  const stages = msg.stages ? [...msg.stages] : [];
  const taskIndex = () => stages.findIndex(s => s.type === 'task');
  const cloneTask = () => {
    const i = taskIndex();
    if (i < 0) {
      const t: ChatStage = { type: 'task', progress: { completed: 0, total: 1 } };
      stages.push(t);
      return { t, i: stages.length - 1 };
    }
    return { t: { ...stages[i]! }, i };
  };

  switch (evt.type) {
    case 'progress': {
      const { t, i } = cloneTask();
      t.progress = { completed: evt.completed, total: evt.total };
      stages[i] = t;
      break;
    }
    case 'queue': {
      const { t, i } = cloneTask();
      t.queued = evt.pending > 0;
      t.queueLabel = evt.pending > 0 ? `${evt.pending} 个任务排队中` : undefined;
      stages[i] = t;
      break;
    }
    case 'done': {
      const done: ChatStage = {
        type: 'done',
        logs: [`生成完成${evt.outputs?.length ? `，共 ${evt.outputs.length} 个结果` : ''}。`],
        outputs: evt.outputs ?? [],
        suggestion: '按同样的想法再生成一次',
      };
      return { ...msg, stages: [...stages.filter(s => s.type !== 'task'), done] };
    }
    case 'cancelled': {
      const { t, i } = cloneTask();
      t.cancelled = true;
      stages[i] = t;
      break;
    }
    case 'error': {
      return { ...msg, stages: [...stages, { type: 'error', logs: [evt.message] }] };
    }
    default:
      break;
  }
  return { ...msg, stages };
}

export default function App() {
  const [data, setData] = useState<GenerateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState('generate');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSpec[]>([]);
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    const t: 'light' | 'dark' =
      saved === 'dark' || saved === 'light'
        ? saved
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    document.documentElement.dataset.theme = t;
    return t;
  });
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refreshComfyStatus = useCallback(() => {
    fetchComfyStatus()
      .then(setComfyStatus)
      .catch(() => undefined);
  }, []);

  const refreshWorkflows = useCallback(() => {
    fetchWorkflows()
      .then(setWorkflows)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetchGenerateData()
      .then(setData)
      .catch(e => setError(String(e?.message ?? e)));
    refreshWorkflows();
    refreshComfyStatus();
  }, [refreshComfyStatus, refreshWorkflows]);

  useEffect(() => {
    let alive = true;
    fetchSessions()
      .then(r => {
        if (!alive) return;
        setConversations(r.sessions);
        if (r.activeId) {
          setActiveConv(r.activeId);
          return fetchSessionMessages(r.activeId).then(msgs => {
            if (alive) setMessages(msgs);
          });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  const handleSend = async (text?: string, opts?: ComposerSubmitOpts) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const userMsg: ChatMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);
    try {
      const { reply, title, stages, jobId, sessionId } = await sendChat(content, { ...opts, sessionId: activeConv });
      const sid = sessionId ?? activeConv;
      // 会话列表同步：新会话加入 / 已有会话更新时间
      setConversations(prev => {
        const now = Date.now();
        const exists = prev.some(c => c.id === sid);
        if (!exists) return [...prev, { id: sid ?? '', title: title ?? '', updatedAt: now }];
        return prev.map(c => (c.id === sid ? { ...c, title: title ?? c.title, updatedAt: now } : c));
      });
      if (sid) setActiveConv(sid);
      setMessages(prev => [...prev, { role: 'assistant', content: reply ?? '', stages, jobId }]);
      if (jobId && sid) {
        openJobEvents(jobId, evt => {
          setMessages(prev => {
            const idx = [...prev].reverse().findIndex(m => m.role === 'assistant' && m.jobId === jobId);
            if (idx < 0) return prev;
            const realIdx = prev.length - 1 - idx;
            const updated = prev.map((m, i) => (i === realIdx ? mergeJobEvent(m, evt) : m));
            // SSE 终态（完成/失败/取消）把最终消息落库，刷新后可还原结果
            if (evt.type === 'done' || evt.type === 'error' || evt.type === 'cancelled') {
              const finalMsg = updated[realIdx];
              if (finalMsg) void updateLastMessage(sid, finalMsg).catch(() => undefined);
            }
            return updated;
          });
        });
      }
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '（生成失败：请确认后端服务已启动）',
          stages: [{ type: 'error', logs: ['请求失败：请确认后端服务已启动（pnpm dev）'] }],
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleRegenerate = (index: number) => {
    const userMsg = [...messages].slice(0, index).reverse().find(m => m.role === 'user');
    if (userMsg) void handleSend(userMsg.content);
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await cancelJob(jobId);
    } catch {
      /* ignore */
    }
    setMessages(prev => prev.map(m => (m.jobId === jobId ? mergeJobEvent(m, { type: 'cancelled' }) : m)));
  };

  const handleTrySkill = (skill: SkillCard) => {
    setInput(`使用技能：${skill.title}。${skill.desc}`);
  };

  const handleNewChat = async () => {
    try {
      const r = await createSession();
      setConversations(r.sessions);
      setActiveConv(r.activeId);
      setMessages([]);
      setInput('');
    } catch {
      /* ignore */
    }
  };

  const handleSelectConversation = (id: string) => {
    if (id === activeConv) return;
    setActiveConv(id);
    setMessages([]);
    void apiSelectSession(id).catch(() => undefined);
    fetchSessionMessages(id)
      .then(setMessages)
      .catch(() => undefined);
  };

  const handleRenameConversation = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    const title = window.prompt('重命名会话', conv?.title ?? '');
    if (title == null) return;
    try {
      const r = await apiRenameSession(id, title.trim());
      setConversations(r.sessions);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteConversation = async (id: string) => {
    if (!window.confirm('删除该会话？此操作不可恢复。')) return;
    try {
      const r = await apiDeleteSession(id);
      setConversations(r.sessions);
      if (r.activeId) {
        setActiveConv(r.activeId);
        fetchSessionMessages(r.activeId)
          .then(setMessages)
          .catch(() => undefined);
      } else {
        setActiveConv(null);
        setMessages([]);
      }
    } catch {
      /* ignore */
    }
  };

  if (error) {
    return (
      <div className="app-error">
        <p>加载失败：{error}</p>
        <p className="app-error-hint">请确认后端服务已启动（pnpm dev）</p>
      </div>
    );
  }

  if (!data) {
    return <div className="app-loading">加载中…</div>;
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="app">
      <Rail
        items={data.rail.items}
        activeId={activeNav}
        onSelect={setActiveNav}
        theme={theme}
        onToggleTheme={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="workbench">
        <Sidebar
          createLabel={data.sidebar.createLabel}
          newChatLabel={data.sidebar.newChatLabel}
          conversations={conversations}
          activeId={activeConv}
          onNewChat={() => void handleNewChat()}
          onSelect={handleSelectConversation}
          onRename={id => void handleRenameConversation(id)}
          onDelete={id => void handleDeleteConversation(id)}
        />
        <main className="main">
          {isEmpty ? (
            <div className="generate-empty">
              <h1 className="generate-title">{data.hero.title}</h1>
              <SkillCards skills={data.skills} onTry={handleTrySkill} />
            </div>
          ) : (
            <div className="chat-scroll" ref={chatRef}>
              <ChatView messages={messages} onRegenerate={handleRegenerate} onCancelJob={handleCancelJob} />
              {sending && (
                <div className="chat-row assistant">
                  <div className="chat-avatar">
                    <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
                      <rect width="40" height="40" rx="12" fill="#00cae0" />
                      <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
                      <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
                      <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
                    </svg>
                  </div>
                  <div className="chat-bubble assistant">
                    <span className="chat-typing">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="composer-wrap">
            <Composer
              placeholder={data.composer.placeholder}
              composer={data.composer}
              value={input}
              onChange={setInput}
              onSubmit={opts => handleSend(undefined, opts)}
              disabled={sending}
              workflows={workflows}
              selectedWorkflowId={selectedWorkflowId}
              onSelectWorkflow={setSelectedWorkflowId}
              comfyStatus={comfyStatus}
            />
          </div>
        </main>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        comfyStatus={comfyStatus}
        onRefreshStatus={refreshComfyStatus}
        onRefreshWorkflows={refreshWorkflows}
      />
    </div>
  );
}
