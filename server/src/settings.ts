/**
 * 设置持久化：JSON 文件存储（照搬 v1 会话存储的原子写方案）。
 * - 结构 { comfyui: { baseUrl: string }, imageGen: ImageGenSettings }
 * - 写入采用原子写（tmp + rename），避免半写损坏
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ComfyUISettings {
  baseUrl: string;
}

export interface ImageGenSettings {
  seedMode: 'random' | 'fixed';
  seed: number;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  denoise: number;
  width: number;
  height: number;
}

export interface AppSettings {
  comfyui: ComfyUISettings;
  imageGen: ImageGenSettings;
}

export const DEFAULT_IMAGE_GEN_SETTINGS: ImageGenSettings = {
  seedMode: 'random',
  seed: -1,
  steps: 20,
  cfg: 7.0,
  sampler_name: 'euler',
  scheduler: 'normal',
  denoise: 1.0,
  width: 1024,
  height: 1024,
};

export const DEFAULT_SETTINGS: AppSettings = {
  comfyui: {
    baseUrl: 'http://127.0.0.1:8188',
  },
  imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
};

export function readSettings(file: string): AppSettings {
  if (!existsSync(file)) {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
    };
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) {
      return {
        comfyui: { ...DEFAULT_SETTINGS.comfyui },
        imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
      };
    }
    const comfyui = data.comfyui && typeof data.comfyui === 'object' ? data.comfyui : {};
    const imageGen = data.imageGen && typeof data.imageGen === 'object' ? data.imageGen : {};

    return {
      comfyui: {
        baseUrl:
          typeof comfyui.baseUrl === 'string' && comfyui.baseUrl.trim()
            ? comfyui.baseUrl.trim()
            : DEFAULT_SETTINGS.comfyui.baseUrl,
      },
      imageGen: {
        seedMode: imageGen.seedMode === 'fixed' ? 'fixed' : DEFAULT_IMAGE_GEN_SETTINGS.seedMode,
        seed: typeof imageGen.seed === 'number' && Number.isFinite(imageGen.seed) ? imageGen.seed : DEFAULT_IMAGE_GEN_SETTINGS.seed,
        steps: typeof imageGen.steps === 'number' && imageGen.steps > 0 ? imageGen.steps : DEFAULT_IMAGE_GEN_SETTINGS.steps,
        cfg: typeof imageGen.cfg === 'number' && imageGen.cfg >= 0 ? imageGen.cfg : DEFAULT_IMAGE_GEN_SETTINGS.cfg,
        sampler_name:
          typeof imageGen.sampler_name === 'string' && imageGen.sampler_name.trim()
            ? imageGen.sampler_name.trim()
            : DEFAULT_IMAGE_GEN_SETTINGS.sampler_name,
        scheduler:
          typeof imageGen.scheduler === 'string' && imageGen.scheduler.trim()
            ? imageGen.scheduler.trim()
            : DEFAULT_IMAGE_GEN_SETTINGS.scheduler,
        denoise:
          typeof imageGen.denoise === 'number' && imageGen.denoise >= 0 && imageGen.denoise <= 1
            ? imageGen.denoise
            : DEFAULT_IMAGE_GEN_SETTINGS.denoise,
        width: typeof imageGen.width === 'number' && imageGen.width > 0 ? imageGen.width : DEFAULT_IMAGE_GEN_SETTINGS.width,
        height: typeof imageGen.height === 'number' && imageGen.height > 0 ? imageGen.height : DEFAULT_IMAGE_GEN_SETTINGS.height,
      },
    };
  } catch {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
    };
  }
}

export function writeSettings(file: string, s: AppSettings): AppSettings {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, file);
  return s;
}
