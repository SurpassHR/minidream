import { describe, expect, it } from 'vitest';
import {
  extractSessionAssets,
  findMentionedSessionAssets,
  insertAssetMention,
  nextSessionAssetName,
} from '../../web/src/sessionAssets.js';

describe('session asset references', () => {
  it('allocates the next image name without reusing existing indexes', () => {
    expect(nextSessionAssetName('image', [
      { kind: 'image', url: '/a.png', name: 'image1' },
      { kind: 'image', url: '/b.png', name: 'image3' },
      { kind: 'video', url: '/v.mp4', name: 'video1' },
    ])).toBe('image4');
  });

  it('inserts an asset reference at the caret and preserves the suffix', () => {
    expect(insertAssetMention('请参考 继续说明', 4, 'image1')).toEqual({
      text: '请参考 @image1 继续说明',
      caret: 12,
    });
  });
});

describe('extractSessionAssets', () => {
  it('collects completed images and videos in session order with stable names', () => {
    const assets = extractSessionAssets([
      {
        role: 'user',
        content: '生成一张图',
      },
      {
        role: 'assistant',
        content: '',
        tasks: [
          {
            id: 'task-1',
            type: 'image_generation',
            status: 'completed',
            workflowId: 'test',
            prompt: 'test',
            stages: [],
            createdAt: 1,
            updatedAt: 1,
            outputs: [
              { kind: 'image', url: '/image-a.png', filename: 'a.png' },
              { kind: 'video', url: '/video-a.mp4', filename: 'a.mp4' },
              { kind: 'text', url: '/ignored.txt', filename: 'ignored.txt' },
            ],
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        stages: [
          {
            type: 'done',
            outputs: [
              { kind: 'image', url: '/image-a.png', filename: 'duplicate.png' },
              { kind: 'image', url: '/image-b.png', filename: 'b.png' },
            ],
          },
        ],
      },
    ]).map(({ url, kind, name }) => ({ url, kind, name }));

    expect(assets).toEqual([
      { url: '/image-a.png', kind: 'image', name: 'image1' },
      { url: '/video-a.mp4', kind: 'video', name: 'video1' },
      { url: '/image-b.png', kind: 'image', name: 'image2' },
    ]);
  });

  it('finds only assets mentioned by their session names', () => {
    const assets = [
      { kind: 'image' as const, url: '/image-a.png', name: 'image1' },
      { kind: 'video' as const, url: '/video-a.mp4', name: 'video1' },
      { kind: 'image' as const, url: '/image-b.png', name: 'image2' },
    ];

    expect(findMentionedSessionAssets('请修改 @image2，并参考 @video1', assets).map(asset => asset.name)).toEqual([
      'image2',
      'video1',
    ]);
  });

  it('ignores media without a URL', () => {
    expect(extractSessionAssets([
      {
        role: 'assistant',
        content: '',
        stages: [{ type: 'done', outputs: [{ kind: 'image', filename: 'missing-url.png' }] }],
      },
    ])).toEqual([]);
  });
});
