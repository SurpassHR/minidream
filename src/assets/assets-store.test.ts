import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { deleteAsset, importAssetFile, importAssetText, listAssets, readAssetText, replaceAssetFile, updateAsset } from './assets-store.js';

let realHome: string;
let fakeHome: string;
let srcDir: string;

beforeEach(() => {
  // 隔离 HOME，素材库落到临时目录，避免污染真实 ~/.director
  realHome = homedir();
  fakeHome = mkdtempSync(join(tmpdir(), 'director-home-'));
  srcDir = mkdtempSync(join(tmpdir(), 'director-src-'));
  vi.stubEnv('HOME', fakeHome);
});
afterEach(() => {
  vi.stubEnv('HOME', realHome);
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

describe('assets-store', () => {
  it('importAssetFile 按扩展名判 kind 并复制入库', () => {
    const src = join(srcDir, 'KF0.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const rec = importAssetFile(src);
    expect(rec.kind).toBe('img');
    expect(rec.name).toBe('KF0.png');
    expect(existsSync(join(fakeHome, '.director', 'assets', `${rec.id}.png`))).toBe(true);
    expect(listAssets()).toHaveLength(1);
  });

  it('不支持的类型抛 FILE_CONFLICT', () => {
    const src = join(srcDir, 'x.exe');
    writeFileSync(src, 'x');
    expect(() => importAssetFile(src)).toThrowError(
      expect.objectContaining({ code: 'FILE_CONFLICT' }),
    );
  });

  it('importAssetText 写 txt 素材且可读回', () => {
    const rec = importAssetText('我的提示词', 'Fine elven slave for sale');
    expect(rec.kind).toBe('txt');
    expect(readAssetText(rec.id)).toBe('Fine elven slave for sale');
  });

  it('updateAsset 编辑文本名称与内容', () => {
    const rec = importAssetText('旧名称.md', '旧内容');
    const updated = updateAsset(rec.id, { name: '新名称.md', content: '新内容' });
    expect(updated.name).toBe('新名称.md');
    expect(updated.size).toBe(Buffer.byteLength('新内容', 'utf8'));
    expect(readAssetText(rec.id)).toBe('新内容');
  });

  it('replaceAssetFile 替换同类型文件并更新大小与扩展名', () => {
    const original = join(srcDir, 'old.png');
    const replacement = join(srcDir, 'new.webp');
    writeFileSync(original, Buffer.from([1]));
    writeFileSync(replacement, Buffer.from([1, 2, 3, 4]));
    const rec = importAssetFile(original);
    const updated = replaceAssetFile(rec.id, replacement);
    expect(updated.kind).toBe('img');
    expect(updated.name).toBe('new.webp');
    expect(updated.ext).toBe('.webp');
    expect(updated.size).toBe(4);
    expect(existsSync(join(fakeHome, '.director', 'assets', `${rec.id}.png`))).toBe(false);
    expect(existsSync(join(fakeHome, '.director', 'assets', `${rec.id}.webp`))).toBe(true);
  });

  it('更新素材类型不一致时拒绝替换', () => {
    const image = join(srcDir, 'image.png');
    const text = join(srcDir, 'note.txt');
    writeFileSync(image, Buffer.from([1]));
    writeFileSync(text, 'text');
    const rec = importAssetFile(image);
    expect(() => replaceAssetFile(rec.id, text)).toThrowError(
      expect.objectContaining({ code: 'FILE_CONFLICT' }),
    );
  });

  it('deleteAsset 删除文件与索引', () => {
    const rec = importAssetText('a', 'b');
    deleteAsset(rec.id);
    expect(listAssets()).toHaveLength(0);
    expect(() => readAssetText(rec.id)).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });
});
