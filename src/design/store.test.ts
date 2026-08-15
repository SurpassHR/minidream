import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesign, deleteDesign, listDesigns, updateDesign } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-design-'));
  mkdirSync(join(dir, '.director'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('design store', () => {
  it('createDesign 新建对象并落盘', () => {
    const d = createDesign(dir, 'character', '精灵骑士');
    expect(d.kind).toBe('character');
    expect(d.status).toBe('draft');
    expect(d.name).toBe('精灵骑士');
    expect(listDesigns(dir)).toHaveLength(1);
  });

  it('非法 kind 抛 INVALID_PATCH', () => {
    expect(() => createDesign(dir, 'weapon' as never, 'x')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('updateDesign 白名单字段更新', () => {
    const d = createDesign(dir, 'scene', '迷雾森林');
    const updated = updateDesign(dir, d.id, {
      description: '雾气弥漫的森林', style: '吉卜力风', template: 'my-t2i',
    });
    expect(updated.description).toBe('雾气弥漫的森林');
    expect(updated.style).toBe('吉卜力风');
    // 白名单外字段被忽略
    const hacked = updateDesign(dir, d.id, { createdAt: 1 } as never);
    expect(hacked.createdAt).toBe(d.createdAt);
  });

  it('updateDesign 未知 id 抛 NODE_NOT_FOUND', () => {
    expect(() => updateDesign(dir, 'nope', { name: 'x' })).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('deleteDesign 删除并落盘', () => {
    const d = createDesign(dir, 'prop', '精灵地图');
    deleteDesign(dir, d.id);
    expect(listDesigns(dir)).toHaveLength(0);
    expect(() => deleteDesign(dir, d.id)).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('design.json 损坏返回空列表（不抛错）', () => {
    writeFileSync(join(dir, '.director', 'design.json'), '{broken', 'utf8');
    expect(listDesigns(dir)).toEqual([]);
  });
});
