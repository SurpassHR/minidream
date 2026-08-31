import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 读取运行时根目录环境变量：未设置或为空时回退到默认路径，否则解析为绝对路径。
 * 供浏览器验证/隔离的 dev 服务器使用，见 server/README 中的沙箱说明。
 */
export function resolveRuntimeRoot(envKey: string, fallback: string): string {
  const value = process.env[envKey];
  return value && value.trim() ? path.resolve(value.trim()) : fallback;
}

/** 应用可写数据根目录（settings/tasks/sessions/drafts/插件清单）；未设置时为 server/data。 */
export const DATA_ROOT = resolveRuntimeRoot('MINIDREAM_DATA_ROOT', path.resolve(__dirname, '../data'));
/** 插件 Skill 与 response.json 根目录；未设置时为仓库 .pi/skills。 */
export const SKILLS_ROOT = resolveRuntimeRoot('MINIDREAM_SKILLS_ROOT', path.resolve(__dirname, '../../.pi/skills'));
/** 内置工作流 JSON 目录（只读源 + 节点位置写入）；未设置时为 server/workflows。 */
export const BUNDLED_WORKFLOWS_DIR = resolveRuntimeRoot('MINIDREAM_BUNDLED_WORKFLOWS', path.resolve(__dirname, '../workflows'));