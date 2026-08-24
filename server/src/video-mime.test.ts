import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftStore, inferMimeType } from './drafts.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'director-video-mime-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('video draft MIME type', () => {
  it('infers MIME from a ComfyUI output filename for direct video responses', () => {
    expect(inferMimeType('result.mp4')).toBe('video/mp4');
    expect(inferMimeType('result.webm')).toBe('video/webm');
  });

  it('infers video/mp4 for a video draft without upstream MIME metadata', async () => {
    const store = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const record = await store.saveFromBuffer({
      kind: 'video',
      sourceName: 'generated.mp4',
      data: Buffer.from('video'),
    });

    expect(store.contentType(record.id)).toBe('video/mp4');
  });

  it('uses the video extension when the output is not MP4', async () => {
    const store = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const record = await store.saveFromBuffer({
      kind: 'video',
      sourceName: 'generated.webm',
      data: Buffer.from('video'),
    });

    expect(store.contentType(record.id)).toBe('video/webm');
  });

  it('replaces an unusable octet-stream response with the inferred video type', async () => {
    const store = new DraftStore({ indexFile: join(dir, 'drafts.json'), outputDir: join(dir, 'drafts') });
    const record = await store.saveFromBuffer({
      kind: 'video',
      sourceName: 'generated.mp4',
      mime: 'application/octet-stream',
      data: Buffer.from('video'),
    });

    expect(store.contentType(record.id)).toBe('video/mp4');
  });
});
