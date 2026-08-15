// story-teller 向导步骤定义（预定义 + AI 辅助模式；spec 第 4.1 节）
export interface StoryStep {
  id: string;
  question: string;
  hint: string;
  required: boolean;
}

export const STORY_STEPS: StoryStep[] = [
  { id: 'theme', question: '故事主题是什么？', hint: '一句话主题（如「精灵与哥布林的战争与和解」）', required: true },
  { id: 'protagonist', question: '主角是谁？', hint: '身份、性格、目标', required: true },
  { id: 'support', question: '配角有哪些？', hint: '每个配角一句话（可留空）', required: false },
  { id: 'antagonist', question: '冲突来自哪里？', hint: '对手/障碍/内在矛盾', required: true },
  { id: 'scenes', question: '故事发生在哪些场景？', hint: '每个场景一句（可作为物体设计器的种子）', required: true },
  { id: 'ending', question: '结局如何？', hint: '开放/圆满/反转', required: true },
];
