/**
 * 生成比例 + 尺寸(MP) → 目标宽高。
 *
 * 公式：面积 = MP × 1e6；按比例 w/h 展开 → w = sqrt(area × r)，h = sqrt(area / r)。
 * 结果对齐到 64（ComfyUI latent 友好网格），并等比缩放到最大边长限制内，
 * 避免超出模型可用分辨率（视频模型远小于图像模型）。
 */

export interface Resolution {
  width: number;
  height: number;
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

function align(v: number): number {
  return Math.max(MIN_DIM, Math.round(v / GRID) * GRID);
}

/**
 * 按 比例 + 尺寸(MP) 计算宽高。
 * - 比例无效（如「智能」）或尺寸非法 → null（不注入，沿用工作流默认分辨率）
 * - maxDimension：最大边长限制，超出时等比缩放（保持比例）
 */
export function computeResolution(
  ratio: string | undefined | null,
  sizeMp: number | undefined | null,
  maxDimension = 2048,
): Resolution | null {
  const r = parseRatio(ratio);
  if (!r) return null;
  const mp = Number(sizeMp);
  if (!Number.isFinite(mp) || mp <= 0) return null;

  const area = mp * 1_000_000;
  let width = Math.sqrt(area * r);
  let height = Math.sqrt(area / r);

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = align(width * scale);
  height = align(height * scale);

  return { width, height };
}
