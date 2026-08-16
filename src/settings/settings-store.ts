import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 全局设置：~/.director/settings.json（用户级，跨项目生效）
// 存 ComfyUI 地址 + agent 默认模型 + 思考强度；
// 目录用函数式求值（每次操作读取当前 HOME），测试 vi.stubEnv('HOME') 隔离不污染真实文件

export interface AppSettings {
  comfyUrl: string;      // ComfyUI 地址（http://...）
  agentModel: string;    // agent 默认模型 id（provider/model；空串 = pi 默认）
  agentThinking: string; // 思考强度（off/minimal/low/medium/high/xhigh/max；空串 = pi 默认）
}

const DEFAULTS: AppSettings = { comfyUrl: '', agentModel: '', agentThinking: '' };

function settingsFile(): string {
  return join(homedir(), '.director', 'settings.json');
}

// 读取设置；文件缺失/损坏返回默认值（防御式）
export function readSettings(): AppSettings {
  const f = settingsFile();
  if (!existsSync(f)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as Partial<AppSettings>;
    return {
      comfyUrl: typeof data.comfyUrl === 'string' ? data.comfyUrl : DEFAULTS.comfyUrl,
      agentModel: typeof data.agentModel === 'string' ? data.agentModel : DEFAULTS.agentModel,
      agentThinking: typeof data.agentThinking === 'string' ? data.agentThinking : DEFAULTS.agentThinking,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// 保存设置：只更新传入字段（白名单），未传字段保持现值；原子写（tmp + rename）
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const next: AppSettings = {
    comfyUrl: typeof patch.comfyUrl === 'string' ? patch.comfyUrl : current.comfyUrl,
    agentModel: typeof patch.agentModel === 'string' ? patch.agentModel : current.agentModel,
    agentThinking: typeof patch.agentThinking === 'string' ? patch.agentThinking : current.agentThinking,
  };
  const f = settingsFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, f);
  return next;
}
