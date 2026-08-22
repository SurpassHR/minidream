import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ChatMessage,
  ChatStage,
  GenerationOutput,
  TaskItem,
  ToolCallData,
  ActionCardData,
} from '../api';

/* ==================== 工具函数 ==================== */

/* ==================== 子组件 ==================== */

function AgentAvatar({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="12" fill="#00cae0" />
      <rect x="8" y="10" width="24" height="17" rx="3.5" fill="white" />
      <path d="M8 15.5h24M13 10v5.5M27 10v5.5" stroke="#00a1c2" strokeWidth="1.6" />
      <path d="m24.5 21.5 3 3-3 3" stroke="#00a1c2" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17.5" cy="24.5" r="3" fill="#00a1c2" />
    </svg>
  );
}

/* ==================== Markdown 渲染 ==================== */

function MarkdownContent({ content, animate }: { content: string; animate?: boolean }) {
  // 流式 chunk 到达后直接渲染，保持 v1 的首字节体验；不再叠加二次打字机动画。
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {animate && <span className="cursor-blink" />}
    </div>
  );
}

/* ==================== 思维链（可折叠） ==================== */

function ThinkingChain({
  thinking,
  durationMs,
  live,
}: {
  thinking: string;
  durationMs?: number;
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!live) return;
    startRef.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [live]);

  if (!thinking.trim()) return null;

  const seconds = durationMs ? Math.round(durationMs / 1000) : elapsed;

  return (
    <div className={`thinking-chain${expanded ? ' expanded' : ''}`}>
      <button className="thinking-toggle" onClick={() => setExpanded(e => !e)}>
        <svg className="thinking-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 5.5 7 9.5l4-4"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="thinking-label">
          {live
            ? `思考中… (${elapsed}s)`
            : seconds > 0
              ? `已深度思考 (${seconds}秒)`
              : '深度思考过程'}
        </span>
        {live && (
          <span className="thinking-dots">
            <i /><i /><i />
          </span>
        )}
      </button>
      {expanded && (
        <div className="thinking-logs">
          <div className="thinking-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== 工具调用状态卡片 ==================== */

function ToolCallsView({ toolCalls }: { toolCalls: ToolCallData[] }) {
  if (!toolCalls || toolCalls.length === 0) return null;
  // 过滤掉内部环境发现类工具，仅向用户展示有意义的业务工具调用
  const displayCalls = toolCalls.filter(tc => !['mcp', 'bash', 'read', 'edit', 'write', 'fffind', 'ffgrep'].includes(tc.name));
  if (displayCalls.length === 0) return null;

  return (
    <div className="tool-calls-container">
      {displayCalls.map((tc, idx) => {
        const isDone = tc.result !== undefined;
        let label = `调用工具: ${tc.name}`;
        if (tc.name === 'generation.submit') {
          const wf = (tc.args?.workflowId as string) || '';
          label = wf.includes('video') ? '🎬 正在创建 MiniMax H3 视频生成任务…' : '🎨 正在创建 Krea2 图像生成任务…';
        } else if (tc.name === 'workflow.list') {
          label = '🔍 正在适配生图/视频工作流…';
        } else if (tc.name === 'generation.status') {
          label = '⏳ 正在同步生成进度…';
        } else if (tc.name === 'generation.cancel') {
          label = '🛑 正在请求取消任务…';
        }

        return (
          <div key={tc.callId ?? idx} className={`tool-call-chip${isDone ? ' done' : ' active'}`}>
            <span className="tool-call-icon">{isDone ? '✓' : '⚡'}</span>
            <span className="tool-call-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ==================== 统一任务卡片 (TaskCard) ==================== */

function TaskCardItem({
  task,
  onCancel,
}: {
  task: TaskItem;
  onCancel?: (taskId: string) => void;
}) {
  const isQueued = task.status === 'queued';
  const isRunning = task.status === 'running';
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed' || task.status === 'interrupted';
  const isCanceled = task.status === 'canceled';

  const activeStage = task.stages.find(s => s.status === 'active') || task.stages[task.stages.length - 1];
  const percent = isCompleted
    ? 100
    : isFailed || isCanceled
      ? 100
      : activeStage?.progress ?? (isQueued ? 0 : 5);

  const stageName = isQueued
    ? '排队等待 GPU 调度...'
    : activeStage?.name || (isRunning ? '生成渲染中...' : '任务完成');

  return (
    <div className={`task-card task-status-${task.status}`}>
      <div className="task-card-head">
        <div className="task-card-title-group">
          <span className="task-card-type">
            {task.type === 'video_generation' ? '🎬 MiniMax 视频生成' : '🎨 Krea2 图像生成'}
          </span>
          <span className="task-card-id">#{task.id.slice(0, 8)}</span>
        </div>
        <span className={`task-badge badge-${task.status}`}>
          {isQueued && '排队中'}
          {isRunning && '渲染中'}
          {isCompleted && '已完成'}
          {isFailed && '失败'}
          {isCanceled && '已取消'}
        </span>
      </div>

      {/* 进度条 */}
      <div className="task-card-progress">
        <div
          className={`task-card-bar ${isCanceled ? 'cancelled' : ''} ${isFailed ? 'failed' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="task-card-footer">
        <div className="task-card-stage-info">
          <span className="task-stage-name">{stageName}</span>
          {activeStage?.totalSteps && activeStage.totalSteps > 0 && (
            <span className="task-step-count">
              ({activeStage.step ?? 0}/{activeStage.totalSteps} 步 · {Math.round(percent)}%)
            </span>
          )}
        </div>

        {(isQueued || isRunning) && onCancel && (
          <button className="task-cancel" onClick={() => onCancel(task.id)}>
            取消任务
          </button>
        )}
      </div>

      {task.error && <div className="task-card-error">错误: {task.error}</div>}
    </div>
  );
}

/* ==================== 动作卡片 (ActionCard) ==================== */

function ActionCardItem({
  card,
  onAction,
}: {
  card: ActionCardData;
  onAction?: (card: ActionCardData) => void;
}) {
  return (
    <div className="action-card">
      <div className="action-card-head">
        <div className="action-card-badge">分镜 / 创作建议</div>
        <div className="action-card-title">{card.title}</div>
      </div>
      <div className="action-card-prompt">{card.prompt}</div>
      {card.workflowId && (
        <div className="action-card-meta">
          <span>工作流: {card.workflowId}</span>
        </div>
      )}
      <div className="action-card-foot">
        <button className="action-card-submit-btn" onClick={() => onAction?.(card)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 2.5l8 4.5-8 4.5v-9z" fill="currentColor" />
          </svg>
          一键生成此分镜
        </button>
      </div>
    </div>
  );
}

/* ==================== 生成结果渲染 ==================== */

function GenerationOutputsView({ outputs }: { outputs: GenerationOutput[] }) {
  if (!outputs?.length) return null;
  const images = outputs.filter(o => o.kind === 'image');
  const videos = outputs.filter(o => o.kind === 'video');
  const texts = outputs.filter(o => o.kind === 'text');

  return (
    <div className="generation-results">
      {images.length > 0 && (
        <div className="result-grid">
          {images.map((img, i) => (
            <figure key={`${img.url ?? i}`} className="result-figure">
              <img className="result-img" src={img.url} alt={img.label ?? `生成图片 ${i + 1}`} loading="lazy" />
              {img.label && <figcaption>{img.label}</figcaption>}
            </figure>
          ))}
        </div>
      )}
      {videos.length > 0 && (
        <div className="result-videos">
          {videos.map((v, i) => (
            <div key={`${v.url ?? i}`} className="result-video-wrap">
              <video className="result-video" src={v.url} controls playsInline preload="metadata" />
              {v.label && <div className="result-video-label">{v.label}</div>}
            </div>
          ))}
        </div>
      )}
      {texts.length > 0 && (
        <div className="result-texts">
          {texts.map((t, i) => (
            <pre key={i} className="result-text">{t.text}</pre>
          ))}
        </div>
      )}
    </div>
  );
}

/* ==================== 旧 Stage 兼容 TaskCard ==================== */

function LegacyTaskCard({
  stage,
  cancelled,
  onCancel,
}: {
  stage: ChatStage;
  cancelled: boolean;
  onCancel?: () => void;
}) {
  const p = stage.progress ?? { completed: 0, total: 1 };
  const percent = cancelled ? 100 : Math.min(100, (p.completed / Math.max(1, p.total)) * 100);
  return (
    <div className="task-card">
      <div className="task-card-head">
        <span className="task-card-type">{stage.taskLabel ?? '生成中…'}</span>
        <span className="task-card-count">
          ({p.completed}/{p.total})
        </span>
      </div>
      <div className="task-card-progress">
        <div className={`task-card-bar${cancelled ? ' cancelled' : ''}`} style={{ width: `${percent}%` }} />
      </div>
      {stage.queued && !cancelled && (
        <div className="task-card-queued">
          <span>排队中...</span>
          <em>{stage.queueLabel ?? '1 个任务排队中'}</em>
          {onCancel && (
            <button className="task-cancel" onClick={onCancel}>
              取消生成
            </button>
          )}
        </div>
      )}
      {cancelled && <div className="task-card-cancelled">已取消生成</div>}
    </div>
  );
}

/* ==================== 助手消息主体 ==================== */

function AssistantMessageBody({
  message,
  live,
  onRegenerate,
  onCancelJob,
  onCancelTask,
  onActionCard,
  index,
}: {
  message: ChatMessage;
  live: boolean;
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onActionCard?: (card: ActionCardData) => void;
  index: number;
}) {
  // 1. 新流式架构属性
  const hasThinking = Boolean(message.thinking && message.thinking.length > 0);
  const hasToolCalls = Boolean(message.toolCalls && message.toolCalls.length > 0);
  const hasTasks = Boolean(message.tasks && message.tasks.length > 0);
  const hasActionCards = Boolean(message.actionCards && message.actionCards.length > 0);

  // 2. 提取任务产物
  const taskOutputs: GenerationOutput[] = [];
  if (message.tasks) {
    for (const t of message.tasks) {
      if (t.outputs) {
        for (const out of t.outputs) {
          taskOutputs.push({
            kind: out.kind,
            url: out.url,
            label: out.filename,
          });
        }
      }
    }
  }

  // 3. 旧 stage 兼容
  const stages = message.stages;
  const legacyThinkingLogs = stages?.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : [])) ?? [];
  const legacyTaskStage = stages?.find(s => s.type === 'task');
  const legacyDoneStage = stages?.find(s => s.type === 'done');
  const legacyErrorStage = stages?.find(s => s.type === 'error');

  const allOutputs = [...taskOutputs, ...(legacyDoneStage?.outputs ?? [])];

  return (
    <div className="assistant-stages">
      {/* 思考链 (Thinking Chain) */}
      {hasThinking && (
        <ThinkingChain
          thinking={message.thinking!}
          durationMs={message.thinkingDurationMs}
          live={live && !message.content && !hasTasks}
        />
      )}

      {/* 旧版 Thinking 兼容 */}
      {!hasThinking && legacyThinkingLogs.length > 0 && (
        <div className="thinking-chain">
          <div className="thinking-logs">
            {legacyThinkingLogs.map((log, i) => (
              <div key={i} className="thinking-log-item">
                <span className="thinking-step">{i + 1}</span>
                <span className="thinking-text">{log}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 工具调用小标签 */}
      {hasToolCalls && <ToolCallsView toolCalls={message.toolCalls!} />}

      {/* 正在运行中的统一任务卡片 */}
      {hasTasks && (
        <div className="tasks-container">
          {message.tasks!.map(task => (
            <TaskCardItem key={task.id} task={task} onCancel={onCancelTask} />
          ))}
        </div>
      )}

      {/* 旧版 TaskCard 兼容 */}
      {legacyTaskStage && !hasTasks && (
        <LegacyTaskCard
          stage={legacyTaskStage}
          cancelled={legacyTaskStage.cancelled ?? false}
          onCancel={message.jobId ? () => onCancelJob?.(message.jobId!) : undefined}
        />
      )}

      {/* 动作建议卡片 (Action Cards) */}
      {hasActionCards && (
        <div className="action-cards-container">
          {message.actionCards!.map((card, idx) => (
            <ActionCardItem key={idx} card={card} onAction={onActionCard} />
          ))}
        </div>
      )}

      {/* 正文内容 (Markdown 打字机) */}
      {message.content ? (
        <MarkdownContent content={message.content} animate={live} />
      ) : (
        /* 当既没有内容、没有思维链、也没有任务时，在气泡内显示平滑呼吸打字指示器 */
        !hasThinking && !hasTasks && !legacyThinkingLogs.length && !legacyTaskStage && live && (
          <div className="chat-typing-inline">
            <span className="chat-typing">
              <i />
              <i />
              <i />
            </span>
          </div>
        )
      )}

      {/* 错误展示 */}
      {legacyErrorStage && <div className="chat-error">{legacyErrorStage.logs?.join('\n')}</div>}

      {/* 底部操作区（重新生成） */}
      {!live && (
        <div className="chat-done-actions">
          <button className="chat-regenerate" onClick={() => onRegenerate?.(index)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M12 7a5 5 0 1 1-1.46-3.54M12 2.5V6H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            重新生成
          </button>
        </div>
      )}
    </div>
  );
}

/* ==================== 提取助手消息中的生成产物 ==================== */
function extractOutputs(message: ChatMessage): GenerationOutput[] {
  const outputs: GenerationOutput[] = [];
  if (message.tasks) {
    for (const t of message.tasks) {
      if (t.outputs) {
        for (const out of t.outputs) {
          outputs.push({
            kind: out.kind,
            url: out.url,
            label: out.filename,
          });
        }
      }
    }
  }
  if (message.stages) {
    for (const s of message.stages) {
      if (s.outputs) outputs.push(...s.outputs);
    }
  }
  return outputs;
}

/* ==================== 主组件 ==================== */

export default function ChatView({
  messages,
  liveIndex,
  onRegenerate,
  onCancelJob,
  onCancelTask,
  onActionCard,
}: {
  messages: ChatMessage[];
  liveIndex?: number | null;
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onActionCard?: (card: ActionCardData) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div className="chat">
      {messages.map((m, i) => {
        const outputs = extractOutputs(m);
        return m.role === 'user' ? (
          <div key={i} className="chat-row user">
            <div className="chat-bubble user">
              <div className="bubble-content">{m.content}</div>
            </div>
          </div>
        ) : (
          <div key={i} className="chat-row assistant">
            <div className="chat-avatar">
              <AgentAvatar />
            </div>
            <div className="chat-assistant-container">
              {/* 对话气泡：包含思维链、导演阐述文字与任务进度 */}
              <div className="chat-bubble assistant">
                <AssistantMessageBody
                  message={m}
                  live={liveIndex === i || (!m.content && !m.tasks?.length && !m.stages?.length)}
                  onRegenerate={onRegenerate}
                  onCancelJob={onCancelJob}
                  onCancelTask={onCancelTask}
                  onActionCard={onActionCard}
                  index={i}
                />
              </div>

              {/* 独立的图像/视频媒体元素：完全与对话气泡分离，独立全宽展示 */}
              {outputs.length > 0 && <GenerationOutputsView outputs={outputs} />}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
