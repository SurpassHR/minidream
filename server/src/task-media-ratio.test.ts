import { describe, expect, it } from 'vitest';
import { getTaskMediaAspectRatio, getTaskMediaLayoutClass } from '../../web/src/taskMediaRatio';

describe('getTaskMediaAspectRatio', () => {
  it('uses the actual generated width and height when available', () => {
    expect(getTaskMediaAspectRatio({
      ratio: '16:9',
      generationParams: { width: 1536, height: 1024 },
    })).toBe('1536 / 1024');
  });

  it('prefers output dimensions over task dimensions and selected ratio', () => {
    expect(getTaskMediaAspectRatio({
      ratio: '16:9',
      generationParams: { width: 1536, height: 864 },
      outputParams: { width: 1024, height: 1536 },
    })).toBe('1024 / 1536');
  });

  it('falls back to task dimensions before the selected ratio', () => {
    expect(getTaskMediaAspectRatio({
      ratio: '9:16',
      params: { width: 768, height: 1344 },
    })).toBe('768 / 1344');
  });

  it('uses the selected image ratio when dimensions are not available', () => {
    expect(getTaskMediaAspectRatio({ ratio: '9：16' })).toBe('9 / 16');
  });

  it('does not invent a fixed ratio for unknown image sizes', () => {
    expect(getTaskMediaAspectRatio({ ratio: '智能' })).toBeUndefined();
    expect(getTaskMediaAspectRatio({ ratio: 'invalid' })).toBeUndefined();
    expect(getTaskMediaAspectRatio({ generationParams: { width: 1024 } })).toBeUndefined();
  });

  it('uses intrinsic media layout when the image ratio is unknown', () => {
    expect(getTaskMediaLayoutClass({ ratio: '智能' })).toBe('intrinsic');
    expect(getTaskMediaLayoutClass({ ratio: '16:9' })).toBe('has-aspect-ratio');
  });
});
