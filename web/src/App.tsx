import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchGenerateData,
  sendChatStream,
  fetchWorkflows,
  fetchComfyStatus,
  cancelJob,
  cancelTask,
  fetchActivity,
  openActivityEvents,
  openSessionEvents,
  cancelSession as apiCancelSession,
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
  type WorkflowSpec,
  type ActionCardData,
  type ToolCallData,
  type TaskItem,
  type ActivitySnapshot,
  type ActivityStreamEvent,
  type StreamChatEvent,
} from './api';
import Rail from './components/Rail';
import Sidebar, { type Conversation } from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import Composer, { type ComposerSubmitOpts } from './components/Composer';
import ChatView from './components/ChatView';
import ActivityPanel from './components/ActivityPanel';
import DraftsView from './components/DraftsView';
import './App.css';

function mergeActivityEvent(snapshot: ActivitySnapshot, event: ActivityStreamEvent): ActivitySnapshot {
  if (event.type === 'snapshot') return event.snapshot;
  if (
    event.type === 'session:started' ||
    event.type === 'session:updated' ||
    event.type === 'session:canceled' ||
    event.type === 'session:finished'
  ) {
    const sessions = snapshot.sessions.filter(item => item.sessionId !== event.session.sessionId);
    return {
      ...snapshot,
      sessions: [...sessions, event.session],
    };
  }
  if (event.type !== 'task:updated') return snapshot;
  const task = event.task;
  const tasks = snapshot.tasks.filter(item => item.id !== task.id);
  tasks.push(task);
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ...snapshot, tasks: tasks.slice(0, 50) };
}

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

function newAssistantMessage(): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    thinking: '',
    toolCalls: [],
    tasks: [],
    actionCards: [],
    stages: [],
  };
}

function mergeStreamEvent(
  messages: ChatMessage[],
  event: StreamChatEvent,
  addEmptyResponseError = false,
): ChatMessage[] {
  let lastIdx = messages.length - 1;
  let next = messages;
  if (lastIdx < 0 || messages[lastIdx]?.role !== 'assistant') {
    next = [...messages, newAssistantMessage()];
    lastIdx = next.length - 1;
  }

  const target = next[lastIdx];
  if (!target || target.role !== 'assistant') return next;
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
    current.status = undefined;
    current.thinking = (current.thinking || '') + event.delta;
  } else if (event.type === 'agent:text') {
    current.status = undefined;
    current.content = (current.content || '') + event.delta;
  } else if (event.type === 'agent:action_card') {
    current.status = undefined;
    current.actionCards = [...(current.actionCards || []), event.card];
  } else if (event.type === 'tool:call') {
    current.status = undefined;
    current.toolCalls = [...(current.toolCalls || []), {
      callId: event.callId,
      name: event.name,
      args: event.args,
    }];
  } else if (event.type === 'tool:result') {
    current.status = undefined;
    current.toolCalls = (current.toolCalls || []).map(tool =>
      tool.callId === event.callId ? { ...tool, result: event.result } : tool,
    );
  } else if (
    event.type === 'task:queued' ||
    event.type === 'task:progress' ||
    event.type === 'task:completed' ||
    event.type === 'task:failed' ||
    event.type === 'task:canceled'
  ) {
    current.status = undefined;
    if (event.task) {
      const tasks = [...(current.tasks || [])];
      const taskIndex = tasks.findIndex(task => task.id === event.task!.id);
      if (taskIndex >= 0) tasks[taskIndex] = event.task;
      else tasks.push(event.task);
      current.tasks = tasks;
    }
  } else if (event.type === 'task:artifact') {
    current.status = undefined;
    current.tasks = (current.tasks || []).map(task => {
      if (task.id !== event.taskId) return task;
      const outputs = [...(task.outputs || [])];
      if (!outputs.some(output => output.url === event.url)) {
        outputs.push({ kind: event.kind, url: event.url, filename: event.filename || 'output' });
      }
      return { ...task, outputs };
    });
  } else if (event.type === 'agent:error') {
    current.status = undefined;
    current.stages = [...(current.stages || []), { type: 'error', logs: [event.error] }];
  } else if (event.type === 'agent:end' && !event.canceled && addEmptyResponseError && !current.content && !current.thinking) {
    current.stages = [
      ...(current.stages || []),
      { type: 'error', logs: ['流式响应结束，但没有收到 Agent 输出。请检查 Pi CLI 和模型配置。'] },
    ];
  }

  return next.map((message, index) => index === lastIdx ? current : message);
}

export default function App() {
  const [data, setData] = useState<GenerateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState('generate');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [activity, setActivity] = useState<ActivitySnapshot>({ sessions: [], tasks: [] });
  const [activityOpen, setActivityOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [loadedConv, setLoadedConv] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSpec[]>([]);
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus | null>(null);
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
  const streamAbortRef = useRef<AbortController | null>(null);
  const sessionEventUnsubscribeRef = useRef<(() => void) | null>(null);

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
    fetchActivity().then(snapshot => {
      if (alive) setActivity(snapshot);
    }).catch(() => undefined);
    const unsubscribe = openActivityEvents(event => {
      if (!alive) return;
      setActivity(previous => mergeActivityEvent(previous, event));
      if (event.type === 'session:renamed') {
        // 对话自动命名完成（可能发生在聊天流结束后），实时更新侧边栏标题
        setConversations(prev =>
          prev.map(c => (c.id === event.sessionId ? { ...c, title: event.title } : c)),
        );
      }
    });
    fetchSessions()
      .then(r => {
        if (!alive) return;
        setConversations(r.sessions);
        if (r.activeId) {
          setActiveConv(r.activeId);
          return fetchSessionMessages(r.activeId).then(msgs => {
            if (alive) {
              setMessages(msgs);
              setLoadedConv(r.activeId);
            }
          });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  // 刷新后重新订阅仍在运行的会话；后端会先回放断线期间的事件。
  useEffect(() => {
    if (!loadedConv) return;
    let disposed = false;
    let closeSubscription: () => void = () => undefined;
    fetchActivity()
      .then(snapshot => {
        if (
          disposed ||
          streamAbortRef.current ||
          !snapshot.sessions.some(session => session.sessionId === loadedConv && session.status === 'running')
        ) return;
        setSending(true);
        closeSubscription = openSessionEvents(loadedConv, event => {
          if (event.type === 'agent:started' || event.type === 'agent:end') {
            if (event.sessionId) setActiveConv(event.sessionId);
          }
          if (event.type === 'session:renamed') {
            setConversations(prev =>
              prev.map(c => (c.id === event.sessionId ? { ...c, title: event.title } : c)),
            );
          }
          setMessages(previous => mergeStreamEvent(previous, event, event.type === 'agent:end'));
          if (event.type === 'agent:end') {
            setSending(false);
            setMessages(latest => {
              const last = latest.at(-1);
              if (last?.role === 'assistant') void updateLastMessage(loadedConv!, last).catch(() => undefined);
              return latest;
            });
          }
        });
        sessionEventUnsubscribeRef.current = closeSubscription;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      closeSubscription();
      if (sessionEventUnsubscribeRef.current === closeSubscription) sessionEventUnsubscribeRef.current = null;
    };
  }, [loadedConv]);

  const handleSend = async (text?: string, opts?: ComposerSubmitOpts) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const userMsg: ChatMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setSending(true);
    const streamAbort = new AbortController();
    streamAbortRef.current = streamAbort;

    // 预置一条空的助手消息用于流式填充
    const initialAssistantMsg = newAssistantMessage();
    setMessages(prev => [...prev, initialAssistantMsg]);

    let sid = activeConv;
    let receivedStreamContent = false;

    try {
      await sendChatStream(
        content,
        { ...opts, sessionId: activeConv },
        event => {
          if (
            event.type === 'agent:thinking' ||
            event.type === 'agent:text' ||
            event.type === 'agent:action_card' ||
            event.type === 'tool:call' ||
            event.type === 'tool:result' ||
            event.type === 'task:queued' ||
            event.type === 'task:progress' ||
            event.type === 'task:artifact' ||
            event.type === 'task:completed' ||
            event.type === 'task:failed' ||
            event.type === 'task:canceled' ||
            event.type === 'agent:error'
          ) {
            receivedStreamContent = true;
          }

          if (event.type === 'agent:started' || event.type === 'agent:end') {
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

          if (event.type === 'session:renamed') {
            // 新会话自动命名完成后，实时更新侧边栏标题
            setConversations(prev =>
              prev.map(c => (c.id === event.sessionId ? { ...c, title: event.title } : c)),
            );
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
              current.status = undefined;
              current.thinking = (current.thinking || '') + event.delta;
            } else if (event.type === 'agent:text') {
              current.status = undefined;
              current.content = (current.content || '') + event.delta;
            } else if (event.type === 'agent:action_card') {
              current.status = undefined;
              current.actionCards = [...(current.actionCards || []), event.card];
            } else if (event.type === 'tool:call') {
              current.status = undefined;
              const tc: ToolCallData = {
                callId: event.callId,
                name: event.name,
                args: event.args,
              };
              current.toolCalls = [...(current.toolCalls || []), tc];
            } else if (event.type === 'tool:result') {
              current.status = undefined;
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
              current.status = undefined;
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
              current.status = undefined;
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
              current.status = undefined;
              current.stages = [
                ...(current.stages || []),
                { type: 'error', logs: [event.error] },
              ];
            } else if (event.type === 'agent:end' && !event.canceled && !receivedStreamContent) {
              current.stages = [
                ...(current.stages || []),
                { type: 'error', logs: ['流式响应结束，但没有收到 Agent 输出。请检查 Pi CLI 和模型配置。'] },
              ];
            }

            return prev.map((m, i) => (i === lastIdx ? current : m));
          });
        },
        streamAbort.signal,
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
    } catch (err) {
      if (streamAbort.signal.aborted) {
        return;
      }
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: '（请求失败：请确认后端服务已正常运行）',
          stages: [{ type: 'error', logs: ['请求失败：请确认后端服务已启动（pnpm dev）'] }],
        },
      ]);
    } finally {
      if (streamAbortRef.current === streamAbort) streamAbortRef.current = null;
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

  const handleStopConversation = () => {
    streamAbortRef.current?.abort();
    if (activeConv) {
      void apiCancelSession(activeConv).catch(() => undefined);
    }
  };

  const handleCancelSession = (sessionId: string) => {
    void apiCancelSession(sessionId).then(() => {
      if (sessionId === activeConv) streamAbortRef.current?.abort();
    }).catch(() => undefined);
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

  const handleNewChat = async () => {
    try {
      const r = await createSession();
      setConversations(r.sessions);
      setActiveConv(r.activeId);
      setLoadedConv(null);
      setMessages([]);
      setInput('');
    } catch {
      /* ignore */
    }
  };

  const handleSelectConversation = (id: string) => {
    if (id === activeConv) return;
    setActiveConv(id);
    setLoadedConv(null);
    setMessages([]);
    void apiSelectSession(id).catch(() => undefined);
    fetchSessionMessages(id)
      .then(msgs => {
        setMessages(msgs);
        setLoadedConv(id);
      })
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
        setLoadedConv(null);
        fetchSessionMessages(r.activeId)
          .then(msgs => {
            setMessages(msgs);
            setLoadedConv(r.activeId);
          })
          .catch(() => undefined);
      } else {
        setActiveConv(null);
        setLoadedConv(null);
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
  // 会话列表只属于「生成」工作台；草稿是全局产物、其余模块未开发，均不显示
  const isChatView = activeNav === 'generate';
  const devLabel = data.rail.items.find(item => item.id === activeNav)?.label ?? '该模块';

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
        {isChatView && (
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
        )}
        <main className="main">
          <div className="main-statusbar">
            <span className={`status-dot${activity.sessions.some(s => s.status === 'running') || activity.tasks.length > 0 ? ' active' : ''}`} />
            <span className="main-status-label">
              {activity.sessions.filter(s => s.status === 'running').length + activity.tasks.length > 0
                ? `${activity.sessions.filter(s => s.status === 'running').length + activity.tasks.length} 项活动运行中`
                : '暂无运行中的活动'}
            </span>
            <button className="activity-open-btn" onClick={() => setActivityOpen(true)}>
              查看活动
            </button>
          </div>
          {activityOpen && (
            <ActivityPanel
              snapshot={activity}
              onClose={() => setActivityOpen(false)}
              onCancelSession={handleCancelSession}
              onCancelTask={handleCancelTask}
            />
          )}
          {activeNav === 'drafts' ? (
            <DraftsView />
          ) : activeNav === 'generate' ? (
            isEmpty ? (
              <div className="generate-empty">
                <h1 className="generate-title">{data.hero.title}</h1>
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
            )
          ) : (
            <div className="dev-view">
              <div className="dev-view-icon">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                  <rect x="6" y="6" width="32" height="32" rx="9" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M22 15v14M15 22h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </div>
              <h1 className="dev-view-title">{devLabel} 正在开发中</h1>
              <p className="dev-view-desc">该模块尚未上线，正在加紧建设中，敬请期待。</p>
            </div>
          )}
          {activeNav === 'generate' && <div className="composer-wrap">
            <Composer
              placeholder={data.composer.placeholder}
              composer={data.composer}
              value={input}
              onChange={setInput}
              onSubmit={opts => handleSend(undefined, opts)}
              onStop={handleStopConversation}
              disabled={sending}
            />
          </div>}
        </main>
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        comfyStatus={comfyStatus}
        workflows={workflows}
        onRefreshStatus={refreshComfyStatus}
        onRefreshWorkflows={refreshWorkflows}
      />
    </div>
  );
}
