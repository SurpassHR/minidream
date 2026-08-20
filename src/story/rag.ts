// 项目 RAG：素材库 txt 资产 → 分块 → Ollama embedding → 余弦相似度 top-k 检索。
// 配置来自全局设置（ollamaUrl + ollamaEmbedModel）；未配置或调用失败时 search 返回
// status 'unconfigured'/'error'（hits 为空），调用方（story chat）跳过注入，对话优雅降级。
// 分块向量按「项目+board+资产+size」缓存于内存（进程内复用；重启后按需重算）。
import { listAssets, readAssetText } from '../assets/assets-store.js';
import { OllamaClient } from '../ollama/client.js';
import { readSettings } from '../settings/settings-store.js';
import type { StoryBoard } from './boards-store.js';

export interface RagHit {
  assetId: string;
  name: string;
  text: string;
  score: number;
}

export type RagStatus = 'ok' | 'unconfigured' | 'error';

export interface RagSearchResult {
  hits: RagHit[];
  status: RagStatus;
  error?: string;
}

const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 80;
const MIN_SCORE = 0.15;

// 按段落切块：以空行/句子边界优先，长度不足 CHUNK_SIZE 时向后吸收，段间留 overlap
export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
    } else if ((buf + '\n' + p).length <= CHUNK_SIZE) {
      buf += '\n' + p;
    } else {
      chunks.push(buf);
      buf = buf.length > CHUNK_OVERLAP
        ? buf.slice(-CHUNK_OVERLAP) + '\n' + p
        : p;
    }
  }
  if (buf) chunks.push(buf);
  // 超长单段（无空行大文本）：硬切
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= CHUNK_SIZE) {
      out.push(c);
      continue;
    }
    for (let i = 0; i < c.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
      out.push(c.slice(i, i + CHUNK_SIZE));
    }
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface CachedFile { chunks: string[]; vectors: number[][] }

const cache = new Map<string, CachedFile>();

function cacheKey(projectDir: string, boardId: string, assetId: string, size: number): string {
  return `${projectDir}|${boardId}|${assetId}|${size}`;
}

export async function ragSearch(
  projectDir: string,
  board: StoryBoard,
  query: string,
  topK = 3,
  embedTexts?: (texts: string[]) => Promise<number[][]>,
): Promise<RagSearchResult> {
  const { ollamaUrl, ollamaEmbedModel } = readSettings();
  if (!ollamaUrl || !ollamaEmbedModel) return { hits: [], status: 'unconfigured' };
  const q = query.trim();
  if (!q) return { hits: [], status: 'ok' };
  const assets = listAssets(projectDir);
  const rags = board.ragAssets
    .map((id) => assets.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined && a.kind === 'txt');
  if (rags.length === 0) return { hits: [], status: 'ok' };

  try {
    const client = embedTexts ? null : new OllamaClient(ollamaUrl);
    const embed = embedTexts ?? ((texts: string[]) => client!.embed(ollamaEmbedModel, texts));
    const docs: Array<{ assetId: string; name: string; text: string; vec: number[] }> = [];
    for (const asset of rags) {
      const key = cacheKey(projectDir, board.id, asset.id, asset.size);
      let c = cache.get(key);
      if (!c) {
        const chunks = chunkText(readAssetText(projectDir, asset.id));
        const vectors = await embed(chunks);
        c = { chunks, vectors };
        cache.set(key, c);
      }
      c.chunks.forEach((text, i) => {
        const vec = c.vectors[i];
        if (vec) docs.push({ assetId: asset.id, name: asset.name, text, vec });
      });
    }
    const qv = (await embed([q]))[0];
    if (!qv) return { hits: [], status: 'error', error: '查询向量为空' };
    const scored = docs
      .map((d) => ({ assetId: d.assetId, name: d.name, text: d.text, score: cosine(qv, d.vec) }))
      .filter((d) => d.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { hits: scored, status: 'ok' };
  } catch (e) {
    return { hits: [], status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

// 命中片段 → 注入 prompt 的上下文文本
export function formatRagHits(hits: RagHit[]): string {
  if (hits.length === 0) return '';
  const lines = ['知识库检索（RAG）命中：'];
  for (const h of hits) {
    lines.push(`- [${h.name}] ${h.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return lines.join('\n');
}
