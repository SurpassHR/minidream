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
      { id: 'assets', label: '资产', icon: 'assets' },
      { id: 'canvas', label: '画布', icon: 'canvas' },
    ],
    loginLabel: '登录',
    pointsLabel: '领积分',
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
      id: 'script',
      tag: '热门技能',
      title: '剧本创作',
      desc: '输入故事灵感或一句话大纲，自动生成完整剧本：角色设定、场景描述、对白与三幕结构，支持导演风格定制',
      image: skillImg(11),
    },
    {
      id: 'storyboard',
      tag: '热门技能',
      title: '分镜设计',
      desc: '将剧本自动拆解为分镜：镜头语言、景别、运镜与时长设计，产出可直接交付 AI 视频生成的九列分镜表',
      image: skillImg(14),
    },
    {
      id: 'video',
      tag: '热门技能',
      title: '视频生成',
      desc: '基于分镜与提示词批量生成视频片段，支持首尾帧参考、风格锁定与多版本对比挑选，直达成片',
      image: skillImg(20),
    },
  ],
  composer: {
    placeholder: '输入想法、剧本或上传参考，支持 “/” 使用技能，添加主体，和 Agent 一起创作',
    modes: ['Agent 模式', '自动', '使用技能'],
  },
};

/** Mock chat: keyword-based canned replies, falling back to a generic one. */
export function mockReply(message: string): ChatReply {
  const m = message.trim();
  let reply: string;
  if (/剧本|脚本|故事|剧情/.test(m)) {
    reply =
      '好的，我来帮你写剧本。已按三幕结构起草：角色设定、核心冲突与关键场景都已就位。\n\n' +
      '下一步可以让我：\n1. 展开对白与分场\n2. 直接拆分为九列分镜表\n3. 按指定导演风格（如森海荧光、赛博朋克）重写';
  } else if (/分镜|镜头|运镜|storyboard/i.test(m)) {
    reply =
      '正在把剧本拆解为分镜。我将按镜头语言输出：景别（远/全/中/近/特）、运镜（推/拉/摇/移/跟）、时长与画面描述。\n\n' +
      '分镜表生成后，可直接逐条生成 AI 视频片段，并支持上一段末帧作为下一段参考图。';
  } else if (/视频|短片|成片|生成/.test(m)) {
    reply =
      '已进入视频生成流程：基于分镜与提示词批量出片。默认使用「导演版 2.5」模型，支持首尾帧参考与风格锁定。\n\n' +
      '生成完成后我会给出每个片段的预览与版本对比，方便你挑选最佳效果。';
  } else {
    reply =
      '收到，已记录你的创作意图。我会以 Agent 模式推进：先产出方案大纲，再逐步细化到剧本、分镜与成片。\n\n' +
      '你可以告诉我更多细节，比如题材、风格、时长，或直接说「生成视频」开始创作。';
  }
  const title = m.slice(0, 12) + (m.length > 12 ? '…' : '');
  return { reply, title };
}
