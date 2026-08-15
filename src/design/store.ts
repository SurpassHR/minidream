// object-designer 对象设计存储：<projectDir>/.director/design.json
// 三类对象（人物/场景/物品），状态机 draft → generating → done/failed
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DirectorError } from '../types.js';

export type DesignKind = 'character' | 'scene' | 'prop';
export type DesignStatus = 'draft' | 'generating' | 'done' | 'failed';

export interface DesignObject {
  id: string;
  kind: DesignKind;
  name: string;
  description: string;   // 视觉描述
  style: string;         // 风格（自由文本）
  template: string;      // 文生图模板名（workflows/*.template.json）
  status: DesignStatus;
  assetId?: string;      // 生成的参考图素材 id
  error?: string;
  createdAt: number;
}

const KINDS: DesignKind[] = ['character', 'scene', 'prop'];
// 客户端可更新字段白名单（id/kind/createdAt 不可改；status 由生成流程写）
const PATCHABLE = ['name', 'description', 'style', 'template', 'status', 'assetId', 'error'] as const;

function designFile(projectDir: string): string {
  return join(projectDir, '.director', 'design.json');
}

export function listDesigns(projectDir: string): DesignObject[] {
  const f = designFile(projectDir);
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(data) ? (data as DesignObject[]) : [];
  } catch {
    return [];
  }
}

function writeDesigns(projectDir: string, designs: DesignObject[]): void {
  const f = designFile(projectDir);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(designs, null, 2), 'utf8');
  renameSync(tmp, f);
}

function findDesign(designs: DesignObject[], id: string): DesignObject {
  const d = designs.find((x) => x.id === id);
  if (!d) throw new DirectorError('NODE_NOT_FOUND', `设计对象不存在: ${id}`);
  return d;
}

export function createDesign(projectDir: string, kind: DesignKind, name: string): DesignObject {
  if (!KINDS.includes(kind)) {
    throw new DirectorError('INVALID_PATCH', `不支持的对象类型: ${String(kind)}`);
  }
  const d: DesignObject = {
    id: randomUUID(),
    kind,
    name: name || '未命名',
    description: '',
    style: '',
    template: '',
    status: 'draft',
    createdAt: Date.now(),
  };
  const designs = [...listDesigns(projectDir), d];
  writeDesigns(projectDir, designs);
  return d;
}

export function updateDesign(
  projectDir: string,
  id: string,
  patch: Partial<Pick<DesignObject, (typeof PATCHABLE)[number]>>,
): DesignObject {
  const designs = listDesigns(projectDir);
  const target = findDesign(designs, id);
  const updated = { ...target };
  for (const key of PATCHABLE) {
    const v = (patch as Record<string, unknown>)[key];
    // undefined = 不更新（空串是有意义的清除值，如 error: ''）
    if (v !== undefined) (updated as Record<string, unknown>)[key] = v;
  }
  writeDesigns(projectDir, designs.map((x) => (x.id === id ? updated : x)));
  return updated;
}

export function deleteDesign(projectDir: string, id: string): void {
  const designs = listDesigns(projectDir);
  findDesign(designs, id);
  writeDesigns(projectDir, designs.filter((x) => x.id !== id));
}
