/**
 * 设置持久化：JSON 文件存储（照搬 v1 会话存储的原子写方案）。
 * - 结构 { comfyui: { baseUrl: string } }
 * - 写入采用原子写（tmp + rename），避免半写损坏
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AppSettings {
  comfyui: {
    baseUrl: string;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
  },
};

export function readSettings(file: string): AppSettings {
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) return { ...DEFAULT_SETTINGS };
    const comfyui = data.comfyui && typeof data.comfyui === 'object' ? data.comfyui : {};
    return {
      comfyui: {
        baseUrl:
          typeof comfyui.baseUrl === 'string' && comfyui.baseUrl.trim()
            ? comfyui.baseUrl.trim()
            : DEFAULT_SETTINGS.comfyui.baseUrl,
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(file: string, s: AppSettings): AppSettings {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, file);
  return s;
}
