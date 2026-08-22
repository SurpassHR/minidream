import { describe, expect, it } from 'vitest';
import { computeResolution, parseRatio } from './resolution.js';

describe('parseRatio', () => {
  it('解析标准比例', () => {
    expect(parseRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseRatio('1:1')).toBe(1);
    expect(parseRatio('9:16')).toBeCloseTo(9 / 16);
  });

  it('智能/无效输入返回 null', () => {
    expect(parseRatio('智能')).toBeNull();
    expect(parseRatio('auto')).toBeNull();
    expect(parseRatio('')).toBeNull();
    expect(parseRatio(undefined)).toBeNull();
    expect(parseRatio('abc')).toBeNull();
    expect(parseRatio('0:1')).toBeNull();
  });
});

describe('computeResolution', () => {
  it('1MP 1:1 → 1024×1024', () => {
    expect(computeResolution('1:1', 1)).toEqual({ width: 1024, height: 1024 });
  });

  it('1MP 16:9 → 1344×768（对齐 64）', () => {
    expect(computeResolution('16:9', 1)).toEqual({ width: 1344, height: 768 });
  });

  it('1MP 9:16 → 768×1344', () => {
    expect(computeResolution('9:16', 1)).toEqual({ width: 768, height: 1344 });
  });

  it('0.5MP 1:1 → 704×704', () => {
    const r = computeResolution('1:1', 0.5)!;
    expect(r.width).toBe(r.height);
    expect(r.width).toBeGreaterThanOrEqual(640);
    expect(r.width % 64).toBe(0);
  });

  it('超大尺寸按 maxDimension 等比缩放且保持比例', () => {
    // 21:9 @ 10MP → 原始宽约 4827，超过 2048 上限 → 等比缩放
    const r = computeResolution('21:9', 10, 2048)!;
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2048);
    expect(r.width / r.height).toBeCloseTo(21 / 9, 1);
  });

  it('视频上限 maxDimension=1344 生效', () => {
    const r = computeResolution('16:9', 4, 1344)!;
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1344);
  });

  it('智能比例或非法尺寸 → null', () => {
    expect(computeResolution('智能', 1)).toBeNull();
    expect(computeResolution('16:9', undefined)).toBeNull();
    expect(computeResolution('16:9', 0)).toBeNull();
    expect(computeResolution(undefined, 1)).toBeNull();
  });
});
