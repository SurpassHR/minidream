import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractLastFrame } from './ffmpeg.js';

// 同步探测 ffmpeg：无 ffmpeg 环境跳过用例，有 ffmpeg 环境真实执行
// （vitest 2.x 的 describe.skipIf 是同步布尔求值，不能用 async 工厂）
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-ffmpeg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!HAS_FFMPEG)('ffmpeg', () => {
  it('extractLastFrame 抽取末帧 PNG', async () => {
    // 先用 ffmpeg 生成 1 秒测试视频（16 帧：帧率过低时 -sseof -0.1 定位不到帧，
    // 真实使用场景为 24fps 视频，16fps 已能可靠命中末帧）
    const video = join(dir, 'test.mp4');
    const gen = spawnSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=16',
      '-t', '1', '-pix_fmt', 'yuv420p', video,
    ]);
    expect(gen.status).toBe(0);
    const out = join(dir, 'last.png');
    const p = await extractLastFrame(video, out);
    expect(p).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it('无效视频抛 INVALID_PATCH', async () => {
    const bad = join(dir, 'bad.mp4');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(bad, 'not a video');
    await expect(extractLastFrame(bad, join(dir, 'x.png'))).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });
});
