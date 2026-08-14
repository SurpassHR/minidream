import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { listWorkspace, readWorkspaceFile, searchWorkspace } from './accessor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-ws-'));
  mkdirSync(join(dir, 'mmh3_prompts', 'elf_and_goblin'), { recursive: true });
  mkdirSync(join(dir, '.director'), { recursive: true });
  writeFileSync(join(dir, 'mmh3_prompts', 'elf_and_goblin', 'global_prompt.txt'), 'Fine elven slave for sale', 'utf8');
  writeFileSync(join(dir, 'mmh3_prompts', 'elf_and_goblin', 'shot_01.md'), '# SHOT 01\n牵绳慢步', 'utf8');
  writeFileSync(join(dir, '.director', 'project.json'), '{}', 'utf8');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('WorkspaceAccessor', () => {
  it('listWorkspace 递归列出并排除 .director', () => {
    const list = listWorkspace(dir);
    expect(list).toContain('mmh3_prompts/');
    expect(list).toContain('mmh3_prompts/elf_and_goblin/global_prompt.txt');
    expect(list.some((p) => p.startsWith('.director'))).toBe(false);
  });

  it('listWorkspace 目录条目唯一且全部以斜杠结尾', () => {
    const list = listWorkspace(dir);
    // 目录条目（以 / 结尾）必须唯一
    const dirs = list.filter((p) => p.endsWith('/'));
    expect(new Set(dirs).size).toBe(dirs.length);
    // 不存在裸目录项（不带斜杠出现在结果中）
    expect(list).not.toContain('mmh3_prompts');
    expect(list).not.toContain('mmh3_prompts/elf_and_goblin');
    // 预期目录集合完整
    expect(dirs).toContain('mmh3_prompts/');
    expect(dirs).toContain('mmh3_prompts/elf_and_goblin/');
  });

  it('searchWorkspace 文件名匹配', () => {
    const hits = searchWorkspace(dir, '*global*');
    expect(hits.map((h) => h.path)).toContain('mmh3_prompts/elf_and_goblin/global_prompt.txt');
  });

  it('searchWorkspace 内容匹配返回命中行', () => {
    const hits = searchWorkspace(dir, '牵绳慢步');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe('mmh3_prompts/elf_and_goblin/shot_01.md');
    expect(hits[0]?.line).toBe(2);
  });

  it('readWorkspaceFile 读取文本', () => {
    expect(readWorkspaceFile(dir, 'mmh3_prompts/elf_and_goblin/shot_01.md')).toContain('牵绳慢步');
  });

  it('readWorkspaceFile 阻止路径穿越', () => {
    expect(() => readWorkspaceFile(dir, '../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'FILE_CONFLICT' }),
    );
  });
});
