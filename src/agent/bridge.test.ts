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
});
