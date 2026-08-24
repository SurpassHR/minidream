import { useEffect, useState, useRef, useCallback, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { openDraftLocation, type ChatMessage, type ChatStage, type GenerationOutput, type TaskItem, type ActionCardData, type WorkflowRoute, type ResponseBlock } from '../api';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';
import { getTaskMediaAspectRatio, getTaskMediaLayoutClass } from '../taskMediaRatio';
import { shouldRenderLegacyAssistantContent } from '../responseDisplay';

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
  display = 'collapsed',
}: {
  thinking: string;
  durationMs?: number;
  live: boolean;
  display?: 'collapsed' | 'visible';
}) {
  const [expanded, setExpanded] = useState(display === 'visible');
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    setExpanded(display === 'visible');
  }, [display]);

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

function ResponseBlockView({ block }: { block: ResponseBlock }) {
  const content = block.format === 'code' ? (
    <pre className="response-block-code" data-language={block.language}><code>{block.content}</code></pre>
  ) : block.format === 'markdown' ? (
    <MarkdownContent content={block.content} />
  ) : (
    <div className="response-block-plain">{block.content}</div>
  );

  if (block.container === 'collapsible') {
    return (
      <details className="response-block response-block-collapsible" open={block.defaultOpen}>
        <summary>{block.label || (block.type === 'thinking' ? '深度思考过程' : '回复内容')}</summary>
        <div className="response-block-content">{content}</div>
      </details>
    );
  }
  return (
    <div className="response-block response-block-text">
      {block.label && <div className="response-block-label">{block.label}</div>}
      {content}
    </div>
  );
}

function ResponseBlocksView({ blocks }: { blocks: ResponseBlock[] }) {
  return (
    <div className="response-blocks">
      {blocks.map(block => <ResponseBlockView key={block.id} block={block} />)}
    </div>
  );
}

/* ==================== 工具调用状态卡片 ==================== */

function routeIntentLabel(intent: WorkflowRoute['intent']): string {
  switch (intent) {
    case 'image_upscale': return '图像放大';
    case 'image_to_image': return '图生图';
    case 'image_to_video': return '图生视频';
    case 'text_to_video': return '文生视频';
    case 'text_to_image': return '文生图';
    default: return '未识别';
  }
}

function workflowLabel(id: string): string {
  if (id === 'image_seedvr2_upscale') return 'SeedVR2 图像放大';
  if (id === 'image_krea2_turbo_t2i') return 'Krea2 图像生成';
  if (id.includes('video-minimax')) return 'MiniMax H3 视频生成';
  return id;
}

function extractGenerationPrompts(message: ChatMessage): string[] {
  const prompts = [...(message.generationPrompts || [])];
  for (const call of message.toolCalls || []) {
    const args = call.args || {};
    const nested = call.name === 'mcp' && typeof args.tool === 'string'
      ? (args.args && typeof args.args === 'object' ? args.args as Record<string, unknown> : {})
      : args;
    const isGenerationSubmit = call.name === 'generation.submit'
      || call.name.endsWith('.generation.submit')
      || (call.name === 'mcp' && String(args.tool).endsWith('generation_submit'));
    const prompt = typeof nested.prompt === 'string' ? nested.prompt.trim() : '';
    if (isGenerationSubmit && prompt && !prompts.includes(prompt)) prompts.push(prompt);
  }
  return prompts;
}

function GenerationPromptView({ prompts }: { prompts: string[] }) {
  if (!prompts.length) return null;
  return (
    <div className="generation-prompt-list">
      {prompts.map((prompt, index) => (
        <div className="generation-prompt" key={`${index}-${prompt.slice(0, 24)}`}>
          <div className="generation-prompt-title">生成提示词{prompts.length > 1 ? ` ${index + 1}` : ''}</div>
          <pre className="generation-prompt-code"><code>{prompt}</code></pre>
        </div>
      ))}
    </div>
  );
}

function RouteSummaryView({ routes }: { routes: WorkflowRoute[] }) {
  if (!routes.length) return null;
  return (
    <div className="route-summary-list">
      {routes.map((route, index) => (
        <div className="route-summary" key={route.taskId ?? `${route.requestedWorkflowId}-${route.finalWorkflowId}-${index}`}>
          <div className="route-summary-title">
            <span className="route-summary-icon">↗</span>
            <span>工作流路由</span>
            <span className="route-summary-status">{route.forced ? '规则强制' : 'Agent 选择'}</span>
          </div>
          <div className="route-summary-flow">
            <span>{routeIntentLabel(route.intent)}</span>
            <span className="route-summary-arrow">→</span>
            {route.requestedWorkflowId !== route.finalWorkflowId && (
              <>
                <span className="route-summary-requested">{workflowLabel(route.requestedWorkflowId)}</span>
                <span className="route-summary-arrow">→</span>
              </>
            )}
            <strong>{workflowLabel(route.finalWorkflowId)}</strong>
          </div>
          <div className="route-summary-meta">
            参考图 {route.referenceImageCount} 张
            {route.referenceVideoCount > 0 ? `，参考视频 ${route.referenceVideoCount} 个` : ''}
            {' · '}
            {route.reason}
          </div>
        </div>
      ))}
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
  onCite,
}: {
  tasks: TaskItem[];
  legacyStage?: ChatStage;
  done: boolean;
  outputs: GenerationOutput[];
  onCancelTask?: (taskId: string) => void;
  onCancelJob?: (jobId: string) => void;
  jobId?: string;
  onOpenImage?: (img: LightboxImage) => void;
  onCite?: (img: { url: string; alt: string }) => void;
}) {
  const activeTask = tasks.find(t => t.status === 'queued' || t.status === 'running');
  const anyTaskActive = Boolean(activeTask);
  // 旧 stage 兼容：存在 task stage 且未取消即视为进行中
  const legacyActive = Boolean(legacyStage && !legacyStage.cancelled && !done);

  const isActive = anyTaskActive || legacyActive;
  const mediaTask = activeTask ?? tasks.find(task => task.outputs?.length || task.generationParams || task.params);
  const outputParams = mediaTask?.outputs?.find(output => output.kind === 'image' && output.generation?.params)?.generation?.params
    ?? outputs.find(output => output.kind === 'image' && output.generation?.params)?.generation?.params;
  const mediaRatioSource = mediaTask || outputParams ? { ...mediaTask, outputParams } : undefined;
  const [loadedImageRatio, setLoadedImageRatio] = useState<string>();
  const mediaAspectRatio = loadedImageRatio ?? getTaskMediaAspectRatio(mediaRatioSource);
  const mediaLayoutClass = mediaAspectRatio ? 'has-aspect-ratio' : getTaskMediaLayoutClass(mediaRatioSource);

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
    <div
      className={`task-media-region${leaving ? ' leaving' : ''}${showLoading ? ` has-loading ${mediaLayoutClass}` : ''}`}
      style={mediaAspectRatio ? { '--task-media-aspect-ratio': mediaAspectRatio } as CSSProperties : undefined}
    >
      {/* 底层：生成结果（完成后淡入） */}
      {outputs.length > 0 && <GenerationOutputsView outputs={outputs} onOpenImage={onOpenImage} onCite={onCite} onImageRatio={(width, height) => setLoadedImageRatio(`${width} / ${height}`)} />}
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
  onCite,
  onImageRatio,
}: {
  outputs: GenerationOutput[];
  onOpenImage?: (img: LightboxImage) => void;
  onCite?: (img: { url: string; alt: string }) => void;
  onImageRatio?: (width: number, height: number) => void;
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
                    onLoad={event => {
                      const image = event.currentTarget;
                      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                        onImageRatio?.(image.naturalWidth, image.naturalHeight);
                      }
                    }}
                    onClick={() => {
                      if (img.url) onOpenImage?.({ url: img.url, alt, generation: img.generation });
                    }}
                  />
                  {img.url && (
                    <button
                      className="result-cite"
                      title="引用到输入框（图生图 / 图生视频）"
                      aria-label="引用图片"
                      onClick={e => {
                        e.stopPropagation();
                        onCite?.({ url: img.url!, alt });
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 18 18" fill="none">
                        <path d="M4 3h6.5L14 6.5V15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        <path d="M10.5 3v3.5H14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                        <path d="M6 12.5h6M6 9.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
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
  const thinkingDisplay = message.responsePolicy?.thinking === 'visible' ? 'visible' : 'collapsed';
  const responseBlocks = message.responseBlocks || [];
  const hasResponseBlocks = responseBlocks.length > 0;
  const customResponseActive = message.responseProtocolActive === true;
  const hasResponseThinking = responseBlocks.some(block => block.type === 'thinking');
  const hasTasks = Boolean(message.tasks && message.tasks.length > 0);
  const hasRoutes = Boolean(message.routes && message.routes.length > 0);
  const generationPrompts = extractGenerationPrompts(message);
  const hasGenerationPrompts = generationPrompts.length > 0;
  const hasActionCards = Boolean(message.actionCards && message.actionCards.length > 0);

  // 旧 stage 兼容（仅用于思考日志/错误展示）
  const stages = message.stages;
  const legacyThinkingLogs = stages?.flatMap(s => (s.type === 'thinking' ? s.logs ?? [] : [])) ?? [];
  const legacyTaskStage = stages?.find(s => s.type === 'task');
  const legacyErrorStage = stages?.find(s => s.type === 'error');

  return (
    <div className="assistant-stages">
      {hasResponseBlocks && <ResponseBlocksView blocks={responseBlocks} />}

      {/* 思考链 (Thinking Chain) */}
      {!customResponseActive && !hasResponseBlocks && !hasResponseThinking && hasThinking && (
        <ThinkingChain
          thinking={message.thinking!}
          durationMs={message.thinkingDurationMs}
          live={live && !message.content && !hasTasks}
          display={thinkingDisplay}
        />
      )}

      {/* 旧版 Thinking 兼容 */}
      {!customResponseActive && !hasResponseBlocks && !hasThinking && legacyThinkingLogs.length > 0 && (
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

      {/* 生成提示词预览：在工作流路由和任务状态之前展示 */}
      {!customResponseActive && !hasResponseBlocks && hasGenerationPrompts && <GenerationPromptView prompts={generationPrompts} />}

      {/* 工作流路由摘要 */}
      {!customResponseActive && !hasResponseBlocks && hasRoutes && <RouteSummaryView routes={message.routes!} />}

      {/* 动作建议卡片 (Action Cards) */}
      {hasActionCards && (
        <div className="action-cards-container">
          {message.actionCards!.map((card, idx) => (
            <ActionCardItem key={idx} card={card} onAction={onActionCard} />
          ))}
        </div>
      )}

      {/* 正文内容 (Markdown 打字机) */}
      {shouldRenderLegacyAssistantContent(message.content, customResponseActive, hasResponseBlocks) ? (
        <MarkdownContent content={message.content} animate={live} />
      ) : (
        /* 当既没有内容、没有思维链、也没有任务时，在气泡内显示平滑呼吸打字指示器 */
        !customResponseActive && !hasResponseBlocks && !hasThinking && !hasTasks && !legacyThinkingLogs.length && !legacyTaskStage && live && (
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
            filename: out.filename,
            generation: out.generation,
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
  onCiteImage,
}: {
  messages: ChatMessage[];
  liveIndex?: number | null;
  onRegenerate?: (index: number) => void;
  onCancelJob?: (jobId: string) => void;
  onCancelTask?: (taskId: string) => void;
  onActionCard?: (card: ActionCardData) => void;
  onCiteImage?: (img: { url: string; alt: string }) => void;
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
                  onCite={onCiteImage}
                />
              )}

              {/* 无任务的纯媒体消息（旧版 done 产物）仍独立全宽展示 */}
              {!hasAnyTask && outputs.length > 0 && (
                <GenerationOutputsView outputs={outputs} onOpenImage={setLightbox} onCite={onCiteImage} />
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
