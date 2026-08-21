export interface RailItem {
  id: string;
  label: string;
  /** icon key resolved by the frontend */
  icon: string;
  active?: boolean;
}

export interface SkillCard {
  id: string;
  tag: string;
  title: string;
  desc: string;
  image: string;
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
  skills: SkillCard[];
  composer: {
    placeholder: string;
    /** 创作类型（Agent 模式下拉）选项 */
    agentOptions: string[];
    /** 生成偏好面板 */
    preferences: {
      types: string[];
      ratios: string[];
      models: string[];
    };
    /** 使用技能面板 */
    skills: { id: string; name: string; tag?: string; desc: string }[];
    skillFooter: string[];
  };
}

/**
 * Agent 生成过程中的一个阶段。
 * 前端按顺序渲染：思考日志 → 任务进行中 → 完成。
 */
export interface ChatStage {
  /** 阶段类型 */
  type: 'thinking' | 'task' | 'done';
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
}

export interface ChatReply {
  title: string;
  /** 最终回复文本 */
  reply?: string;
  /** 分阶段渲染数据 */
  stages?: ChatStage[];
}
