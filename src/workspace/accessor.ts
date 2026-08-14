import fg from 'fast-glob';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DirectorError } from '../types.js';

const EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/.director/**', '**/out/**'];

export function listWorkspace(root: string): string[] {
  // 只收文件；目录通过拆分文件路径补出（带尾斜杠、唯一）——避免裸目录项与斜杠目录并存重复
  const entries = fg.sync(['**/*'], {
    cwd: root,
    onlyFiles: true,
    dot: true,
    ignore: EXCLUDES,
  });
  const dirs = new Set<string>();
  for (const f of entries) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  return [...dirs].concat(entries).sort();
}

function safeJoin(root: string, rel: string): string {
  const target = resolve(root, rel);
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw new DirectorError('FILE_CONFLICT', `路径越界: ${rel}`);
  }
  return target;
}

export interface SearchHit {
  path: string;
  line?: number;
  snippet: string;
}

export function searchWorkspace(
  root: string,
  query: string,
  opts: { maxResults?: number; maxFileBytes?: number } = {},
): SearchHit[] {
  const maxResults = opts.maxResults ?? 50;
  const maxFileBytes = opts.maxFileBytes ?? 1_048_576;
  const hits: SearchHit[] = [];
  const files = fg.sync(['**/*'], { cwd: root, onlyFiles: true, dot: true, ignore: EXCLUDES });

  // 1) 文件名匹配（glob 语义；加 **/ 前缀使其可匹配任意层级，字面量文件名同样命中）
  const namePattern = query.startsWith('**') ? query : `**/${query}`;
  const nameHits = new Set(fg.sync([namePattern], { cwd: root, onlyFiles: true, dot: true }));
  for (const f of files) {
    if (nameHits.has(f)) {
      hits.push({ path: f, snippet: f });
      if (hits.length >= maxResults) return hits;
    }
  }

  // 2) 内容匹配（正则非法时按字面量）
  let re: RegExp | null = null;
  try { re = new RegExp(query); } catch { re = null; }
  for (const f of files) {
    const abs = safeJoin(root, f);
    const text = readFileSync(abs, 'utf8').slice(0, maxFileBytes);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const matched = re ? re.test(line) : line.includes(query);
      if (matched) {
        hits.push({ path: f, line: i + 1, snippet: line.slice(0, 200) });
        if (hits.length >= maxResults) return hits;
      }
    }
  }
  return hits;
}

export function readWorkspaceFile(root: string, relPath: string, maxBytes = 1_048_576): string {
  const abs = safeJoin(root, relPath);
  const text = readFileSync(abs, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new DirectorError('INVALID_PATCH', `文件过大: ${relPath}`);
  }
  return text;
}
