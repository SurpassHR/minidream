import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildAgentPrompt, runAgentStream } from './bridge.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-agent-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('buildAgentPrompt', () => {
  it('包含 chips 上下文、画布摘要与用户消息', () => {
    const p = buildAgentPrompt({
      message: '分析分镜节奏',
      chips: [{ name: 'shot_02', content: '动作：拽绳转身' }],
      graphSummary: '3 分镜 · 4 关键帧',
    });
    expect(p).toContain('[shot_02]');
    expect(p).toContain('拽绳转身');
    expect(p).toContain('3 分镜 · 4 关键帧');
    expect(p).toContain('分析分镜节奏');
  });

  it('包含 @ 素材引用上下文', () => {
    const p = buildAgentPrompt({
      message: '结合素材分析',
      chips: [],
      graphSummary: '空画布',
      assetContext: '文本素材「世界观.md」：精灵王国位于北境',
    });
    expect(p).toContain('世界观.md');
    expect(p).toContain('精灵王国位于北境');
  });
});

describe('runAgentStream', () => {
  it('流式输出 mock agent 分段回复', async () => {
    vi.stubEnv('MOCK_REPLY', 'hello world from mock');
    const mockScript = resolve('src/agent/mock-agent.mjs');
    const chunks: string[] = [];
    const r = await runAgentStream(['node', mockScript], 'anything', (c) => { chunks.push(c); });
    expect(r.exitCode).toBe(0);
    expect(chunks.join('')).toBe('hello world from mock');
    expect(chunks.length).toBeGreaterThan(1); // 分段流式
  });

  it('将 system prompt 作为 pi 参数传入，stdin 只保留用户上下文', async () => {
    vi.stubEnv('MOCK_ECHO_INPUT', '1');
    const mockScript = resolve('src/agent/mock-agent.mjs');
    const chunks: string[] = [];
    const r = await runAgentStream(
      ['node', mockScript],
      '当前用户消息与历史',
      (c) => { chunks.push(c); },
      { systemPrompt: '你是严格的故事编剧' },
    );
    expect(r.exitCode).toBe(0);
    const echoed = JSON.parse(chunks.join('').trim().replace(/^ECHO_INPUT /, '')) as { args: string[]; stdin: string };
    expect(echoed.args).toEqual(expect.arrayContaining(['--system-prompt', '你是严格的故事编剧']));
    expect(echoed.stdin).toBe('当前用户消息与历史');
    expect(echoed.stdin).not.toContain('你是严格的故事编剧');
  });
});
