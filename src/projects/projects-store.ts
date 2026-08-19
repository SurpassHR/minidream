import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import fg from 'fast-glob';
import { loadGraph } from '../graph/graph-store.js';
import { DirectorError } from '../types.js';

// —— 项目注册表（手动添加，持久化 ~/.director/projects.json） ——
// 项目栏只显示用户手动添加的项目：默认不自动发现、不显示当前目录。
// 添加校验：剧本项目（mmh3_prompts / prompts）或空目录；其余目录拒绝。
// 注册表路径用函数式求值（每次读取当前 HOME），保证 vi.stubEnv('HOME') 测试隔离。
function registryPath(): string {
  return join(homedir(), '.director', 'projects.json');
}

function lastProjectPath(): string {
  return join(homedir(), '.director', 'last-project.json');
}

interface RegistryEntry {
  path: string;
  // 显示名称与磁盘目录名解耦；旧注册表没有 name 时回退 basename(path)
  name?: string;
  addedAt: number;
}

function readRegistry(): RegistryEntry[] {
  if (!existsSync(registryPath())) return [];
  try {
    return JSON.parse(readFileSync(registryPath(), 'utf8')) as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  mkdirSync(dirname(registryPath()), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(entries, null, 2), 'utf8');
}

// 记录最近一次打开的项目，独立于项目注册表，允许显式启动未加入项目栏的目录。
export function rememberLastProject(path: string): void {
  const abs = resolve(path);
  mkdirSync(dirname(lastProjectPath()), { recursive: true });
  writeFileSync(lastProjectPath(), JSON.stringify({ path: abs }, null, 2), 'utf8');
}

// 读取最近项目；目录已被删除/移动时自动忽略，避免无参数启动进入失效项目。
export function readLastProject(): string | null {
  if (!existsSync(lastProjectPath())) return null;
  try {
    const data = JSON.parse(readFileSync(lastProjectPath(), 'utf8')) as { path?: unknown };
    if (typeof data.path !== 'string' || !statSync(data.path).isDirectory()) return null;
    return resolve(data.path);
  } catch {
    return null;
  }
}

export interface ProjectInfo {
  path: string;
  name: string;
  current: boolean;
  shots: number;    // 分镜数；-1 = 未知（目录无图数据且无 shot_*.md）
  duration: number; // 总时长（秒）；-1 = 未知
  mode: string;     // 'KEYFRAME' | 'REF2V' | ''（探测目录结构）
}

// 剧本项目判定：目录内含 mmh3_prompts / prompts（mmh3 创作项目惯例）。
// 注意：.director/project.json 是工作台运行时数据（被打开过即生成），不参与判定。
function looksLikeProject(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, 'mmh3_prompts')) || existsSync(join(dir, 'prompts'));
}

// 空目录也可作为项目添加（预留创作起点，后续由 skill 在其中生成 mmh3 结构）
function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// 分镜时长：fields.duration（"3.75s" / 3.75）或 frames/fps；均缺失时按默认 3.75s
function shotDuration(fields: Record<string, unknown>): number {
  const d = num(fields.duration);
  if (d !== null) return d;
  const frames = num(fields.frames);
  if (frames !== null) return frames / (num(fields.fps) ?? 24);
  return 3.75;
}

// 从 .director/project.json 图数据统计
function statFromGraph(dir: string): { shots: number; duration: number } {
  const graph = loadGraph(dir);
  const shots = graph.nodes.filter((n) => n.type === 'shot');
  const duration = shots.reduce((acc, s) => acc + shotDuration(s.fields), 0);
  return { shots: shots.length, duration };
}

// 无图数据时扫 shot_*.md：文件计数 + 元数据行 "- 时长：3.75s（90 帧 @24fps）"
function statFromMarkdown(dir: string): { shots: number; duration: number } {
  let files: string[];
  try {
    files = fg.sync('**/shot_*.md', { cwd: dir, onlyFiles: true, absolute: true, ignore: ['**/node_modules/**'] });
  } catch {
    files = [];
  }
  let duration = 0;
  for (const f of files) {
    let head = '';
    try {
      head = readFileSync(f, 'utf8').slice(0, 2000);
    } catch {
      continue;
    }
    const m = head.match(/时长[:：]\s*(\d+(?:\.\d+)?)\s*s/);
    duration += m?.[1] ? parseFloat(m[1]) : 3.75;
  }
  return { shots: files.length, duration };
}

function statProject(dir: string): { shots: number; duration: number; mode: string } {
  const fromGraph = existsSync(join(dir, '.director', 'project.json'));
  const base = fromGraph ? statFromGraph(dir) : statFromMarkdown(dir);
  const hasKeyframes = fg.sync('**/keyframes', { cwd: dir, onlyDirectories: true, deep: 4 }).length > 0;
  const hasRef2v = fg.sync('**/ref2va', { cwd: dir, onlyDirectories: true, deep: 4 }).length > 0;
  const mode = hasKeyframes ? 'KEYFRAME' : hasRef2v ? 'REF2V' : '';
  return {
    shots: fromGraph ? base.shots : base.shots > 0 ? base.shots : -1,
    duration: base.shots > 0 ? base.duration : -1,
    mode,
  };
}

function pushProject(out: ProjectInfo[], dir: string, currentDir: string, displayName?: string): void {
  out.push({ path: dir, name: displayName?.trim() || basename(dir), current: dir === currentDir, ...statProject(dir) });
}

// 路径解析：绝对路径直接使用；相对路径按 projectDir 父目录解析（与切换目标一致）
function resolveDir(projectDir: string, path: string): string | null {
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(dirname(projectDir), path);
  try {
    return statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// 项目列表：只显示注册表中手动添加的项目（目录已删除的跳过）。
// 不自动发现、不显示当前目录——项目栏的显示权完全归用户添加操作。
// 固定按名称排序：切换项目只更新 current 高亮，不把当前项目挪到最上方。
export function listProjects(projectDir: string): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  for (const entry of readRegistry()) {
    if (!existsSync(entry.path)) continue;
    pushProject(out, entry.path, projectDir, entry.name);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 添加项目：必须是剧本项目（mmh3_prompts / prompts）或空目录；
// 已添加则幂等（不重复写入）。成功后持久化，之后自动显示在项目栏。
export function addProject(projectDir: string, path: string): ProjectInfo[] {
  const abs = resolveDir(projectDir, path);
  if (!abs) throw new DirectorError('PROJECT_NOT_FOUND', `项目目录不存在: ${path}`);
  if (!looksLikeProject(abs) && !isEmptyDir(abs)) {
    throw new DirectorError(
      'PROJECT_NOT_ADDABLE',
      `不是剧本项目（需含 mmh3_prompts/ 或 prompts/ 目录，或为空目录）: ${path}`,
    );
  }
  const registry = readRegistry();
  if (!registry.some((e) => e.path === abs)) {
    registry.push({ path: abs, addedAt: Date.now() });
    writeRegistry(registry);
  }
  return listProjects(projectDir);
}

// 更新项目显示名称：不改磁盘目录，只更新项目注册表中的 name 字段。
export function renameProject(projectDir: string, path: string, name: string): ProjectInfo[] {
  const abs = resolveDir(projectDir, path);
  if (!abs) throw new DirectorError('PROJECT_NOT_FOUND', `项目目录不存在: ${path}`);
  const nextName = name.trim();
  if (!nextName) throw new DirectorError('INVALID_PATCH', '项目名称不能为空');
  const registry = readRegistry();
  const entry = registry.find((item) => item.path === abs);
  if (!entry) throw new DirectorError('PROJECT_NOT_FOUND', `项目未添加到项目栏: ${path}`);
  entry.name = nextName;
  writeRegistry(registry);
  return listProjects(projectDir);
}

// 删除项目：从注册表移除，并递归删除对应磁盘目录；调用方必须先经过确认门。
export function deleteProject(projectDir: string, path: string): ProjectInfo[] {
  const abs = resolveDir(projectDir, path);
  if (!abs) throw new DirectorError('PROJECT_NOT_FOUND', `项目目录不存在: ${path}`);
  rmSync(abs, { recursive: true, force: false });
  writeRegistry(readRegistry().filter((entry) => entry.path !== abs));
  return listProjects(projectDir);
}

// 从项目栏移除（仅移除注册表项，不删除目录）；路径不存在按幂等处理
export function removeProject(projectDir: string, path: string): ProjectInfo[] {
  const abs = resolveDir(projectDir, path);
  if (!abs) return listProjects(projectDir);
  writeRegistry(readRegistry().filter((e) => e.path !== abs));
  return listProjects(projectDir);
}

// 切换目标校验：接受已添加项目的绝对路径，或其他存在的目录；相对路径按 projectDir 父目录解析
export function resolveSwitchTarget(projectDir: string, path: string): string | null {
  return resolveDir(projectDir, path);
}

// 从 project 节点读 ComfyUI 地址，缺省 localhost:8188（切换项目后热重建客户端用）
export function resolveComfyUrl(projectDir: string): string {
  const graph = loadGraph(projectDir);
  const proj = graph.nodes.find((n) => n.type === 'project');
  const u = proj?.fields.comfyuiUrl;
  return typeof u === 'string' && u.length > 0 ? u : 'http://localhost:8188';
}
