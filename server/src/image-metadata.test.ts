import { describe, expect, it } from 'vitest';
import { buildGenerationMetadata } from './image-metadata.js';

describe('generation image metadata', () => {
  it('uses effective execution params for the image preview', () => {
    expect(buildGenerationMetadata({
      id: 'task-1',
      workflowId: 'image_krea2_turbo_t2i',
      prompt: 'A cinematic portrait',
      params: { seed: 1 },
      generationParams: { seed: 42, sampler_name: 'euler', width: 1024 },
      ratio: '16:9',
      size: 2,
      createdAt: 123,
    })).toEqual({
      taskId: 'task-1',
      workflowId: 'image_krea2_turbo_t2i',
      prompt: 'A cinematic portrait',
      params: { seed: 42, sampler_name: 'euler', width: 1024 },
      ratio: '16:9',
      size: 2,
      createdAt: 123,
    });
  });

  it('falls back to request params for older tasks without effective params', () => {
    expect(buildGenerationMetadata({
      id: 'task-2',
      workflowId: 'image_seedvr2_upscale',
      prompt: 'Upscale the image',
      params: { seed: 42 },
      createdAt: 456,
    }).params).toEqual({ seed: 42 });
  });
});
