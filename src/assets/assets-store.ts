import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DirectorError, type AssetKind, type AssetRecord } from '../types.js';

export function assetDirectoryPath(projectDir: string): string {
  const dir = join(projectDir, '.director', 'assets');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function indexPath(projectDir: string): string {
  return join(assetDirectoryPath(projectDir), 'index.json');
}

function kindOf(ext: string): AssetKind {
  if (['.txt', '.md'].includes(ext)) return 'txt';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'img';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'vid';
  throw new DirectorError('FILE_CONFLICT', `不支持的素材类型: ${ext}`);
}

function readIndex(projectDir: string): AssetRecord[] {
  const p = indexPath(projectDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AssetRecord[];
  } catch {
    return [];
  }
}

function writeIndex(projectDir: string, records: AssetRecord[]): void {
  const dir = assetDirectoryPath(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath(projectDir), JSON.stringify(records, null, 2), 'utf8');
}

export function listAssets(projectDir: string): AssetRecord[] {
  return readIndex(projectDir);
}

export function importAssetFile(projectDir: string, sourcePath: string): AssetRecord {
  const ext = extname(sourcePath).toLowerCase();
  const kind = kindOf(ext);
  const rec: AssetRecord = {
    id: randomUUID(),
    kind,
    name: basename(sourcePath),
    ext,
    size: statSync(sourcePath).size,
    importedAt: Date.now(),
  };
  const dir = assetDirectoryPath(projectDir);
  mkdirSync(dir, { recursive: true });
  copyFileSync(sourcePath, join(dir, `${rec.id}${ext}`));
  const index = readIndex(projectDir);
  index.push(rec);
  writeIndex(projectDir, index);
  return rec;
}

export function importAssetText(projectDir: string, name: string, content: string): AssetRecord {
  const rec: AssetRecord = {
    id: randomUUID(),
    kind: 'txt',
    name,
    ext: '.txt',
    size: Buffer.byteLength(content, 'utf8'),
    importedAt: Date.now(),
  };
  const dir = assetDirectoryPath(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.id}.txt`), content, 'utf8');
  const index = readIndex(projectDir);
  index.push(rec);
  writeIndex(projectDir, index);
  return rec;
}

function findAsset(projectDir: string, id: string): AssetRecord {
  const rec = readIndex(projectDir).find((r) => r.id === id);
  if (!rec) throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${id}`);
  return rec;
}

// 把 caption 写回图像素材记录
export function setAssetCaption(projectDir: string, id: string, caption: string): AssetRecord {
  const rec = findAsset(projectDir, id);
  const next = { ...rec, caption };
  writeIndex(projectDir, readIndex(projectDir).map((r) => r.id === id ? next : r));
  return next;
}

// 按名称 upsert 文本素材
export function upsertAssetText(projectDir: string, name: string, content: string): AssetRecord {
  const records = readIndex(projectDir);
  const existing = records.find((r) => r.kind === 'txt' && r.name === name);
  if (existing) {
    const dir = assetDirectoryPath(projectDir);
    writeFileSync(join(dir, `${existing.id}${existing.ext}`), content, 'utf8');
    const next = { ...existing, size: Buffer.byteLength(content, 'utf8'), importedAt: Date.now() };
    writeIndex(projectDir, records.map((r) => r.id === existing.id ? next : r));
    return next;
  }
  return importAssetText(projectDir, name, content);
}

function captionTextName(imageName: string): string {
  return `${basename(imageName, extname(imageName))}.txt`;
}

export function updateAsset(projectDir: string, id: string, patch: { name?: string; content?: string }): AssetRecord {
  const rec = findAsset(projectDir, id);
  const records = readIndex(projectDir);
  const next = { ...rec };
  let linkedCaption: AssetRecord | undefined;
  let linkedCaptionName = '';
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new DirectorError('INVALID_PATCH', '素材名称不能为空');
    next.name = name;
    if (rec.kind === 'img' && rec.caption && name !== rec.name) {
      const oldCaptionName = captionTextName(rec.name).toLowerCase();
      linkedCaption = records.find((item) => item.kind === 'txt' && item.name.toLowerCase() === oldCaptionName);
      if (linkedCaption) {
        linkedCaptionName = captionTextName(name);
        const conflict = records.find((item) => (
          item.kind === 'txt'
          && item.id !== linkedCaption!.id
          && item.name.toLowerCase() === linkedCaptionName.toLowerCase()
        ));
        if (conflict) throw new DirectorError('FILE_CONFLICT', `caption 文本名称已存在：${linkedCaptionName}`);
      }
    }
  }
  if (patch.content !== undefined) {
    if (rec.kind !== 'txt') throw new DirectorError('FILE_CONFLICT', '只有文本素材可以编辑内容');
    const dir = assetDirectoryPath(projectDir);
    writeFileSync(join(dir, `${rec.id}${rec.ext}`), patch.content, 'utf8');
    next.size = Buffer.byteLength(patch.content, 'utf8');
  }
  const updated = records.map((item) => {
    if (item.id === id) return next;
    if (linkedCaption && item.id === linkedCaption.id) return { ...item, name: linkedCaptionName };
    return item;
  });
  writeIndex(projectDir, updated);
  return next;
}

export function replaceAssetFile(projectDir: string, id: string, sourcePath: string): AssetRecord {
  const rec = findAsset(projectDir, id);
  const ext = extname(sourcePath).toLowerCase();
  const kind = kindOf(ext);
  if (kind !== rec.kind) {
    throw new DirectorError('FILE_CONFLICT', `替换素材类型不一致: 需要 ${rec.kind}，收到 ${kind}`);
  }
  const next = { ...rec, name: basename(sourcePath), ext, size: statSync(sourcePath).size };
  const dir = assetDirectoryPath(projectDir);
  mkdirSync(dir, { recursive: true });
  if (ext !== rec.ext) rmSync(join(dir, `${rec.id}${rec.ext}`), { force: true });
  copyFileSync(sourcePath, join(dir, `${rec.id}${ext}`));
  writeIndex(projectDir, readIndex(projectDir).map((item) => item.id === id ? next : item));
  return next;
}

export function deleteAsset(projectDir: string, id: string): void {
  const rec = findAsset(projectDir, id);
  const dir = assetDirectoryPath(projectDir);
  rmSync(join(dir, `${rec.id}${rec.ext}`), { force: true });
  writeIndex(projectDir, readIndex(projectDir).filter((r) => r.id !== id));
}

export function readAssetText(projectDir: string, id: string): string {
  const rec = findAsset(projectDir, id);
  if (rec.kind !== 'txt') throw new DirectorError('FILE_CONFLICT', `素材不是文本: ${id}`);
  const dir = assetDirectoryPath(projectDir);
  return readFileSync(join(dir, `${rec.id}${rec.ext}`), 'utf8');
}

export function assetFilePath(projectDir: string, id: string): string {
  const rec = findAsset(projectDir, id);
  return join(assetDirectoryPath(projectDir), `${rec.id}${rec.ext}`);
}
