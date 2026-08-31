import { describe, expect, it, afterEach } from 'vitest';
import { resolveRuntimeRoot } from './paths.js';

const KEYS = ['MINIDREAM_DATA_ROOT', 'MINIDREAM_SKILLS_ROOT', 'MINIDREAM_BUNDLED_WORKFLOWS'];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe('resolveRuntimeRoot', () => {
  it('未设置环境变量时回退到默认路径', () => {
    expect(resolveRuntimeRoot('MINIDREAM_DATA_ROOT', '/default/data')).toBe('/default/data');
    expect(resolveRuntimeRoot('MINIDREAM_SKILLS_ROOT', '/default/skills')).toBe('/default/skills');
  });

  it('设置环境变量时返回其绝对路径（做路径规范化和相对解析）', () => {
    process.env.MINIDREAM_DATA_ROOT = '/tmp/sandbox/data';
    expect(resolveRuntimeRoot('MINIDREAM_DATA_ROOT', '/default/data')).toBe('/tmp/sandbox/data');
  });

  it('环境变量是相对路径时解析为基于 cwd 的绝对路径', () => {
    process.env.MINIDREAM_SKILLS_ROOT = './sandbox/skills';
    const resolved = resolveRuntimeRoot('MINIDREAM_SKILLS_ROOT', '/default/skills');
    expect(resolved.endsWith('sandbox/skills')).toBe(true);
    expect(resolved.startsWith('/')).toBe(true);
  });
});