import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DirectorError, type DirectorNode } from '../types.js';
import { loadGraph, saveGraph } from '../graph/graph-store.js';

// 节点类型 → 文件映射：目前只有 shot/prompt 有映射
export function mappedFile(node: DirectorNode): string | null {
  if (node.type === 'shot' || node.type === 'prompt') {
    const f = node.fields.filename;
    return typeof f === 'string' && f.length > 0 ? f : null;
  }
  return null;
}

export function listMappedFiles(node: DirectorNode): string[] {
  const f = mappedFile(node);
  return f ? [f] : [];
}

// 节点 → 文件（画布编辑写回文件）
export function syncNodeToFile(projectDir: string, node: DirectorNode): void {
  const rel = mappedFile(node);
  if (!rel) return;
  const content = node.fields.content;
  if (typeof content !== 'string') return;
  // 防路径穿越：映射文件必须落在项目目录内
  const target = resolve(projectDir, rel);
  if (!target.startsWith(resolve(projectDir) + '/')) {
    throw new DirectorError('FILE_CONFLICT', `非法映射路径: ${rel}`);
  }
  writeFileSync(target, content, 'utf8');
}

// 文件 → 节点（外部修改回填画布）
export function syncFileToNode(projectDir: string, relPath: string): void {
  const target = resolve(projectDir, relPath);
  if (!target.startsWith(resolve(projectDir) + '/')) {
    throw new DirectorError('FILE_CONFLICT', `非法路径: ${relPath}`);
  }
  const graph = loadGraph(projectDir);
  const node = graph.nodes.find((n) => mappedFile(n) === relPath);
  if (!node) throw new DirectorError('NODE_NOT_FOUND', `无节点映射到文件: ${relPath}`);
  node.fields.content = readFileSync(target, 'utf8');
  node.version += 1;
  saveGraph(projectDir, graph);
}
