import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildSeedMessages, writeSeedExtension, type SeedTurn } from './seed.js';

const TMP_DIR = resolve(process.cwd(), 'data/.test-seed-tmp');

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('buildSeedMessages', () => {
  it('将 system 映射为 user 消息，assistant 保持为 assistant，内容为文本数组', () => {
    const history: SeedTurn[] = [
      { role: 'system', content: '本地协议：禁止提及实现细节' },
      { role: 'assistant', content: '明白，我会遵守协议。' },
      { role: 'user', content: '开始创作' },
    ];

    expect(buildSeedMessages(history)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '本地协议：禁止提及实现细节' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '明白，我会遵守协议。' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '开始创作' }],
      },
    ]);
  });

  it('过滤空白内容，返回空数组时不生成任何消息', () => {
    expect(buildSeedMessages([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '' },
    ])).toEqual([]);
    expect(buildSeedMessages([])).toEqual([]);
  });
});

describe('writeSeedExtension', () => {
  it('生成包含种子消息的 Pi 扩展文件，内容为真实交替 user/assistant 消息', () => {
    const history: SeedTurn[] = [
      { role: 'system', content: '你是一个猫娘' },
      { role: 'assistant', content: '我宣誓：我是一只猫娘。' },
    ];

    const file = writeSeedExtension(history, TMP_DIR);
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);

    const content = readFileSync(file!, 'utf8');
    // 包含序列化的种子消息
    expect(content).toContain('"role": "user"');
    expect(content).toContain('"role": "assistant"');
    expect(content).toContain('你是一个猫娘');
    expect(content).toContain('我宣誓：我是一只猫娘。');
    // 扩展在 context 事件中前置注入种子消息
    expect(content).toContain("pi.on('context'");
    expect(content).toContain('[...SEED, ...event.messages]');
    // 文件扩展名为 .ts（Pi --extension 加载）
    expect(file!.endsWith('.ts')).toBe(true);
  });

  it('无可用种子时返回 null 且不创建文件', () => {
    expect(writeSeedExtension([], TMP_DIR)).toBeNull();
    expect(writeSeedExtension([{ role: 'user', content: '  ' }], TMP_DIR)).toBeNull();
  });
});
