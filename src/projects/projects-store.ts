import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import fg from 'fast-glob';
import { loadGraph } from '../graph/graph-store.js';

// —— 项目发现与切换（计划 4：项目栏真实数据源） ——

export interface ProjectInfo {
  path: string;
  name: string;
  current: boolean;
  shots: number;    // 分镜数；-1 = 未知（目录无图数据且无 shot_*.md）
  duration: number; // 总时长（秒）；-1 = 未知
  mode: string;     // 'KEYFRAME' | 'REF2V' | ''（探测目录结构）
}

// 项目判定：目录内含 mmh3_prompts / prompts（mmh3 项目惯例）或 .director/project.json（工作台图数据）
function looksLikeProject(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    existsSync(join(dir, 'mmh3_prompts')) ||
    existsSync(join(dir, 'prompts')) ||
    existsSync(join(dir, '.director', 'project.json'))
  );
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

function pushProject(out: ProjectInfo[], seen: Set<string>, dir: string, currentDir: string): void {
  if (seen.has(dir)) return;
  seen.add(dir);
  out.push({ path: dir, name: basename(dir), current: dir === currentDir, ...statProject(dir) });
}

// 项目列表：当前项目 + 发现的项目。
// 发现来源：DIRECTOR_PROJECTS_DIR（项目根，可选）+ projectDir 向上最多 3 层祖先目录；
// 每个根扫描一层直接子目录（按 mmh3_prompts/prompts/.director 判定），
// 并再深一层 mmh3_prompts/* 场景目录。无环境变量时也能发现同根项目。
export function listProjects(projectDir: string): ProjectInfo[] {
  const roots: string[] = [];
  const env = process.env.DIRECTOR_PROJECTS_DIR;
  if (env) roots.push(env);
  let up = projectDir;
  for (let i = 0; i < 3; i++) {
    up = dirname(up);
    if (up === '/' || up === dirname(up)) break;
    roots.push(up);
  }

  const seen = new Set<string>();
  const out: ProjectInfo[] = [];
  pushProject(out, seen, projectDir, projectDir);

  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      if (!looksLikeProject(dir)) continue;
      pushProject(out, seen, dir, projectDir);
      // 场景目录：root/<项目>/mmh3_prompts/<场景>
      const scenesRoot = join(dir, 'mmh3_prompts');
      let scenes: string[] = [];
      try {
        scenes = readdirSync(scenesRoot);
      } catch {
        continue;
      }
      for (const s of scenes) {
        const scene = join(scenesRoot, s);
        if (looksLikeProject(scene)) pushProject(out, seen, scene, projectDir);
      }
    }
  }
  // 固定按名称排序：切换项目只更新 current 高亮，不把当前项目挪到最上方
  // （项目栏顺序稳定，用户点击哪个就高亮哪个）
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// 切换目标校验：接受已发现项目的绝对路径，或其他存在的目录；相对路径按 projectDir 父目录解析
export function resolveSwitchTarget(projectDir: string, path: string): string | null {
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(dirname(projectDir), path);
  try {
    return statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// 从 project 节点读 ComfyUI 地址，缺省 localhost:8188（切换项目后热重建客户端用）
export function resolveComfyUrl(projectDir: string): string {
  const graph = loadGraph(projectDir);
  const proj = graph.nodes.find((n) => n.type === 'project');
  const u = proj?.fields.comfyuiUrl;
  return typeof u === 'string' && u.length > 0 ? u : 'http://localhost:8188';
}
