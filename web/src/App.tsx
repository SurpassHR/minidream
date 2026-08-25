import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
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
  deleteSessions as apiDeleteSessions,
  deleteSessionMessage,
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
  type TaskItem,
  type ToolCallData,
  type ActivitySnapshot,
  type ActivityStreamEvent,
  type StreamChatEvent,
  type ResponseBlock,
} from './api';
import Rail from './components/Rail';
import Sidebar, { type Conversation } from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import Composer, { type ComposerSubmitOpts } from './components/Composer';
import ChatView from './components/ChatView';
import ActivityPanel from './components/ActivityPanel';
import DraftsView from './components/DraftsView';
import SessionAssetsPanel from './components/SessionAssetsPanel';
import { extractSessionAssets, findMentionedSessionAssets, type SessionAsset } from './sessionAssets';
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
      t.queueLabel = evt.pending > 0 ? i18n.t('app.queuedCount', { count: evt.pending }) : undefined;
      stages[i] = t;
      break;
    }
    case 'done': {
      const count = evt.outputs?.length ?? 0;
      const done: ChatStage = {
        type: 'done',
        logs: [count > 0 ? i18n.t('app.doneLog', { count }) : i18n.t('app.doneDone')],
        outputs: evt.outputs ?? [],
        suggestion: i18n.t('app.doneSuggestion'),
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
    routes: [],
    generationPrompts: [],
    responseBlocks: [],
    responseProtocolActive: false,
    responsePolicy: undefined,
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
    routes: target.routes ? [...target.routes] : [],
    generationPrompts: target.generationPrompts ? [...target.generationPrompts] : [],
    responseBlocks: target.responseBlocks ? [...target.responseBlocks] : [],
    responseProtocolActive: target.responseProtocolActive,
    responsePolicy: target.responsePolicy,
    stages: target.stages ? [...target.stages] : [],
    jobId: target.jobId,
    taskId: target.taskId,
  };

  if (event.type === 'agent:thinking') {
    current.status = undefined;
    current.thinking = (current.thinking || '') + event.delta;
  } else if (event.type === 'agent:response_policy') {
    current.status = undefined;
    current.responsePolicy = event.policy;
  } else if (event.type === 'agent:response_protocol') {
    current.status = undefined;
    current.responseProtocolActive = event.active;
  } else if (event.type === 'agent:text') {
    current.status = undefined;
    current.content = (current.content || '') + event.delta;
  } else if (event.type === 'agent:prompt') {
    current.status = undefined;
    current.generationPrompts = [...(current.generationPrompts || []), event.prompt];
  } else if (event.type === 'agent:response_block') {
    current.status = undefined;
    const blocks = [...(current.responseBlocks || [])];
    const index = blocks.findIndex(block => block.id === event.block.id);
    if (index >= 0) blocks[index] = event.block;
    else blocks.push(event.block);
    blocks.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    current.responseBlocks = blocks;
  } else if (event.type === 'agent:route') {
    current.status = undefined;
    const routes = [...(current.routes || [])];
    if (!routes.some(route => route.taskId && event.route.taskId ? route.taskId === event.route.taskId : route.finalWorkflowId === event.route.finalWorkflowId && route.requestedWorkflowId === event.route.requestedWorkflowId)) {
      routes.push(event.route);
    }
    current.routes = routes;
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
    const isGenerationSubmit = event.name === 'generation.submit' || event.name.endsWith('.generation.submit');
    const prompt = typeof event.args?.prompt === 'string' ? event.args.prompt.trim() : '';
    if (isGenerationSubmit && prompt && !(current.generationPrompts || []).some(item => item === prompt)) {
      current.generationPrompts = [...(current.generationPrompts || []), prompt];
    }
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
      { type: 'error', logs: [i18n.t('app.streamEndNoOutput')] },
    ];
  }

  return next.map((message, index) => index === lastIdx ? current : message);
}

export default function App() {
  const { t } = useTranslation();
  const [data, setData] = useState<GenerateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState('generate');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [deletingMessageIndex, setDeletingMessageIndex] = useState<number | null>(null);
  /** Agent 正文回复是否已结束：回复完成后即使生成任务仍在进行，也不再显示打字光标 */
  const [agentReplyDone, setAgentReplyDone] = useState(false);
  const [activity, setActivity] = useState<ActivitySnapshot>({ sessions: [], tasks: [] });
  const [activityOpen, setActivityOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<string | null>(null);
  const [loadedConv, setLoadedConv] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSpec[]>([]);
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingAssets, setPendingAssets] = useState<SessionAsset[]>([]);
  const sessionAssets = useMemo(() => [...extractSessionAssets(messages), ...pendingAssets], [messages, pendingAssets]);
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
  /** 当前展示的会话（ref 同步，供流式回调判断事件归属，避免闭包读到旧值） */
  const activeConvRef = useRef<string | null>(null);
  /** 当前进行中的流所属会话；用户切换会话后用于丢弃不属于当前视图的事件 */
  const streamSessionRef = useRef<string | null>(null);

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

  // 同步当前展示会话到 ref（切换会话后，仍在运行的旧流靠它识别自己已被切走）
  useEffect(() => {
    activeConvRef.current = activeConv;
  }, [activeConv]);

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
        // 恢复进行中的会话时，Agent 正文大概率已输出完毕，直接停止打字光标
        setAgentReplyDone(true);
        closeSubscription = openSessionEvents(loadedConv, event => {
          if (event.type === 'agent:started' || event.type === 'agent:end') {
            if (event.sessionId) {
              activeConvRef.current = event.sessionId;
              setActiveConv(event.sessionId);
            }
          }
          if (event.type === 'agent:reply_done' || event.type === 'agent:end') {
            setAgentReplyDone(true);
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

  const handleSend = async (text?: string, opts?: ComposerSubmitOpts, replaceMessageIndex?: number) => {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const assets = opts?.assets?.length ? opts.assets : pendingAssets;
    const userMsg: ChatMessage = { role: 'user', content, assets: assets.length ? assets : undefined };
    setMessages(prev => replaceMessageIndex === undefined
      ? [...prev, userMsg]
      : [...prev.slice(0, replaceMessageIndex), userMsg]);
    setPendingAssets([]);
    setInput('');
    setSending(true);
    setAgentReplyDone(false);
    const streamAbort = new AbortController();
    streamAbortRef.current = streamAbort;
    // 记录该流所属会话：切换会话后，属于旧会话的事件不再写入当前视图
    streamSessionRef.current = activeConv;

    // 预置一条空的助手消息用于流式填充
    const initialAssistantMsg = newAssistantMessage();
    setMessages(prev => [...prev, initialAssistantMsg]);

    let sid = activeConv;
    let receivedStreamContent = false;

    try {
      await sendChatStream(
        content,
        {
          ...opts,
          sessionId: activeConv,
          assets,
          replaceMessageIndex,
        },
        event => {
          if (event.type === 'agent:reply_done') {
            setAgentReplyDone(true);
          }
          if (
            event.type === 'agent:thinking' ||
            event.type === 'agent:response_policy' ||
            event.type === 'agent:response_protocol' ||
            event.type === 'agent:text' ||
            event.type === 'agent:prompt' ||
            event.type === 'agent:route' ||
            event.type === 'agent:response_block' ||
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
              streamSessionRef.current = targetId;
              // 侧边栏列表总是更新（新会话出现/时间戳）；仅当用户未切走（仍是该流所属会话，
              // 或新会话尚未建立时 activeConvRef 为 null）才跟随切换活动会话，避免把视图拉回旧会话
              setConversations(prev => {
                const now = Date.now();
                const exists = prev.some(c => c.id === targetId);
                if (!exists) return [...prev, { id: targetId, title: t('app.newChatTitle'), updatedAt: now }];
                return prev.map(c => (c.id === targetId ? { ...c, updatedAt: now } : c));
              });
              if (activeConvRef.current === null || activeConvRef.current === targetId) {
                activeConvRef.current = targetId;
                setActiveConv(targetId);
              }
            }
          }

          if (event.type === 'session:renamed') {
            // 新会话自动命名完成后，实时更新侧边栏标题
            setConversations(prev =>
              prev.map(c => (c.id === event.sessionId ? { ...c, title: event.title } : c)),
            );
          }

          // 该流已不属于当前展示的会话（用户已切换/新建/删除会话）→ 丢弃后续 UI 更新，
          // 避免旧会话的流式内容串进新会话的视图
          if (activeConvRef.current !== streamSessionRef.current) return;

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
              responsePolicy: target.responsePolicy,
              toolCalls: target.toolCalls ? [...target.toolCalls] : [],
              tasks: target.tasks ? [...target.tasks] : [],
              actionCards: target.actionCards ? [...target.actionCards] : [],
              routes: target.routes ? [...target.routes] : [],
              generationPrompts: target.generationPrompts ? [...target.generationPrompts] : [],
              responseBlocks: target.responseBlocks ? [...target.responseBlocks] : [],
              responseProtocolActive: target.responseProtocolActive,
              stages: target.stages ? [...target.stages] : [],
              jobId: target.jobId,
              taskId: target.taskId,
            };

            if (event.type === 'agent:thinking') {
              current.status = undefined;
              current.thinking = (current.thinking || '') + event.delta;
            } else if (event.type === 'agent:response_policy') {
              current.status = undefined;
              current.responsePolicy = event.policy;
            } else if (event.type === 'agent:response_protocol') {
              current.status = undefined;
              current.responseProtocolActive = event.active;
            } else if (event.type === 'agent:text') {
              current.status = undefined;
              current.content = (current.content || '') + event.delta;
            } else if (event.type === 'agent:prompt') {
              current.status = undefined;
              if (!(current.generationPrompts || []).some(item => item === event.prompt)) {
                current.generationPrompts = [...(current.generationPrompts || []), event.prompt];
              }
            } else if (event.type === 'agent:response_block') {
              current.status = undefined;
              const blocks = [...(current.responseBlocks || [])];
              const blockIndex = blocks.findIndex(block => block.id === event.block.id);
              if (blockIndex >= 0) blocks[blockIndex] = event.block;
              else blocks.push(event.block);
              blocks.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
              current.responseBlocks = blocks;
            } else if (event.type === 'agent:route') {
              current.status = undefined;
              const routes = [...(current.routes || [])];
              if (!routes.some(route => route.taskId && event.route.taskId ? route.taskId === event.route.taskId : route.finalWorkflowId === event.route.finalWorkflowId && route.requestedWorkflowId === event.route.requestedWorkflowId)) {
                routes.push(event.route);
              }
              current.routes = routes;
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
                { type: 'error', logs: [t('app.streamEndNoOutput')] },
              ];
            }

            return prev.map((m, i) => (i === lastIdx ? current : m));
          });
        },
        streamAbort.signal,
      );

      // 流结束，将最后完整的助手消息持久化落盘（仅当仍停留在该流所属会话时，
      // 避免把当前展示会话的最后一条消息写进 sid 的会话文件）
      if (sid && activeConvRef.current === sid) {
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
      // 非中止错误（如网络失败）也不写入已切换走的会话视图
      if (sid && activeConvRef.current !== sid) return;
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: t('app.requestFailed'),
          stages: [{ type: 'error', logs: [t('app.requestFailedLog')] }],
        },
      ]);
    } finally {
      if (streamAbortRef.current === streamAbort) streamAbortRef.current = null;
      setSending(false);
      setAgentReplyDone(true);
    }
  };

  const fetchAssetDataUrl = async (asset: SessionAsset): Promise<string | null> => {
    if (asset.url.startsWith('data:')) return asset.url;
    try {
      const response = await fetch(asset.url);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  // 解析文本中 @imageN/@videoN 提及的会话素材为上传载荷（与 Composer.submit 同口径）。
  // 重新生成/编辑重发旧消息时若不附带素材，Agent 只能看到文本里的 @ 标签而拿不到真实文件。
  const attachMentionedAssets = async (text: string) => {
    const mentioned = findMentionedSessionAssets(text, sessionAssets);
    const uploaded = await Promise.all(mentioned.map(async asset => ({
      asset,
      dataUrl: await fetchAssetDataUrl(asset),
    })));
    return {
      images: uploaded
        .filter(item => item.asset.kind === 'image' && item.dataUrl)
        .map(item => ({ name: item.asset.name, dataUrl: item.dataUrl! })),
      videos: uploaded
        .filter(item => item.asset.kind === 'video' && item.dataUrl)
        .map(item => ({ name: item.asset.name, dataUrl: item.dataUrl! })),
      assets: mentioned,
    };
  };

  const handleRegenerate = async (index: number) => {
    const userMsg = [...messages].slice(0, index).reverse().find(m => m.role === 'user');
    if (userMsg) {
      const assets = await attachMentionedAssets(userMsg.content);
      void handleSend(userMsg.content, assets);
    }
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

  const handleDeleteMessage = async (index: number) => {
    if (!activeConv || sending || deletingMessageIndex !== null) return;
    if (!window.confirm(t('app.confirmDeleteMessage'))) return;
    setDeletingMessageIndex(index);
    try {
      const result = await deleteSessionMessage(activeConv, index);
      setMessages(result.messages);
    } catch {
      /* ignore */
    } finally {
      setDeletingMessageIndex(null);
    }
  };

  const handleEditMessage = async (index: number, content: string) => {
    if (!activeConv || sending) return;
    const assets = await attachMentionedAssets(content);
    void handleSend(content, assets, index);
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
    // 中止进行中的流，避免其事件写入新建的空会话
    streamAbortRef.current?.abort();
    activeConvRef.current = null;
    try {
      const r = await createSession();
      setConversations(r.sessions);
      activeConvRef.current = r.activeId;
      setActiveConv(r.activeId);
      setLoadedConv(null);
      setMessages([]);
      setPendingAssets([]);
      setInput('');
    } catch {
      /* ignore */
    }
  };

  const handleSelectConversation = (id: string) => {
    if (id === activeConv) return;
    // 中止旧会话的流：服务端生成继续（事件按会话缓冲），切回时由会话事件订阅回放；
    // 同步更新 ref，确保旧流残余事件不会写入新会话视图
    streamAbortRef.current?.abort();
    activeConvRef.current = id;
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
    const title = window.prompt(t('app.promptRename'), conv?.title ?? '');
    if (title == null) return;
    try {
      const r = await apiRenameSession(id, title.trim());
      setConversations(r.sessions);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteConversation = async (id: string) => {
    if (!window.confirm(t('app.confirmDelete'))) return;
    // 中止进行中的流，避免其事件写入删除后切换到的会话
    streamAbortRef.current?.abort();
    try {
      const r = await apiDeleteSession(id);
      setConversations(r.sessions);
      if (r.activeId) {
        activeConvRef.current = r.activeId;
        setActiveConv(r.activeId);
        setLoadedConv(null);
        fetchSessionMessages(r.activeId)
          .then(msgs => {
            setMessages(msgs);
            setLoadedConv(r.activeId);
          })
          .catch(() => undefined);
      } else {
        activeConvRef.current = null;
        setActiveConv(null);
        setLoadedConv(null);
        setMessages([]);
      }
    } catch {
      /* ignore */
    }
  };

  const handleDeleteConversations = async (ids: string[]) => {
    if (ids.length === 0 || !window.confirm(t('sidebar.confirmDeleteSelected', { count: ids.length }))) return;
    const activeDeleted = activeConv !== null && ids.includes(activeConv);
    if (activeDeleted) streamAbortRef.current?.abort();
    try {
      const r = await apiDeleteSessions(ids);
      setConversations(r.sessions);
      if (!activeDeleted) return;
      if (r.activeId) {
        activeConvRef.current = r.activeId;
        setActiveConv(r.activeId);
        setLoadedConv(null);
        fetchSessionMessages(r.activeId)
          .then(msgs => {
            setMessages(msgs);
            setLoadedConv(r.activeId);
          })
          .catch(() => undefined);
      } else {
        activeConvRef.current = null;
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
        <p>{t('app.loadFailed', { error })}</p>
        <p className="app-error-hint">{t('app.loadFailedHint')}</p>
      </div>
    );
  }

  if (!data) {
    return <div className="app-loading">{t('common.loading')}</div>;
  }

  const isEmpty = messages.length === 0;
  // 会话列表只属于「生成」工作台；草稿是全局产物、其余模块未开发，均不显示
  const isChatView = activeNav === 'generate';
  // 导航文案按 id 走 i18n（服务端仅提供 id/icon）；未知 id 回退为原始值
  const devLabel = t(`nav.${activeNav}` as 'nav.unknown', { defaultValue: activeNav });

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
            conversations={conversations}
            activeId={activeConv}
            onNewChat={() => void handleNewChat()}
            onSelect={handleSelectConversation}
            onRename={id => void handleRenameConversation(id)}
            onDelete={id => void handleDeleteConversation(id)}
            onDeleteMany={ids => void handleDeleteConversations(ids)}
          />
        )}
        <main className="main">
          <div className="main-statusbar">
            <span className={`status-dot${activity.sessions.some(s => s.status === 'running') || activity.tasks.length > 0 ? ' active' : ''}`} />
            <span className="main-status-label">
              {activity.sessions.filter(s => s.status === 'running').length + activity.tasks.length > 0
                ? t('statusbar.runningCount', { count: activity.sessions.filter(s => s.status === 'running').length + activity.tasks.length })
                : t('statusbar.idle')}
            </span>
            <button className="activity-open-btn" onClick={() => setActivityOpen(true)}>
              {t('statusbar.viewActivity')}
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
                <h1 className="generate-title">{t('hero.title')}</h1>
              </div>
            ) : (
              <div className="chat-scroll" ref={chatRef}>
                <ChatView
                  messages={messages}
                  liveIndex={sending && !agentReplyDone ? messages.length - 1 : null}
                  onRegenerate={handleRegenerate}
                  onCancelJob={handleCancelJob}
                  onCancelTask={handleCancelTask}
                  onActionCard={handleActionCard}
                  sessionAssets={sessionAssets}
                  onDeleteMessage={handleDeleteMessage}
                  onEditMessage={handleEditMessage}
                  deleteDisabled={sending || deletingMessageIndex !== null}
                  editDisabled={sending || deletingMessageIndex !== null}
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
              <h1 className="dev-view-title">{t('app.devTitle', { label: devLabel })}</h1>
              <p className="dev-view-desc">{t('app.devDesc')}</p>
            </div>
          )}
          {activeNav === 'generate' && <div className="composer-wrap">
            <Composer
              composer={data.composer}
              sessionId={activeConv}
              sessionAssets={sessionAssets}
              value={input}
              onChange={setInput}
              onAssetUploaded={asset => setPendingAssets(prev => [...prev, asset])}
              onSubmit={opts => handleSend(undefined, opts)}
              onStop={handleStopConversation}
              disabled={sending}
            />
          </div>}
          {activeNav === 'generate' && (
            <SessionAssetsPanel assets={sessionAssets} />
          )}
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
