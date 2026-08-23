import { describe, expect, it } from 'vitest';
import { validateWorkflowManifest } from './workflow-plugin-api.js';
import type { WorkflowSpec } from './workflow.js';

const manifest: WorkflowSpec = {
  id: 'demo',
  name: 'Demo',
  inputs: [],
  params: [{
    id: 'lora-7',
    label: 'LoRA',
    nodeId: '7',
    field: 'lora',
    type: 'combo',
    multiple: true,
    strengthable: true,
    default: [{ name: 'style.safetensors', strength: 0.7 }],
  }],
  outputs: [{ id: 'image-8', kind: 'image', label: 'Image', nodeId: '8', classType: 'SaveImage' }],
};

const workflow = {
  '7': {
    class_type: 'Power Lora Loader (rgthree)',
    inputs: { lora_1: { on: true, lora: 'style.safetensors', strength: 0.7 } },
  },
  '8': { class_type: 'SaveImage', inputs: { images: ['7', 0] } },
};

describe('logical workflow fields', () => {
  it('accepts Power Lora logical lora mapping', async () => {
    await expect(validateWorkflowManifest(manifest, workflow, {})).resolves.toBeNull();
  });
});
