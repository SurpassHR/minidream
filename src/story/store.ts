// story-teller 向导进度：按项目持久化到 <projectDir>/.director/story.json
// （与 chat.json 同级；缺失/损坏视为空进度，原子写 tmp+rename 防半写）
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STORY_STEPS } from './steps.js';

export interface StoryProgress {
  step: number;                        // 当前步骤索引（0..5）
  answers: Record<string, string>;     // 每步答案（按步骤 id）
  completedAt: string | null;          // 完成时间 ISO；null=未完成
}

function storyFile(projectDir: string): string {
  return join(projectDir, '.director', 'story.json');
}

export function readStory(projectDir: string): StoryProgress {
  const f = storyFile(projectDir);
  if (!existsSync(f)) return { step: 0, answers: {}, completedAt: null };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as StoryProgress;
    return {
      step: data.step ?? 0,
      answers: data.answers && typeof data.answers === 'object' ? data.answers : {},
      completedAt: data.completedAt ?? null,
    };
  } catch {
    return { step: 0, answers: {}, completedAt: null };
  }
}

function writeStory(projectDir: string, story: StoryProgress): StoryProgress {
  const f = storyFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(story, null, 2), 'utf8');
  renameSync(tmp, f);
  return story;
}

// 合并保存：只更新传入字段，step 钳制到 [0, STORY_STEPS.length-1]
export function saveStory(
  projectDir: string,
  patch: { step?: number; answers?: Record<string, string> },
): StoryProgress {
  const story = readStory(projectDir);
  if (patch.step !== undefined) {
    story.step = Math.min(Math.max(Math.round(patch.step), 0), STORY_STEPS.length - 1);
  }
  if (patch.answers) story.answers = { ...story.answers, ...patch.answers };
  return writeStory(projectDir, story);
}

export function completeStory(projectDir: string, completedAt: string): StoryProgress {
  const story = readStory(projectDir);
  story.completedAt = completedAt;
  return writeStory(projectDir, story);
}

// 全部答案汇总为 Markdown 故事文档（complete 接口入库前组装）
// 小节标题用步骤短标签（与测试断言一致：## 主题 / ## 主角 / ## 配角 / ## 冲突 / ## 场景 / ## 结局）
const STEP_TITLES: Record<string, string> = {
  theme: '主题', protagonist: '主角', support: '配角',
  antagonist: '冲突', scenes: '场景', ending: '结局',
};

export function buildStoryMarkdown(projectName: string, answers: Record<string, string>): string {
  const lines = [`# ${projectName} · 故事设定`, ''];
  for (const step of STORY_STEPS) {
    const answer = (answers[step.id] ?? '').trim();
    lines.push(`## ${STEP_TITLES[step.id] ?? step.question}`, '', answer || '（未填写）', '');
  }
  return lines.join('\n');
}
