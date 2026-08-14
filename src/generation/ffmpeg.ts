import { spawn } from 'node:child_process';
import { DirectorError } from '../types.js';

export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

export function extractLastFrame(videoPath: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-y', '-sseof', '-0.1', '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', outPath,
    ]);
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('error', (err) => reject(new DirectorError('INVALID_PATCH', `ffmpeg 启动失败: ${err.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new DirectorError('INVALID_PATCH', `末帧抽取失败: ${stderr.slice(-300)}`));
    });
  });
}
