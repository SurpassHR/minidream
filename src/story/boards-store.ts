// 剧本项目（Story Boards）：项目容器 = 项目级系统提示词 + RAG 知识库。
// 每个项目一套完全自定义的提示词（storyTeller / storySummarize；未定义键回退内置默认），
// 以及一组知识库素材（引用全局素材库的 txt 资产 id，RAG 向量检索用）。
// 持久化到 <projectDir>/.director/story-boards.json；缺失/损坏视为空库（防御式），
// 空库在 listBoards 时自动落一个 Minimax-H3 Prompt Writer 默认板（保证会话有归组目标）。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DirectorError } from '../types.js';

export interface StoryBoardPrompts {
  storyTeller?: string;      // 未定义/空 = 回退内置默认（roles.ts）
  storySummarize?: string;
}

export interface StoryBoard {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  systemPrompts: StoryBoardPrompts;
  ragEnabled: boolean;
  ragAssets: string[];       // 素材库 asset id（txt 文本知识文件）
}

export const DEFAULT_BOARD_NAME = 'Minimax-H3 Prompt Writer';
const LEGACY_DEFAULT_BOARD_NAME = '未命名项目';

function boardsFile(projectDir: string): string {
  return join(projectDir, '.director', 'story-boards.json');
}

function newId(): string {
  return `b-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function defaultBoard(): StoryBoard {
  const now = Date.now();
  return {
    id: newId(), name: DEFAULT_BOARD_NAME, createdAt: now, updatedAt: now,
    systemPrompts: {}, ragEnabled: false, ragAssets: [],
  };
}

function sanitizePrompts(p: unknown): StoryBoardPrompts {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return {};
  const out: StoryBoardPrompts = {};
  for (const key of ['storyTeller', 'storySummarize'] as const) {
    const v = (p as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) out[key] = v;
  }
  return out;
}

function sanitizeBoard(raw: Partial<StoryBoard>): StoryBoard | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : DEFAULT_BOARD_NAME,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    systemPrompts: sanitizePrompts(raw.systemPrompts),
    ragEnabled: raw.ragEnabled === true,
    ragAssets: Array.isArray(raw.ragAssets) ? raw.ragAssets.filter((x): x is string => typeof x === 'string') : [],
  };
}

export function readBoards(projectDir: string): StoryBoard[] {
  const f = boardsFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (!Array.isArray(data)) return [];
    return data.map(sanitizeBoard).filter((b): b is StoryBoard => b !== null);
  } catch {
    return [];
  }
}

function writeBoards(projectDir: string, boards: StoryBoard[]): StoryBoard[] {
  const f = boardsFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(boards, null, 2), 'utf8');
  renameSync(tmp, f);
  return boards;
}

// 列表：空库自动落默认板；兼容迁移未自定义的旧默认板名称。
export function listBoards(projectDir: string): StoryBoard[] {
  const boards = readBoards(projectDir);
  if (boards.length === 0) return writeBoards(projectDir, [defaultBoard()]);
  const migrated = boards.map((board) => {
    const isUntouchedLegacyDefault =
      board.name === LEGACY_DEFAULT_BOARD_NAME &&
      Object.keys(board.systemPrompts).length === 0 &&
      !board.ragEnabled &&
      board.ragAssets.length === 0;
    return isUntouchedLegacyDefault ? { ...board, name: DEFAULT_BOARD_NAME, updatedAt: Date.now() } : board;
  });
  if (migrated.some((board, i) => board.name !== boards[i]!.name)) return writeBoards(projectDir, migrated);
  return boards;
}

export function findBoard(projectDir: string, id: string): StoryBoard | undefined {
  return readBoards(projectDir).find((b) => b.id === id);
}

export function createBoard(projectDir: string, name: string): StoryBoard[] {
  const boards = readBoards(projectDir);
  const b = defaultBoard();
  const t = (name ?? '').trim();
  if (t) b.name = Array.from(t).slice(0, 40).join('');
  b.createdAt = Date.now();
  b.updatedAt = b.createdAt;
  boards.push(b);
  return writeBoards(projectDir, boards);
}

export function renameBoard(projectDir: string, id: string, name: string): StoryBoard[] {
  const boards = readBoards(projectDir);
  const b = boards.find((x) => x.id === id);
  if (!b) throw new DirectorError('BOARD_NOT_FOUND', `剧本项目不存在: ${id}`);
  const t = (name ?? '').trim();
  if (t) b.name = Array.from(t).slice(0, 40).join('');
  b.updatedAt = Date.now();
  return writeBoards(projectDir, boards);
}

export function deleteBoard(projectDir: string, id: string): StoryBoard[] {
  const boards = readBoards(projectDir);
  const next = boards.filter((x) => x.id !== id);
  if (next.length === boards.length) {
    throw new DirectorError('BOARD_NOT_FOUND', `剧本项目不存在: ${id}`);
  }
  return writeBoards(projectDir, next);
}

// 保存项目级系统提示词：整体替换传入键（键未传 = 清空回退内置默认）；返回更新后的 board
export function saveBoardPrompts(projectDir: string, id: string, prompts: StoryBoardPrompts): StoryBoard {
  const boards = readBoards(projectDir);
  const b = boards.find((x) => x.id === id);
  if (!b) throw new DirectorError('BOARD_NOT_FOUND', `剧本项目不存在: ${id}`);
  b.systemPrompts = sanitizePrompts(prompts);
  b.updatedAt = Date.now();
  writeBoards(projectDir, boards);
  return b;
}

function updateBoard(projectDir: string, id: string, fn: (b: StoryBoard) => void): StoryBoard {
  const boards = readBoards(projectDir);
  const b = boards.find((x) => x.id === id);
  if (!b) throw new DirectorError('BOARD_NOT_FOUND', `剧本项目不存在: ${id}`);
  fn(b);
  b.updatedAt = Date.now();
  writeBoards(projectDir, boards);
  return b;
}

export function setBoardRagEnabled(projectDir: string, id: string, enabled: boolean): StoryBoard {
  return updateBoard(projectDir, id, (b) => { b.ragEnabled = enabled; });
}

export function addBoardRagAsset(projectDir: string, id: string, assetId: string): StoryBoard {
  return updateBoard(projectDir, id, (b) => {
    if (!b.ragAssets.includes(assetId)) b.ragAssets.push(assetId);
  });
}

export function removeBoardRagAsset(projectDir: string, id: string, assetId: string): StoryBoard {
  return updateBoard(projectDir, id, (b) => {
    b.ragAssets = b.ragAssets.filter((a) => a !== assetId);
  });
}
