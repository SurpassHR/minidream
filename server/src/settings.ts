/**
 * 设置持久化：JSON 文件存储（照搬 v1 会话存储的原子写方案）。
 * - 写入采用原子写（tmp + rename），避免半写损坏
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface ComfyUISettings {
  baseUrl: string;
}

export interface StorageSettings {
  outputDir: string;
}

export type AgentThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentSettings {
  model: string;
  thinking: AgentThinking;
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
  agent: AgentSettings;
  imageGen: ImageGenSettings;
  storage: StorageSettings;
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
  agent: {
    model: '',
    thinking: 'minimal',
  },
  imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
  storage: {
    outputDir: resolve(process.cwd(), 'data/drafts'),
  },
};

export function readSettings(file: string): AppSettings {
  if (!existsSync(file)) {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      agent: { ...DEFAULT_SETTINGS.agent },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
      storage: { ...DEFAULT_SETTINGS.storage },
    };
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null) {
      return {
        comfyui: { ...DEFAULT_SETTINGS.comfyui },
        agent: { ...DEFAULT_SETTINGS.agent },
        imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
        storage: { ...DEFAULT_SETTINGS.storage },
      };
    }
    const comfyui = data.comfyui && typeof data.comfyui === 'object' ? data.comfyui : {};
    const agent = data.agent && typeof data.agent === 'object' ? data.agent : {};
    const imageGen = data.imageGen && typeof data.imageGen === 'object' ? data.imageGen : {};
    const storage = data.storage && typeof data.storage === 'object' ? data.storage : {};

    return {
      comfyui: {
        baseUrl:
          typeof comfyui.baseUrl === 'string' && comfyui.baseUrl.trim()
            ? comfyui.baseUrl.trim()
            : DEFAULT_SETTINGS.comfyui.baseUrl,
      },
      agent: {
        model: typeof agent.model === 'string' ? agent.model.trim() : DEFAULT_SETTINGS.agent.model,
        thinking: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(agent.thinking)
          ? agent.thinking
          : DEFAULT_SETTINGS.agent.thinking,
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
      storage: {
        outputDir:
          typeof storage.outputDir === 'string' && isAbsolute(storage.outputDir.trim())
            ? storage.outputDir.trim()
            : DEFAULT_SETTINGS.storage.outputDir,
      },
    };
  } catch {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      agent: { ...DEFAULT_SETTINGS.agent },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
      storage: { ...DEFAULT_SETTINGS.storage },
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

export function updateAgentSettings(file: string, partial: Partial<AgentSettings>): AppSettings {
  const current = readSettings(file);
  const thinking = partial.thinking && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(partial.thinking)
    ? partial.thinking
    : current.agent.thinking;
  return writeSettings(file, {
    ...current,
    agent: {
      model: typeof partial.model === 'string' ? partial.model.trim() : current.agent.model,
      thinking,
    },
  });
}

export function updateImageGenSettings(file: string, partial: Partial<ImageGenSettings>): AppSettings {
  const current = readSettings(file);
  const updated: AppSettings = {
    ...current,
    imageGen: {
      ...current.imageGen,
      ...partial,
    },
  };
  return writeSettings(file, updated);
}

export function updateComfyUISettings(file: string, comfyui: Partial<ComfyUISettings>): AppSettings {
  const current = readSettings(file);
  const updated: AppSettings = {
    ...current,
    comfyui: {
      ...current.comfyui,
      ...comfyui,
    },
  };
  return writeSettings(file, updated);
}

export function updateStorageSettings(file: string, storage: Partial<StorageSettings>): AppSettings {
  const outputDir = storage.outputDir?.trim() ?? '';
  if (!isAbsolute(outputDir)) {
    throw new Error('产物存储目录必须是绝对路径');
  }
  const current = readSettings(file);
  return writeSettings(file, {
    ...current,
    storage: { ...current.storage, outputDir },
  });
}


