/**
 * 生成比例 + 尺寸(MP) → 像素预览（与 server/src/resolution.ts 逻辑保持一致）。
 * 面积 = MP × 1e6；按比例展开 → 对齐 64 网格 → 超出最大边长时等比缩放。
 */

export interface ResolutionPreview {
  width: number;
  height: number;
  /** 是否因超过最大边长而被等比缩放 */
  capped: boolean;
}

/** 解析比例字符串（"16:9" / "16：9" → 16/9）；智能/auto/无效返回 null */
export function parseRatio(ratio: string | undefined | null): number | null {
  if (!ratio) return null;
  const trimmed = String(ratio).trim();
  if (!trimmed || trimmed === '智能' || /^auto$/i.test(trimmed)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

const GRID = 64;
const MIN_DIM = 256;

/** 计算目标像素；比例无效（智能）或尺寸非法 → null（沿用工作流默认） */
export function computeResolution(
  ratio: string | undefined | null,
  sizeMp: number | undefined | null,
  maxDimension = 2048,
): ResolutionPreview | null {
  const r = parseRatio(ratio);
  if (!r) return null;
  const mp = Number(sizeMp);
  if (!Number.isFinite(mp) || mp <= 0) return null;

  const area = mp * 1_000_000;
  let width = Math.sqrt(area * r);
  let height = Math.sqrt(area / r);

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.max(MIN_DIM, Math.round((width * scale) / GRID) * GRID);
  height = Math.max(MIN_DIM, Math.round((height * scale) / GRID) * GRID);

  return { width, height, capped: scale < 1 };
}
