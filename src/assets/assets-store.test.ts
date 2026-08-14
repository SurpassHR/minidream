import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { deleteAsset, importAssetFile, importAssetText, listAssets, readAssetText } from './assets-store.js';

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

  it('deleteAsset 删除文件与索引', () => {
    const rec = importAssetText('a', 'b');
    deleteAsset(rec.id);
    expect(listAssets()).toHaveLength(0);
    expect(() => readAssetText(rec.id)).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });
});
