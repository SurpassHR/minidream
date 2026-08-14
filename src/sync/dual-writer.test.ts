import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { DirectorNode, Graph } from '../types.js';
import { createNode, loadGraph, saveGraph } from '../graph/graph-store.js';
import { mappedFile, syncFileToNode, syncNodeToFile, listMappedFiles } from './dual-writer.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'director-sync-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function shotNode(): DirectorNode {
  const g: Graph = { projectName: 't', nodes: [], edges: [] };
  return createNode(g, {
    type: 'shot', title: 'SHOT 01',
    fields: { filename: 'shot_01.md', content: '# SHOT 01\n动作：牵绳慢步' },
  });
}

describe('DualWriter 映射规则', () => {
  it('shot 节点映射到 fields.filename', () => {
    expect(mappedFile(shotNode())).toBe('shot_01.md');
  });

  it('keyframe 等无文件类型返回 null', () => {
    const g: Graph = { projectName: 't', nodes: [], edges: [] };
    const kf = createNode(g, { type: 'keyframe', title: 'KF0' });
    expect(mappedFile(kf)).toBeNull();
    expect(listMappedFiles(kf)).toEqual([]);
  });
});

describe('DualWriter 同步', () => {
  it('syncNodeToFile 把节点内容写到项目目录', () => {
    syncNodeToFile(dir, shotNode());
    expect(readFileSync(join(dir, 'shot_01.md'), 'utf8')).toContain('牵绳慢步');
  });

  it('syncFileToNode 读取外部修改回填节点并 version+1', () => {
    const g: Graph = { projectName: 't', nodes: [], edges: [] };
    const n = createNode(g, {
      type: 'shot', title: 'SHOT 01',
      fields: { filename: 'shot_01.md', content: 'old' },
    });
    saveGraph(dir, g);
    writeFileSync(join(dir, 'shot_01.md'), 'new content from vim', 'utf8');
    syncFileToNode(dir, 'shot_01.md');
    const loaded = loadGraph(dir);
    const node = loaded.nodes.find((x) => x.id === n.id);
    expect(node?.fields.content).toBe('new content from vim');
    expect(node?.version).toBe(2);
  });

  it('syncFileToNode 无对应节点抛 NODE_NOT_FOUND', () => {
    const g: Graph = { projectName: 't', nodes: [], edges: [] };
    saveGraph(dir, g);
    writeFileSync(join(dir, 'nobody.md'), 'x', 'utf8');
    expect(() => syncFileToNode(dir, 'nobody.md')).toThrowError(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });
});
