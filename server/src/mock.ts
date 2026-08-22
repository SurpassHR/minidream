import type { ChatReply, GenerateData } from './data.js';

const skillImg = (n: number) => `/assets/images/img-${String(n).padStart(2, '0')}.webp`;

/**
 * 页面内容基于即梦AI「生成」页抓取的结构复刻，
 * 品牌文案替换为「导演工作台」，技能卡内容围绕剧本/分镜/视频创作。
 */
export const generateData: GenerateData = {
  rail: {
    items: [
      { id: 'inspiration', label: '灵感', icon: 'inspiration' },
      { id: 'generate', label: '生成', icon: 'generate', active: true },
      { id: 'drafts', label: '草稿', icon: 'drafts' },
      { id: 'assets', label: '资产', icon: 'assets' },
      { id: 'canvas', label: '画布', icon: 'canvas' },
    ],
  },
  sidebar: {
    createLabel: '开启创作',
    newChatLabel: '新对话',
  },
  hero: {
    title: '你好，想创作什么？',
  },
  skills: [
    {
      id: 'director-storyboard',
      tag: '热门技能',
      title: '叙事短片导演分镜',
      desc: '以森海荧光导演分镜方法论产出叙事短片：导演意图书、九列分镜表、4~15s Clip 表与逐 Clip 提示词，直至成片。',
      image: skillImg(11),
    },
    {
      id: 'series-generate',
      tag: '热门技能',
      title: '系列套图生成',
      desc: '将母版提示词、参考图、角色设定抽象为稳定的系列视觉母体，生成风格统一但变量清晰的系列图片。',
      image: skillImg(14),
    },
    {
      id: 'ecommerce-video',
      tag: '热门技能',
      title: '爆款电商短视频题材创意',
      desc: '电商短视频创作助手，支持多题材选择、时长配置，每个题材生成5组差异化方案。',
      image: skillImg(20),
    },
  ],
  composer: {
    placeholder: '输入想法、剧本或上传参考，支持 “/”使用技能，添加主体，和Agent一起创作',
    agentOptions: ['Agent 模式', '图片生成', '视频生成', '音乐生成', '配音生成', '数字人', '动作模仿'],
    preferences: {
      types: ['图片', '视频'],
      ratios: ['智能', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      sizes: { min: 0.5, max: 10, step: 0.5, default: 1 },
      models: ['图片 4.0'],
    },
    skills: [
      { id: 'story', name: '剧情短片', tag: '官方', desc: '帮你自动生成故事大纲、分镜脚本并产出短片' },
      { id: 'ecommerce', name: '电商套图', desc: '生成风格统一的商品全套视觉素材，适用于各大电商平台' },
      { id: 'poster', name: '海报设计', desc: '生成更有创意的海报内容，擅长营销场景和节日热点' },
      { id: 'brand', name: '品牌设计', desc: '根据公司名称、业务与客群，生成品牌 Logo 与视觉方案' },
    ],
    skillFooter: ['用 Agent 创建技能', '管理技能'],
  },
};

/**
 * Mock chat：按关键词返回分阶段生成流程（思考日志 → 任务进行中 → 完成），
 * 复刻即梦生成页的中间态结构。
 */
export function mockReply(message: string): ChatReply {
  const m = message.trim();
  const title = m.slice(0, 12) + (m.length > 12 ? '…' : '');
  const isVideo = /视频|短片|成片|生成视频/.test(m);
  const isScript = /剧本|脚本|故事|剧情|分镜|镜头/.test(m);

  // 分阶段生成流程：思考日志 → 任务 → 完成
  const stages = [
    {
      type: 'thinking' as const,
      logs: [
        '收到，我来分析你的创作意图。这个题材非常适合用短片呈现，我会先把氛围感和故事结构搭起来。',
        '我先加载视频创作优化技巧，之后直接为你生成这段画面。',
        isVideo
          ? '检测到当前模型为会员专属版本，我将自动切换为非会员可用的视频生成模型来完成这段画面，效果同样可以保证。'
          : '已加载技能：视频Prompt Skill，正在为你组织分镜与画面描述。',
      ],
    },
    {
      type: 'task' as const,
      progress: { completed: 0, total: 1 },
      taskLabel: '视频生成中…',
      queued: true,
      queueLabel: '1 个任务排队中',
    },
    {
      type: 'done' as const,
      logs: [
        isScript
          ? '已完成。这段故事的剧本大纲、分镜脚本都已就位，可直接进入成片环节。如果对氛围、动作细节有调整想法，随时告诉我。'
          : '已提交生成，这段画面正在渲染中，完成后你就可以直接查看成片效果啦。如果后续对画面氛围、动作细节有调整想法，随时告诉我。',
      ],
      credits: 75,
      suggestion: isScript ? '按这个剧本开始生成分镜' : '按这个场景开始生成视频',
    },
  ];

  // 生成最终回复文本（供侧栏/简化场景使用）
  const reply =
    stages[2]?.logs?.[0] ??
    '已完成。这段创作已进入生成流程，完成后可直接查看成片效果。';

  return { title, reply, stages };
}
