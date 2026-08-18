import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addBoardRagAsset, createBoard, deleteBoard, findBoard, listBoards,
  removeBoardRagAsset, renameBoard, saveBoardPrompts, setBoardRagEnabled,
  DEFAULT_BOARD_NAME,
} from './boards-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-boards-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('boards-store 剧本项目', () => {
  it('空库列表自动落「未命名项目」默认板', () => {
    const boards = listBoards(dir);
    expect(boards).toHaveLength(1);
    expect(boards[0]!.name).toBe(DEFAULT_BOARD_NAME);
    expect(boards[0]!.systemPrompts).toEqual({});
    expect(boards[0]!.ragEnabled).toBe(false);
    // 再次读取稳定（已落盘）
    expect(listBoards(dir)[0]!.id).toBe(boards[0]!.id);
  });

  it('创建 / 重命名 / 查找 / 删除', () => {
    const created = createBoard(dir, '星尘历险记');
    const b = created.find((x) => x.name === '星尘历险记');
    expect(b).toBeTruthy();
    // 重命名
    const renamed = renameBoard(dir, b!.id, '星尘历险记 v2');
    expect(renamed.find((x) => x.id === b!.id)?.name).toBe('星尘历险记 v2');
    // 查找
    expect(findBoard(dir, b!.id)?.name).toBe('星尘历险记 v2');
    // 未知 id 抛错
    expect(() => renameBoard(dir, 'nope', 'x')).toThrow();
    // 删除
    const after = deleteBoard(dir, b!.id);
    expect(after.find((x) => x.id === b!.id)).toBeUndefined();
    expect(() => deleteBoard(dir, b!.id)).toThrow();
  });

  it('保存项目级系统提示词：整体替换，空串键清空回退默认', () => {
    const b = listBoards(dir)[0]!;
    const saved = saveBoardPrompts(dir, b.id, { storyTeller: '你是星尘历险记的编剧', storySummarize: '' });
    expect(saved.systemPrompts).toEqual({ storyTeller: '你是星尘历险记的编剧' });
    // 再次整体替换：storyTeller 清空
    const saved2 = saveBoardPrompts(dir, b.id, { storyTeller: '', storySummarize: '六步格式' });
    expect(saved2.systemPrompts).toEqual({ storySummarize: '六步格式' });
    // 非 string 值过滤
    const saved3 = saveBoardPrompts(dir, b.id, { storyTeller: 123 as never });
    expect(saved3.systemPrompts).toEqual({});
  });

  it('RAG：开关 / 添加 / 去重 / 移除', () => {
    const b = listBoards(dir)[0]!;
    expect(setBoardRagEnabled(dir, b.id, true).ragEnabled).toBe(true);
    const added = addBoardRagAsset(dir, b.id, 'a1');
    addBoardRagAsset(dir, b.id, 'a1'); // 去重
    expect(added.ragAssets).toEqual(['a1']);
    const removed = removeBoardRagAsset(dir, b.id, 'a1');
    expect(removed.ragAssets).toEqual([]);
    expect(() => setBoardRagEnabled(dir, 'nope', true)).toThrow();
  });
});
