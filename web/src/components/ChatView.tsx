import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { openDraftLocation, type ChatMessage, type ChatStage, type GenerationOutput, type TaskItem, type ToolCallData, type ActionCardData } from '../api';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

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
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
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
      {expanded && (          <div className="thinking-logs">
          <div className="thinking-body">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{thinking}</ReactMarkdown>
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

/* ==================== 生成占位动画（复刻即梦，仅渐变动画容器） ==================== */

/** 单一任务的渐变动画容器：排队/生成中显示，完成后淡出让位给图像 */
function TaskLoadingMedia({
  queued,
  percent,
  onCancel,
  cancelLabel,
}: {
  queued: boolean;
  percent: number;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div className="task-card-media task-card-media-loading">
      <div className="task-loading-glow" />
      <video
        className="task-loading-animation"
        src="/assets/record-loading-animation.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
      />
      <span className="task-progress-badge">
        {queued ? '排队中...' : `生成中... ${Math.round(percent)}%`}
      </span>
      {onCancel && (
        <button className="task-cancel task-cancel-overlay" onClick={onCancel}>
          {cancelLabel ?? '取消任务'}
        </button>
      )}
    </div>
  );
}

/** 气泡下方的任务媒体区域：进行中渲染渐变动画，完成后交叉过渡到图像 */
function TaskMediaRegion({
  tasks,
  legacyStage,
  done,
  outputs,
  onCancelTask,
  onCancelJob,
  jobId,
  onOpenImage,
}: {
  tasks: TaskItem[];
  legacyStage?: ChatStage;
  done: boolean;
  outputs: GenerationOutput[];
  onCancelTask?: (taskId: string) => void;
  onCancelJob?: (jobId: string) => void;
  jobId?: string;
  onOpenImage?: (img: LightboxImage) => void;
}) {
  const activeTask = tasks.find(t => t.status === 'queued' || t.status === 'running');
  const anyTaskActive = Boolean(activeTask);
  // 旧 stage 兼容：存在 task stage 且未取消即视为进行中
  const legacyActive = Boolean(legacyStage && !legacyStage.cancelled && !done);

  const isActive = anyTaskActive || legacyActive;

  // 任务从进行中 -> 完成时，保留动画容器播放淡出，再卸载
  const [leaving, setLeaving] = useState(false);
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevActiveRef.current && !isActive) {
      setLeaving(true);
      const t = setTimeout(() => setLeaving(false), 650);
      return () => clearTimeout(t);
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  const showLoading = isActive || leaving;
  if (!showLoading && outputs.length === 0) return null;

  // 进行中的任务数据（取第一个 active 任务或 legacy stage）
  let queued = false;
  let percent = 5;
  let cancelFn: (() => void) | undefined;
  let cancelLabel: string | undefined;
  if (activeTask) {
    queued = activeTask.status === 'queued';
    const activeStage =
      activeTask.stages.find(s => s.status === 'active') || activeTask.stages[activeTask.stages.length - 1];
    percent = activeStage?.progress ?? (queued ? 0 : 5);
    if (onCancelTask) {
      cancelFn = () => onCancelTask(activeTask!.id);
      cancelLabel = '取消任务';
    }
  } else if (legacyStage && !legacyStage.cancelled) {
    queued = Boolean(legacyStage.queued);
    const p = legacyStage.progress ?? { completed: 0, total: 1 };
    percent = Math.min(100, (p.completed / Math.max(1, p.total)) * 100);
    if (onCancelJob && jobId) {
      cancelFn = () => onCancelJob(jobId);
      cancelLabel = '取消生成';
    }
  }

  return (
    <div className={`task-media-region${leaving ? ' leaving' : ''}${showLoading ? ' has-loading' : ''}`}>
      {/* 底层：生成结果（完成后淡入） */}
      {outputs.length > 0 && <GenerationOutputsView outputs={outputs} onOpenImage={onOpenImage} />}
      {/* 上层：渐变动画覆盖（进行中显示，完成时淡出让位） */}
      {showLoading && (
        <TaskLoadingMedia queued={queued} percent={percent} onCancel={cancelFn} cancelLabel={cancelLabel} />
      )}
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

/** 从草稿文件 URL 中提取 id（非草稿产物返回 null，不展示打开位置按钮） */
function draftIdOf(url?: string): string | null {
  const m = url?.match(/\/api\/drafts\/([^/]+)\/file/);
  return m ? (m[1] ?? null) : null;
}

function GenerationOutputsView({
  outputs,
  onOpenImage,
}: {
  outputs: GenerationOutput[];
  onOpenImage?: (img: LightboxImage) => void;
}) {
  if (!outputs?.length) return null;
  const images = outputs.filter(o => o.kind === 'image');
  const videos = outputs.filter(o => o.kind === 'video');
  const texts = outputs.filter(o => o.kind === 'text');

  return (
    <div className="generation-results">
      {images.length > 0 && (
        <div className="result-grid">
          {images.map((img, i) => {
            const draftId = draftIdOf(img.url);
            const alt = img.label ?? `生成图片 ${i + 1}`;
            return (
              <figure key={`${img.url ?? i}`} className="result-figure">
                <div className="result-media">
                  <img
                    className="result-img"
                    src={img.url}
                    alt={alt}
                    loading="lazy"
                    onClick={() => {
                      if (img.url) onOpenImage?.({ url: img.url, alt });
                    }}
                  />
                  {draftId && (
                    <button
                      className="result-open-location"
                      title="打开文件位置"
                      aria-label="打开文件位置"
                      onClick={e => {
                        e.stopPropagation();
                        void openDraftLocation(draftId).catch(() => undefined);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
                        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3l1.5 1.5H14A1.5 1.5 0 0 1 15.5 7v6A1.5 1.5 0 0 1 14 14.5H4A1.5 1.5 0 0 1 2.5 13v-7.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                        <path d="M5.5 9.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
                {img.label && <figcaption>{img.label}</figcaption>}
              </figure>
            );
          })}
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

/* ==================== 助手消息主体 ==================== */

function AssistantMessageBody({
  message,
  live,
  onRegenerate,
  onActionCard,
  index,
}: {
  message: ChatMessage;
  live: boolean;
  onRegenerate?: (index: number) => void;
  onActionCard?: (card: ActionCardData) => void;
  index: number;
}) {
  // 1. 新流式架构属性
  const hasThinking = Boolean(message.thinking && message.thinking.length > 0);
  const hasToolCalls = Boolean(message.toolCalls && message.toolCalls.length > 0);
  const hasTasks = Boolean(message.tasks && message.tasks.length > 0);
  const hasActionCards = Boolean(message.actionCards && message.actionCards.length > 0);

  // 旧 stage 兼容（仅用于思考日志/错误展示）
  const stages = message.stages;
  const legacyThinkingLogs = stages?.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : [])) ?? [];
  const legacyTaskStage = stages?.find(s => s.type === 'task');
  const legacyErrorStage = stages?.find(s => s.type === 'error');

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
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);

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
        const legacyTaskStage = m.stages?.find(s => s.type === 'task');
        const legacyDoneStage = m.stages?.find(s => s.type === 'done');
        // 任务是否已全部结束（新式任务全部非 queued/running，或旧式已 done/取消）
        const allTasksDone =
          (m.tasks?.length ?? 0) > 0
            ? m.tasks!.every(t => t.status !== 'queued' && t.status !== 'running')
            : Boolean(legacyDoneStage || legacyTaskStage?.cancelled);
        const hasAnyTask = (m.tasks?.length ?? 0) > 0 || Boolean(legacyTaskStage);

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
              {/* 对话气泡：包含思维链、导演阐述文字 */}
              <div className="chat-bubble assistant">
                <AssistantMessageBody
                  message={m}
                  live={liveIndex === i || (!m.content && !m.tasks?.length && !m.stages?.length)}
                  onRegenerate={onRegenerate}
                  onActionCard={onActionCard}
                  index={i}
                />
              </div>

              {/* 气泡下方的任务媒体区域：生成中渐变动画 → 完成后过渡到图像 */}
              {hasAnyTask && (
                <TaskMediaRegion
                  tasks={m.tasks ?? []}
                  legacyStage={legacyTaskStage}
                  done={allTasksDone}
                  outputs={outputs}
                  onCancelTask={onCancelTask}
                  onCancelJob={onCancelJob}
                  jobId={m.jobId}
                  onOpenImage={setLightbox}
                />
              )}

              {/* 无任务的纯媒体消息（旧版 done 产物）仍独立全宽展示 */}
              {!hasAnyTask && outputs.length > 0 && (
                <GenerationOutputsView outputs={outputs} onOpenImage={setLightbox} />
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
