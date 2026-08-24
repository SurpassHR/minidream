import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureVideoFrame } from '../../web/src/videoPreview.js';

describe('video preview frame capture', () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  });

  it('captures the first available video frame as a data URL', () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,poster'),
    };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: vi.fn(() => canvas) },
    });

    const video = { videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;

    expect(captureVideoFrame(video)).toBe('data:image/jpeg;base64,poster');
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
  });

  it('does not create a thumbnail before video dimensions are available', () => {
    const createElement = vi.fn();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement },
    });

    expect(captureVideoFrame({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement)).toBeNull();
    expect(createElement).not.toHaveBeenCalled();
  });
});
