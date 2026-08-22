export interface RailItem {
  id: string;
  label: string;
  /** icon key resolved by the frontend */
  icon: string;
  active?: boolean;
}

export interface GenerateData {
  rail: {
    items: RailItem[];
  };
  sidebar: {
    createLabel: string;
    newChatLabel: string;
  };
  hero: {
    title: string;
  };
  composer: {
    placeholder: string;
    /** 生成偏好面板 */
    preferences: {
      types: string[];
      ratios: string[];
      /** 生成尺寸（MP）：滑块范围与步长 */
      sizes: { min: number; max: number; step: number; default: number };
      models: string[];
    };
  };
}

/**
 * Agent 生成过程中的一个阶段。
 * 前端按顺序渲染：思考日志 → 任务进行中 → 完成。
 */
export interface ChatStage {
  /** 阶段类型 */
  type: 'thinking' | 'task' | 'done' | 'error';
  /** 思考日志段落（thinking/done 阶段多段文本） */
  logs?: string[];
  /** 任务进度：completed/total，如 (0/1) */
  progress?: { completed: number; total: number };
  /** 任务类型文案，如「视频生成中…」 */
  taskLabel?: string;
  /** 是否排队中 */
  queued?: boolean;
  /** 排队数量文案，如「1 个任务排队中」 */
  queueLabel?: string;
  /** 消耗积分 */
  credits?: number;
  /** 建议按钮文案 */
  suggestion?: string;
  /** 是否已取消 */
  cancelled?: boolean;
  /** 生成结果（图片/视频/文本），done 阶段携带 */
  outputs?: GenerationOutput[];
}

/** 生成结果条目 */
export interface GenerationOutput {
  kind: 'image' | 'video' | 'text';
  label?: string;
  /** 图片/视频经服务端代理的访问地址 */
  url?: string;
  filename?: string;
  subfolder?: string;
  type?: string;
  /** 文本输出的内容 */
  text?: string;
}

export interface ChatReply {
  title: string;
  /** 最终回复文本 */
  reply?: string;
  /** 分阶段渲染数据 */
  stages?: ChatStage[];
  /** ComfyUI 生成任务 id（存在则前端订阅 SSE 实时更新） */
  jobId?: string;
  promptId?: string;
}
