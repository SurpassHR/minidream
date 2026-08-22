import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore } from './drafts.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-drafts-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DraftStore', () => {
  it('拒绝相对输出目录', () => {
    expect(() => new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: 'drafts' })).toThrow(/绝对路径/);
  });

  it('保存媒体到绝对目录并原子更新索引', async () => {
    const outputDir = join(dir, 'nested', 'drafts');
    const indexFile = join(dir, 'drafts.json');
    const store = new DraftStore({ indexFile, outputDir });

    const record = await store.saveFromBuffer({
      taskId: 'task-1',
      kind: 'image',
      sourceName: '../unsafe.png',
      mime: 'image/png',
      data: Buffer.from('png-data'),
    });

    expect(record.path.startsWith(outputDir)).toBe(true);
    expect(record.filename).not.toContain('..');
    expect(readFileSync(record.path, 'utf8')).toBe('png-data');
    expect(store.list()).toEqual([record]);
    expect(existsSync(`${indexFile}.tmp`)).toBe(false);
  });

  it('删除草稿时同时删除索引和物理文件', async () => {
    const store = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const record = await store.saveFromBuffer({ kind: 'video', sourceName: 'clip.mp4', data: Buffer.from('video') });

    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeUndefined();
    expect(existsSync(record.path)).toBe(false);
    expect(store.delete(record.id)).toBe(false);
  });
});
