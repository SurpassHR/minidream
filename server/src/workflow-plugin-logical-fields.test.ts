import { describe, expect, it } from 'vitest';
import { validateParamMappings, validateWorkflowManifest } from './workflow-plugin-api.js';
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

  it('accepts logical lora mapping when the graph only exposes physical lora slots', () => {
    const graph = {
      nodes: [{
        nodeId: '7',
        classType: 'Power Lora Loader (rgthree)',
        title: 'Power Lora Loader',
        x: 0,
        y: 0,
        fields: [{
          nodeId: '7',
          field: 'lora_1',
          type: 'UNKNOWN',
          selectable: false,
          connected: false,
          selected: false,
        }],
      }],
    };
    expect(validateParamMappings(manifest, graph as any)).toBeNull();
  });

  it('accepts logical lora mapping when the graph exposes the synthesized lora field', () => {
    const graph = {
      nodes: [{
        nodeId: '554',
        classType: 'Power Lora Loader (rgthree)',
        title: 'Power Lora Loader (rgthree)',
        x: 0,
        y: 0,
        fields: [{
          nodeId: '554',
          field: 'lora',
          type: 'COMBO',
          selectable: true,
          connected: false,
          selected: true,
          multiple: true,
          strengthable: true,
        }],
      }],
    };
    const loraManifest = {
      ...manifest,
      params: [{ ...manifest.params[0]!, nodeId: '554', id: 'lora-554' }],
    };
    expect(validateParamMappings(loraManifest, graph as any)).toBeNull();
  });

  it('accepts logical lora mapping from a real Power Lora Loader JSON node without lora_N fields', async () => {
    const loraManifest: WorkflowSpec = {
      id: 'ui-like',
      name: 'UI-like',
      inputs: [],
      params: [{
        id: 'lora-554',
        label: 'lora',
        nodeId: '554',
        field: 'lora',
        type: 'combo',
        multiple: true,
        strengthable: true,
        default: [{ name: 'style.safetensors', strength: 1 }],
      }],
      outputs: [{ id: 'image-578', kind: 'image', label: 'Image', nodeId: '578', classType: 'PreviewImage', slot: 0, type: 'IMAGE' }],
    };
    const uiLikeWorkflow = {
      '554': {
        class_type: 'Power Lora Loader (rgthree)',
        inputs: {
          PowerLoraLoaderHeaderWidget: { type: 'PowerLoraLoaderHeaderWidget' },
          '➕ Add Lora': '',
          model: ['520', 0],
          clip: ['480', 0],
        },
      },
      '578': { class_type: 'PreviewImage', inputs: { images: ['540', 0] } },
    };
    const objectInfoData = {
      PreviewImage: { output: ['IMAGE'] },
    };
    await expect(validateWorkflowManifest(loraManifest, uiLikeWorkflow, objectInfoData, true)).resolves.toBeNull();
  });
});
