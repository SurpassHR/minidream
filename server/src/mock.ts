import type { ChatReply, GenerateData } from './data.js';

/**
 * 页面内容基于即梦AI「生成」页抓取的结构复刻，
 * 品牌文案替换为「Minidream」，技能卡内容围绕剧本/分镜/视频创作。
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
  composer: {
    placeholder: '输入想法、剧本或上传参考，和Agent一起创作',
    preferences: {
      types: ['图片', '视频'],
      ratios: ['智能', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      sizes: { min: 0.5, max: 10, step: 0.5, default: 1 },
      models: ['图片 4.0'],
    },
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
