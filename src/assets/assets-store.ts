import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { DirectorError, type AssetKind, type AssetRecord } from '../types.js';

// 素材库目录用函数式求值（每次操作读取当前 HOME）：
// 模块级常量会在加载时定死路径，导致 vi.stubEnv('HOME') 测试隔离失效并污染真实 ~/.director
function assetDir(): string {
  return join(homedir(), '.director', 'assets');
}

function indexPath(): string {
  return join(assetDir(), 'index.json');
}

function kindOf(ext: string): AssetKind {
  if (['.txt', '.md'].includes(ext)) return 'txt';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'img';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'vid';
  throw new DirectorError('FILE_CONFLICT', `不支持的素材类型: ${ext}`);
}

function readIndex(): AssetRecord[] {
  if (!existsSync(indexPath())) return [];
  return JSON.parse(readFileSync(indexPath(), 'utf8')) as AssetRecord[];
}

function writeIndex(records: AssetRecord[]): void {
  mkdirSync(assetDir(), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify(records, null, 2), 'utf8');
}

export function listAssets(): AssetRecord[] {
  return readIndex();
}

export function importAssetFile(sourcePath: string): AssetRecord {
  const ext = extname(sourcePath).toLowerCase();
  const kind = kindOf(ext);
  const rec: AssetRecord = {
    id: randomUUID(),
    kind,
    name: basename(sourcePath),
    ext,
    // 用 statSync 取文件大小（简报原用 readFileSync().length，对大文件会整读入内存）
    size: statSync(sourcePath).size,
    importedAt: Date.now(),
  };
  mkdirSync(assetDir(), { recursive: true });
  copyFileSync(sourcePath, join(assetDir(), `${rec.id}${ext}`));
  const index = readIndex();
  index.push(rec);
  writeIndex(index);
  return rec;
}

export function importAssetText(name: string, content: string): AssetRecord {
  const rec: AssetRecord = {
    id: randomUUID(),
    kind: 'txt',
    name,
    ext: '.txt',
    size: Buffer.byteLength(content, 'utf8'),
    importedAt: Date.now(),
  };
  mkdirSync(assetDir(), { recursive: true });
  writeFileSync(join(assetDir(), `${rec.id}.txt`), content, 'utf8');
  const index = readIndex();
  index.push(rec);
  writeIndex(index);
  return rec;
}

function findAsset(id: string): AssetRecord {
  const rec = readIndex().find((r) => r.id === id);
  if (!rec) throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${id}`);
  return rec;
}

export function updateAsset(id: string, patch: { name?: string; content?: string }): AssetRecord {
  const rec = findAsset(id);
  const next = { ...rec };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new DirectorError('INVALID_PATCH', '素材名称不能为空');
    next.name = name;
  }
  if (patch.content !== undefined) {
    if (rec.kind !== 'txt') throw new DirectorError('FILE_CONFLICT', '只有文本素材可以编辑内容');
    writeFileSync(join(assetDir(), `${rec.id}${rec.ext}`), patch.content, 'utf8');
    next.size = Buffer.byteLength(patch.content, 'utf8');
  }
  const records = readIndex().map((item) => item.id === id ? next : item);
  writeIndex(records);
  return next;
}

export function replaceAssetFile(id: string, sourcePath: string): AssetRecord {
  const rec = findAsset(id);
  const ext = extname(sourcePath).toLowerCase();
  const kind = kindOf(ext);
  if (kind !== rec.kind) {
    throw new DirectorError('FILE_CONFLICT', `替换素材类型不一致: 需要 ${rec.kind}，收到 ${kind}`);
  }
  const next = { ...rec, name: basename(sourcePath), ext, size: statSync(sourcePath).size };
  mkdirSync(assetDir(), { recursive: true });
  if (ext !== rec.ext) rmSync(join(assetDir(), `${rec.id}${rec.ext}`), { force: true });
  copyFileSync(sourcePath, join(assetDir(), `${rec.id}${ext}`));
  writeIndex(readIndex().map((item) => item.id === id ? next : item));
  return next;
}

export function deleteAsset(id: string): void {
  const rec = findAsset(id);
  rmSync(join(assetDir(), `${rec.id}${rec.ext}`), { force: true });
  writeIndex(readIndex().filter((r) => r.id !== id));
}

export function readAssetText(id: string): string {
  const rec = findAsset(id);
  if (rec.kind !== 'txt') throw new DirectorError('FILE_CONFLICT', `素材不是文本: ${id}`);
  return readFileSync(join(assetDir(), `${rec.id}${rec.ext}`), 'utf8');
}

// 素材绝对路径（图片预览/下载用）；未知 id 抛 NODE_NOT_FOUND
export function assetFilePath(id: string): string {
  const rec = findAsset(id);
  return join(assetDir(), `${rec.id}${rec.ext}`);
}
