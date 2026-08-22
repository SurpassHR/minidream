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

/** 生成插件（工作流）配置：停用状态 + 每个工作流的 combo 参数覆盖（paramId → 值） */
export interface PluginsSettings {
  disabled: string[];
  /** workflowId → { paramId: 选中值 }，仅存与默认不同的覆盖 */
  config: Record<string, Record<string, string>>;
}

export type AgentThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentSettings {
  model: string;
  thinking: AgentThinking;
  /** Agent 是否轮询生成任务状态（关闭时移除 generation.status 工具，进度走 SSE 推送） */
  pollTaskStatus: boolean;
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
  plugins: PluginsSettings;
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
    pollTaskStatus: false,
  },
  imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
  storage: {
    outputDir: resolve(process.cwd(), 'data/drafts'),
  },
  plugins: {
    disabled: [],
    config: {},
  },
};

export function readSettings(file: string): AppSettings {
  if (!existsSync(file)) {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      agent: { ...DEFAULT_SETTINGS.agent },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
      storage: { ...DEFAULT_SETTINGS.storage },
      plugins: { disabled: [], config: {} },
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
        plugins: { disabled: [], config: {} },
      };
    }
    const comfyui = data.comfyui && typeof data.comfyui === 'object' ? data.comfyui : {};
    const agent = data.agent && typeof data.agent === 'object' ? data.agent : {};
    const imageGen = data.imageGen && typeof data.imageGen === 'object' ? data.imageGen : {};
    const storage = data.storage && typeof data.storage === 'object' ? data.storage : {};
    const plugins = data.plugins && typeof data.plugins === 'object' ? data.plugins : {};

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
        pollTaskStatus:
          typeof agent.pollTaskStatus === 'boolean'
            ? agent.pollTaskStatus
            : DEFAULT_SETTINGS.agent.pollTaskStatus,
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
      plugins: {
        disabled: Array.isArray(plugins.disabled)
          ? plugins.disabled.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
          : [],
        config: normalizePluginConfig(plugins.config),
      },
    };
  } catch {
    return {
      comfyui: { ...DEFAULT_SETTINGS.comfyui },
      agent: { ...DEFAULT_SETTINGS.agent },
      imageGen: { ...DEFAULT_IMAGE_GEN_SETTINGS },
      storage: { ...DEFAULT_SETTINGS.storage },
      plugins: { disabled: [], config: {} },
    };
  }
}

/** 规整插件配置：{ workflowId: { paramId: string } } */
function normalizePluginConfig(raw: unknown): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [wfId, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const entries: Record<string, string> = {};
    for (const [paramId, value] of Object.entries(cfg as Record<string, unknown>)) {
      if (paramId.trim() && typeof value === 'string' && value.trim()) entries[paramId] = value;
    }
    if (Object.keys(entries).length) out[wfId] = entries;
  }
  return out;
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
      pollTaskStatus:
        typeof partial.pollTaskStatus === 'boolean'
          ? partial.pollTaskStatus
          : current.agent.pollTaskStatus,
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

export function updatePluginsSettings(file: string, plugins: Partial<PluginsSettings>): AppSettings {
  const current = readSettings(file);
  const disabled = Array.isArray(plugins.disabled)
    ? plugins.disabled.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : current.plugins.disabled;
  const config =
    plugins.config && typeof plugins.config === 'object'
      ? normalizePluginConfig(plugins.config)
      : current.plugins.config;
  return writeSettings(file, {
    ...current,
    plugins: { disabled, config },
  });
}


