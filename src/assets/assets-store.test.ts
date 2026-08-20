import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assetDirectoryPath, deleteAsset, importAssetFile, importAssetText, listAssets,
  readAssetText, replaceAssetFile, setAssetCaption, updateAsset,
} from './assets-store.js';

describe('assets-store', () => {
  it('项目级隔离与素材文件导入', () => {
    const projA = mkdtempSync(join(tmpdir(), 'proj-a-'));
    const projB = mkdtempSync(join(tmpdir(), 'proj-b-'));
    const tmpSrc = mkdtempSync(join(tmpdir(), 'src-'));

    try {
      const srcTxt = join(tmpSrc, 'test.txt');
      writeFileSync(srcTxt, 'hello a', 'utf8');

      const recA = importAssetFile(projA, srcTxt);
      expect(recA.name).toBe('test.txt');
      expect(recA.kind).toBe('txt');
      expect(listAssets(projA)).toHaveLength(1);
      expect(listAssets(projB)).toHaveLength(0);

      const text = readAssetText(projA, recA.id);
      expect(text).toBe('hello a');

      // 更新文本
      updateAsset(projA, recA.id, { content: 'hello a updated' });
      expect(readAssetText(projA, recA.id)).toBe('hello a updated');

      // 导入到 B
      const recB = importAssetText(projB, 'b.txt', 'hello b');
      expect(listAssets(projA)).toHaveLength(1);
      expect(listAssets(projB)).toHaveLength(1);
      expect(readAssetText(projB, recB.id)).toBe('hello b');

      // 删除 A
      deleteAsset(projA, recA.id);
      expect(listAssets(projA)).toHaveLength(0);
      expect(listAssets(projB)).toHaveLength(1);
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
      rmSync(tmpSrc, { recursive: true, force: true });
    }
  });

  it('设置图像 caption 并联动更新', () => {
    const proj = mkdtempSync(join(tmpdir(), 'proj-caption-'));
    const tmpSrc = mkdtempSync(join(tmpdir(), 'src-'));
    try {
      const srcImg = join(tmpSrc, 'hero.png');
      writeFileSync(srcImg, 'fakepng', 'utf8');
      const rec = importAssetFile(proj, srcImg);

      const withCaption = setAssetCaption(proj, rec.id, '银发骑士');
      expect(withCaption.caption).toBe('银发骑士');
      expect(listAssets(proj)[0]?.caption).toBe('银发骑士');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(tmpSrc, { recursive: true, force: true });
    }
  });
});
