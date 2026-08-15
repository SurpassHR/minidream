import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORY_STEPS } from './steps.js';
import { buildStoryMarkdown, completeStory, readStory, saveStory } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-story-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('STORY_STEPS', () => {
  it('6 个步骤，id 唯一且必填步正确', () => {
    expect(STORY_STEPS).toHaveLength(6);
    expect(new Set(STORY_STEPS.map((s) => s.id)).size).toBe(6);
    expect(STORY_STEPS.filter((s) => s.required).map((s) => s.id))
      .toEqual(['theme', 'protagonist', 'antagonist', 'scenes', 'ending']);
  });
});

describe('readStory', () => {
  it('文件不存在返回空进度', () => {
    expect(readStory(dir)).toEqual({ step: 0, answers: {}, completedAt: null });
  });

  it('文件损坏返回空进度（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'story.json'), '{broken', 'utf8');
    expect(readStory(dir)).toEqual({ step: 0, answers: {}, completedAt: null });
  });
});

describe('saveStory', () => {
  it('合并写入 answers 并落盘', () => {
    saveStory(dir, { step: 1, answers: { theme: '精灵与哥布林' } });
    saveStory(dir, { answers: { protagonist: '精灵骑士' } });
    const story = readStory(dir);
    expect(story.step).toBe(1);
    expect(story.answers.theme).toBe('精灵与哥布林');
    expect(story.answers.protagonist).toBe('精灵骑士');
    // 原子写：临时文件被 rename，不残留 .tmp
    expect(existsSync(join(dir, '.director', 'story.json.tmp'))).toBe(false);
  });

  it('非法 step（越界/负数）被钳制', () => {
    saveStory(dir, { step: 99 });
    expect(readStory(dir).step).toBe(STORY_STEPS.length - 1);
    saveStory(dir, { step: -3 });
    expect(readStory(dir).step).toBe(0);
  });
});

describe('completeStory', () => {
  it('设置 completedAt', () => {
    completeStory(dir, '2026-08-15T00:00:00.000Z');
    expect(readStory(dir).completedAt).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('buildStoryMarkdown', () => {
  it('按步骤顺序组装 Markdown 文档', () => {
    const md = buildStoryMarkdown('测试项目', {
      theme: '战争与和解', protagonist: '精灵骑士', scenes: '迷雾森林',
    });
    expect(md).toContain('# 测试项目 · 故事设定');
    expect(md).toContain('## 主题\n\n战争与和解');
    expect(md).toContain('## 主角\n\n精灵骑士');
    expect(md).toContain('## 场景\n\n迷雾森林');
    // 未填写的步骤显示占位
    expect(md).toContain('## 结局\n\n（未填写）');
  });
});
