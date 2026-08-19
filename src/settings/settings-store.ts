import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 全局设置：~/.director/settings.json（用户级，跨项目生效）
// 存 ComfyUI 地址 + agent 默认模型 + 思考强度 + 提示词库（prompts）；
// 目录用函数式求值（每次操作读取当前 HOME），测试 vi.stubEnv('HOME') 隔离不污染真实文件

export type ThemeMode = 'dark' | 'light';

export interface AppSettings {
  comfyUrl: string;      // ComfyUI 地址（http://...）
  agentModel: string;    // agent 默认模型 id（provider/model；空串 = pi 默认）
  agentThinking: string; // 思考强度（off/minimal/low/medium/high/xhigh/max；空串 = pi 默认）
  prompts?: Record<string, string>; // 提示词库（键=名称，值=内容）；键缺失=从未自定义
  armorBreak: string;          // 破甲预设文本（插入到所有系统提示词之前；空=不生效）
  armorBreakEnabled: boolean;  // 破甲全局开关
  ollamaUrl: string;     // Ollama 地址（http://...；空串 = 未配置）
  ollamaModel: string;   // Ollama 本地视觉模型名（图像转提示词用；空串 = 未配置）
  ollamaEmbedModel: string; // Ollama embedding 模型名（项目 RAG 向量检索用；空串 = 未配置）
  assetsDir: string;      // 全局素材库目录；空串 = ~/.director/assets
  theme?: ThemeMode;        // 工作台主题；缺失 = 深色默认
}

const DEFAULTS: AppSettings = {
  comfyUrl: '', agentModel: '', agentThinking: '', armorBreak: '', armorBreakEnabled: false,
  ollamaUrl: '', ollamaModel: '', ollamaEmbedModel: '', assetsDir: '',
};

function settingsFile(): string {
  return join(homedir(), '.director', 'settings.json');
}

// prompts 防御过滤：仅保留值为 string 的键；非对象输入视为空对象
function filterPrompts(p: unknown): Record<string, string> {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// 读取设置；文件缺失/损坏返回默认值（防御式）
export function readSettings(): AppSettings {
  const f = settingsFile();
  if (!existsSync(f)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as Partial<AppSettings>;
    const out: AppSettings = {
      comfyUrl: typeof data.comfyUrl === 'string' ? data.comfyUrl : DEFAULTS.comfyUrl,
      agentModel: typeof data.agentModel === 'string' ? data.agentModel : DEFAULTS.agentModel,
      agentThinking: typeof data.agentThinking === 'string' ? data.agentThinking : DEFAULTS.agentThinking,
      armorBreak: typeof data.armorBreak === 'string' ? data.armorBreak : DEFAULTS.armorBreak,
      armorBreakEnabled: typeof data.armorBreakEnabled === 'boolean' ? data.armorBreakEnabled : DEFAULTS.armorBreakEnabled,
      ollamaUrl: typeof data.ollamaUrl === 'string' ? data.ollamaUrl : DEFAULTS.ollamaUrl,
      ollamaModel: typeof data.ollamaModel === 'string' ? data.ollamaModel : DEFAULTS.ollamaModel,
      ollamaEmbedModel: typeof data.ollamaEmbedModel === 'string' ? data.ollamaEmbedModel : DEFAULTS.ollamaEmbedModel,
      assetsDir: typeof data.assetsDir === 'string' ? data.assetsDir : DEFAULTS.assetsDir,
    };
    if (data.theme === 'dark' || data.theme === 'light') out.theme = data.theme;
    // 键缺失（undefined）= 从未自定义，保持 out 无 prompts 键；
    // 已存在（含 {}）= 已保存过，原样过滤返回（删除的条目不复活）
    if (data.prompts !== undefined) {
      out.prompts = filterPrompts(data.prompts);
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

// 保存设置：只更新传入字段（白名单），未传字段保持现值；原子写（tmp + rename）
// prompts 为整体替换语义：传入对象则过滤后整体替换并总是写入（含空对象），未传则保持现值
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const next: AppSettings = {
    comfyUrl: typeof patch.comfyUrl === 'string' ? patch.comfyUrl : current.comfyUrl,
    agentModel: typeof patch.agentModel === 'string' ? patch.agentModel : current.agentModel,
    agentThinking: typeof patch.agentThinking === 'string' ? patch.agentThinking : current.agentThinking,
    armorBreak: typeof patch.armorBreak === 'string' ? patch.armorBreak : current.armorBreak,
    armorBreakEnabled: typeof patch.armorBreakEnabled === 'boolean' ? patch.armorBreakEnabled : current.armorBreakEnabled,
    ollamaUrl: typeof patch.ollamaUrl === 'string' ? patch.ollamaUrl : current.ollamaUrl,
    ollamaModel: typeof patch.ollamaModel === 'string' ? patch.ollamaModel : current.ollamaModel,
    ollamaEmbedModel: typeof patch.ollamaEmbedModel === 'string' ? patch.ollamaEmbedModel : current.ollamaEmbedModel,
    assetsDir: typeof patch.assetsDir === 'string' ? patch.assetsDir : current.assetsDir,
  };
  if (patch.prompts !== undefined) {
    next.prompts = (typeof patch.prompts === 'object' && patch.prompts !== null && !Array.isArray(patch.prompts))
      ? filterPrompts(patch.prompts)
      : current.prompts;
  } else {
    next.prompts = current.prompts;
  }
  const theme = patch.theme === 'dark' || patch.theme === 'light' ? patch.theme : current.theme;
  if (theme) next.theme = theme;
  const f = settingsFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, f);
  return next;
}
