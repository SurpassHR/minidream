import { describe, expect, it } from 'vitest';
import { resolveMediaKind } from '../../web/src/mediaKind.js';

describe('media kind resolution', () => {
  it('promotes an image record to video when its filename is an MP4', () => {
    expect(resolveMediaKind('image', 'draft-88c40dee-6aa.mp4')).toBe('video');
  });

  it('promotes an image record to video when its URL carries a video filename', () => {
    expect(resolveMediaKind('image', undefined, '/api/drafts/draft-88c40dee-6aa/file?filename=result.webm')).toBe('video');
  });

  it('keeps an image preview image and preserves explicit video types', () => {
    expect(resolveMediaKind('image', 'preview.png')).toBe('image');
    expect(resolveMediaKind('video', 'preview')).toBe('video');
  });
});
