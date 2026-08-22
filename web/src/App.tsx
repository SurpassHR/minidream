import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchGenerateData,
  sendChatStream,
  fetchWorkflows,
  fetchComfyStatus,
  cancelJob,
  cancelTask,
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
  type ActionCardData,
  type ToolCallData,
  type TaskItem,
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

    // 预置一条空的助手消息用于流式填充
    const initialAssistantMsg: ChatMessage = {
      role: 'assistant',
      content: '',
      thinking: '',
      toolCalls: [],
      tasks: [],
      actionCards: [],
      stages: [],
    };
    setMessages(prev => [...prev, initialAssistantMsg]);

    let sid = activeConv;

    try {
      await sendChatStream(
        content,
        { ...opts, sessionId: activeConv },
        event => {
          if (event.type === 'agent:end') {
            if (event.sessionId) {
              const targetId = event.sessionId;
              sid = targetId;
              setActiveConv(targetId);
              setConversations(prev => {
                const now = Date.now();
                const exists = prev.some(c => c.id === targetId);
                if (!exists) return [...prev, { id: targetId, title: '新会话', updatedAt: now }];
                return prev.map(c => (c.id === targetId ? { ...c, updatedAt: now } : c));
              });
            }
          }

          setMessages(prev => {
            const lastIdx = prev.length - 1;
            if (lastIdx < 0) return prev;
            const target = prev[lastIdx];
            if (!target || target.role !== 'assistant') return prev;
            const current: ChatMessage = {
              role: 'assistant',
              content: target.content || '',
              thinking: target.thinking,
              thinkingDurationMs: target.thinkingDurationMs,
              toolCalls: target.toolCalls ? [...target.toolCalls] : [],
              tasks: target.tasks ? [...target.tasks] : [],
              actionCards: target.actionCards ? [...target.actionCards] : [],
              stages: target.stages ? [...target.stages] : [],
              jobId: target.jobId,
              taskId: target.taskId,
            };

            if (event.type === 'agent:thinking') {
              current.thinking = (current.thinking || '') + event.delta;
            } else if (event.type === 'agent:text') {
              current.content = (current.content || '') + event.delta;
            } else if (event.type === 'agent:action_card') {
              current.actionCards = [...(current.actionCards || []), event.card];
            } else if (event.type === 'tool:call') {
              const tc: ToolCallData = {
                callId: event.callId,
                name: event.name,
                args: event.args,
              };
              current.toolCalls = [...(current.toolCalls || []), tc];
            } else if (event.type === 'tool:result') {
              current.toolCalls = (current.toolCalls || []).map(t =>
                t.callId === event.callId ? { ...t, result: event.result } : t,
              );
            } else if (
              event.type === 'task:queued' ||
              event.type === 'task:progress' ||
              event.type === 'task:completed' ||
              event.type === 'task:failed' ||
              event.type === 'task:canceled'
            ) {
              if ('task' in event && event.task) {
                const taskObj = event.task;
                const tasks = [...(current.tasks || [])];
                const tIdx = tasks.findIndex(t => t.id === taskObj.id);
                if (tIdx >= 0) {
                  tasks[tIdx] = taskObj;
                } else {
                  tasks.push(taskObj);
                }
                current.tasks = tasks;
              }
            } else if (event.type === 'task:artifact') {
              // 自动将 artifact 合并到 task 中（如果有对应 task）
              if (current.tasks) {
                current.tasks = current.tasks.map(t => {
                  if (t.id === event.taskId) {
                    const outputs = [...(t.outputs || [])];
                    if (!outputs.some(o => o.url === event.url)) {
                      outputs.push({
                        kind: event.kind,
                        url: event.url,
                        filename: event.filename || 'output',
                      });
                    }
                    return { ...t, outputs };
                  }
                  return t;
                });
              }
            } else if (event.type === 'agent:error') {
              current.stages = [
                ...(current.stages || []),
                { type: 'error', logs: [event.error] },
              ];
            }

            return prev.map((m, i) => (i === lastIdx ? current : m));
          });
        },
      );

      // 流结束，将最后完整的助手消息持久化落盘
      if (sid) {
        setMessages(latest => {
          const lastMsg = latest[latest.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            void updateLastMessage(sid!, lastMsg).catch(() => undefined);
          }
          return latest;
        });
      }
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '（请求失败：请确认后端服务已正常运行）',
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

  const handleCancelTask = async (taskId: string) => {
    try {
      await cancelTask(taskId);
      setMessages(prev =>
        prev.map(m => {
          if (!m.tasks) return m;
          return {
            ...m,
            tasks: m.tasks.map(t => (t.id === taskId ? { ...t, status: 'canceled' } : t)),
          };
        }),
      );
    } catch {
      /* ignore */
    }
  };

  const handleActionCard = (card: ActionCardData) => {
    const images = card.images?.map(url => ({ dataUrl: url }));
    void handleSend(card.prompt, {
      workflowId: card.workflowId,
      images,
      params: card.params,
    });
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
              <ChatView
                messages={messages}
                liveIndex={sending ? messages.length - 1 : null}
                onRegenerate={handleRegenerate}
                onCancelJob={handleCancelJob}
                onCancelTask={handleCancelTask}
                onActionCard={handleActionCard}
              />
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
