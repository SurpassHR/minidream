import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { readSettings } from '../settings/settings-store.js';
import { DirectorError, type AssetKind, type AssetRecord } from '../types.js';

// 素材库目录用函数式求值（每次操作读取当前 HOME）：
// 模块级常量会在加载时定死路径，导致 vi.stubEnv('HOME') 测试隔离失效并污染真实 ~/.director
function defaultAssetDir(): string {
  return join(homedir(), '.director', 'assets');
}

function assetDir(): string {
  const configured = readSettings().assetsDir.trim();
  return configured ? resolve(configured) : defaultAssetDir();
}

// 素材库的真实目录，供后端调用系统文件管理器；路径不直接返回给浏览器。
export function assetDirectoryPath(): string {
  return assetDir();
}

// 将当前素材库完整迁移到新目录；目标必须不存在或为空，避免静默覆盖用户文件。
export function migrateAssetDirectory(targetPath: string): void {
  const source = assetDir();
  const target = targetPath.trim() ? resolve(targetPath) : defaultAssetDir();
  if (source === target) return;
  if (target.startsWith(`${source}${sep}`)) {
    throw new DirectorError('FILE_CONFLICT', '素材库目标目录不能位于当前素材库目录内部');
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new DirectorError('FILE_CONFLICT', `素材库目标目录必须为空：${target}`);
  }
  mkdirSync(target, { recursive: true });
  if (!existsSync(source)) return;
  const entries = readdirSync(source);
  for (const name of entries) {
    if (!statSync(join(source, name)).isFile()) {
      throw new DirectorError('FILE_CONFLICT', `素材库包含不支持迁移的目录：${name}`);
    }
  }
  for (const name of entries) {
    copyFileSync(join(source, name), join(target, name));
  }
  // 复制完整素材库后清理旧目录，避免旧默认目录继续占位导致无法迁回。
  rmSync(source, { recursive: true, force: true });
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

// 把 caption 写回图像素材记录：卡片缩略图下方/预览可直接展示，不依赖同名 txt 素材
// （同名 txt 仍会生成，作为图像同目录的可复用文件；两者内容一致）
export function setAssetCaption(id: string, caption: string): AssetRecord {
  const rec = findAsset(id);
  const next = { ...rec, caption };
  writeIndex(readIndex().map((r) => r.id === id ? next : r));
  return next;
}

// 按名称 upsert 文本素材：已存在同名 txt 时覆盖其内容（如图像 captioning 重复执行），
// 否则走 importAssetText 新建。同名判定基于显示名（与图像同基名的 caption 可幂等更新）
export function upsertAssetText(name: string, content: string): AssetRecord {
  const records = readIndex();
  const existing = records.find((r) => r.kind === 'txt' && r.name === name);
  if (existing) {
    writeFileSync(join(assetDir(), `${existing.id}${existing.ext}`), content, 'utf8');
    const next = { ...existing, size: Buffer.byteLength(content, 'utf8'), importedAt: Date.now() };
    writeIndex(records.map((r) => r.id === existing.id ? next : r));
    return next;
  }
  return importAssetText(name, content);
}

function findAsset(id: string): AssetRecord {
  const rec = readIndex().find((r) => r.id === id);
  if (!rec) throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${id}`);
  return rec;
}

function captionTextName(imageName: string): string {
  return `${basename(imageName, extname(imageName))}.txt`;
}

export function updateAsset(id: string, patch: { name?: string; content?: string }): AssetRecord {
  const rec = findAsset(id);
  const records = readIndex();
  const next = { ...rec };
  let linkedCaption: AssetRecord | undefined;
  let linkedCaptionName = '';
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new DirectorError('INVALID_PATCH', '素材名称不能为空');
    next.name = name;
    // caption 文本由图像基名生成：图像改名时同步更新其同名 txt，避免侧边栏隐藏规则失效。
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
    writeFileSync(join(assetDir(), `${rec.id}${rec.ext}`), patch.content, 'utf8');
    next.size = Buffer.byteLength(patch.content, 'utf8');
  }
  const updated = records.map((item) => {
    if (item.id === id) return next;
    if (linkedCaption && item.id === linkedCaption.id) return { ...item, name: linkedCaptionName };
    return item;
  });
  writeIndex(updated);
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
