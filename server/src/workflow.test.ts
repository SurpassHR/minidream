import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfDir = path.resolve(__dirname, '../workflows');
const readWf = (name: string) => JSON.parse(fs.readFileSync(path.join(wfDir, name), 'utf8'));

const txt2imgJson = readWf('txt2img.json');
const img2imgJson = readWf('img2img.json');
const krea2T2iJson = readWf('krea2-t2i.json');
const h3T2vJson = readWf('minimax-h3-t2v.json');
const h3Flf2vJson = readWf('minimax-h3-flf2v.json');

const OBJECT_INFO: Record<string, any> = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['sd_xl_base.safetensors', 'v1-5-pruned.safetensors'], { default: 'sd_xl_base.safetensors' }] } },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  KSampler: {
    input: {
      required: {
        seed: ['INT', { default: 0 }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 7 }],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'karras'], {}],
        denoise: ['FLOAT', { default: 1 }],
      },
    },
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }], batch_size: ['INT', { default: 1 }] } },
  },
  LoadImage: {
    input: { required: { image: [['a.png', 'b.png'], {}] } },
    output: ['IMAGE', 'MASK'],
  },
  SaveImage: {
    input: { required: { filename_prefix: ['STRING', { default: 'ComfyUI' }], images: ['IMAGE', {}] } },
    output: ['IMAGE'],
  },
  SaveVideo: {
    input: {
      required: {
        filename_prefix: ['STRING', { default: 'video' }],
        format: [['auto', 'mp4', 'webm'], {}],
        codec: [['auto', 'H264', 'H265'], {}],
      },
      optional: { video: ['VIDEO', {}] },
    },
    output: ['VIDEO'],
  },
  /** 新式动态 schema（COMFY_DYNAMICCOMBO_V3 + 嵌套 inputs，与真实 ComfyUI 0.33 一致） */
  Krea2ImageNode: {
    input: {
      required: {
        prompt: ['STRING', { multiline: true, default: '' }],
        model: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'Krea 2 Medium',
                inputs: {
                  required: {
                    aspect_ratio: ['COMBO', { options: ['1:1', '16:9', '4:3', '3:4', '9:16'] }],
                    resolution: ['COMBO', { options: ['1K', '2K'] }],
                    creativity: ['COMBO', { options: ['raw', 'low', 'medium', 'high'], default: 'medium' }],
                  },
                  optional: {
                    moodboard_id: ['STRING', { default: '' }],
                    moodboard_strength: ['FLOAT', { default: 0.35 }],
                    style_reference: ['KREA_STYLE_REF', {}],
                  },
                },
              },
            ],
          },
        ],
        seed: ['INT', { default: 0 }],
      },
    },
    output: ['IMAGE'],
  },
  Krea2StyleReferenceNode: {
    input: {
      required: { strength: ['FLOAT', { default: 1.0, min: 0, max: 2 }] },
      optional: { image: ['IMAGE', {}], style_reference: ['KREA_STYLE_REF', {}] },
    },
    output: ['KREA_STYLE_REF'],
  },
  MinimaxHailuo03TextToVideoNode: {
    input: {
      required: {
        model: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'MiniMax H3',
                inputs: {
                  required: {
                    prompt: ['STRING', { multiline: true }],
                    resolution: ['COMBO', { options: ['768P', '1080P'] }],
                    ratio: ['COMBO', { options: ['16:9', '9:16', '1:1', 'adaptive'] }],
                    duration: ['COMBO', { options: ['5', '10'] }],
                  },
                },
              },
            ],
          },
        ],
        seed: ['INT', { default: 0 }],
        watermark: ['BOOLEAN', { default: false }],
      },
    },
    output: ['VIDEO'],
  },
  MinimaxHailuo03ReferenceNode: {
    input: {
      required: {
        model: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'MiniMax H3',
                inputs: {
                  required: {
                    prompt: ['STRING', { multiline: true }],
                    resolution: ['COMBO', { options: ['768P', '1080P'] }],
                    ratio: ['COMBO', { options: ['16:9', '9:16', '1:1', 'adaptive'] }],
                    duration: ['COMBO', { options: ['5', '10'] }],
                    reference_images: ['IMAGE', {}],
                    reference_videos: ['VIDEO', {}],
                    reference_audios: ['AUDIO', {}],
                  },
                },
              },
            ],
          },
        ],
        seed: ['INT', { default: 0 }],
        watermark: ['BOOLEAN', { default: false }],
      },
    },
    output: ['VIDEO'],
  },
  MinimaxHailuo03FirstLastFrameNode: {
    input: {
      required: {
        model: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'MiniMax H3',
                inputs: {
                  required: {
                    prompt: ['STRING', { multiline: true }],
                    resolution: ['COMBO', { options: ['768P', '1080P'] }],
                    duration: ['COMBO', { options: ['5', '10'] }],
                  },
                },
              },
            ],
          },
        ],
        seed: ['INT', { default: 0 }],
        watermark: ['BOOLEAN', { default: false }],
      },
      optional: { first_frame: ['IMAGE', {}], last_frame: ['IMAGE', {}] },
    },
    output: ['VIDEO'],
  },
};

describe('workflow 引擎（通用自动适配）', () => {
  let workflow: typeof import('./workflow.js');

  beforeAll(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/object_info')) {
          return new Response(JSON.stringify(OBJECT_INFO), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.includes('/view')) {
          // 模板占位素材文件都不存在 → 404，触发必传标记
          return new Response('not found', { status: 404 });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    vi.resetModules();
    workflow = await import('./workflow.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  /* ---------- API 格式基础 ---------- */

  it('识别 txt2img 的文字输入与图片输出', async () => {
    const spec = await workflow.introspectWorkflow(txt2imgJson);
    expect(spec.inputs.filter(i => i.kind === 'text')).toHaveLength(2);
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'SaveImage' })]);
  });

  it('提取 KSampler/EmptyLatentImage 参数且类型正确', async () => {
    const spec = await workflow.introspectWorkflow(txt2imgJson);
    const byField = Object.fromEntries(spec.params.map(p => [p.field, p]));
    expect(byField.seed?.type).toBe('INT');
    expect(byField.denoise?.type).toBe('FLOAT');
    expect(byField.sampler_name?.type).toBe('combo');
    expect(byField.width?.default).toBe(1024);
  });

  it('用户提示词注入正向 CLIPTextEncode（node 6）而非负向（node 7）', async () => {
    const spec = await workflow.introspectWorkflow(txt2imgJson);
    const prompt = await workflow.buildPrompt(spec, txt2imgJson, { prompt: '一只发光鹿在森林里' });
    expect(prompt['6'].inputs.text).toBe('一只发光鹿在森林里');
    expect(prompt['7'].inputs.text).toBe('lowres, bad anatomy, bad hands, blurry');
  });

  it('ckpt_name 为空时自动选第一个已安装 checkpoint', async () => {
    const spec = await workflow.introspectWorkflow(txt2imgJson);
    const prompt = await workflow.buildPrompt(spec, txt2imgJson, { prompt: '测试' });
    expect(prompt['4'].inputs.ckpt_name).toBe('sd_xl_base.safetensors');
  });

  it('img2img 识别图像输入并注入上传文件名', async () => {
    const spec = await workflow.introspectWorkflow(img2imgJson);
    const imgInput = spec.inputs.find(i => i.kind === 'image');
    expect(imgInput).toBeDefined();
    const prompt = await workflow.buildPrompt(spec, img2imgJson, {
      prompt: '改成夜晚森林',
      uploaded: { [imgInput!.id]: 'ref.png' },
    });
    expect(prompt['10'].inputs.image).toBe('ref.png');
  });

  /* ---------- UI 格式（官方 workflow_templates） ---------- */

  it('UI 格式识别与转换：krea2-t2i 动态 combo 嵌套展平 + randomize 剔除', () => {
    expect(workflow.isUiFormat(krea2T2iJson)).toBe(true);
    expect(workflow.isUiFormat(txt2imgJson)).toBe(false);
    const api = workflow.convertUiToApi(krea2T2iJson, OBJECT_INFO);
    expect(api['1'].class_type).toBe('Krea2ImageNode');
    expect(api['1'].inputs.prompt).toContain('high fashion');
    expect(api['1'].inputs.model).toBe('Krea 2 Medium');
    // 动态 combo 嵌套输入用点号名
    expect(api['1'].inputs['model.aspect_ratio']).toBe('1:1');
    expect(api['1'].inputs['model.resolution']).toBe('1K');
    expect(api['1'].inputs['model.creativity']).toBe('medium');
    expect(api['1'].inputs.seed).toBe(1981045336);
    expect(api['1'].inputs).not.toHaveProperty('randomize');
    expect(api['2'].inputs.images).toEqual(['1', 0]);
    expect(api['2'].inputs.filename_prefix).toBe('Krea2');
  });

  it('UI 格式转换：minimax-h3-t2v 嵌套 prompt 与 seed 的 randomize 跳过', () => {
    const api = workflow.convertUiToApi(h3T2vJson, OBJECT_INFO);
    const inputs = api['23'].inputs;
    expect(inputs.model).toBe('MiniMax H3');
    expect(inputs['model.prompt']).toContain('Single continuous shot');
    expect(inputs['model.resolution']).toBe('768P');
    expect(inputs['model.ratio']).toBe('16:9');
    expect(inputs['model.duration']).toBe(5); // 模板里 duration 为数字
    // randomize 跳过；watermark 字符串转布尔
    expect(inputs.seed).toBe(42);
    expect(inputs.watermark).toBe(false);
    expect(api['8'].inputs.filename_prefix).toBe('video/MiniMax_H3_t2v');
    expect(api['8'].inputs.video).toEqual(['23', 0]);
  });

  it('introspect krea2-t2i：prompt 文字输入 + 图片输出 + seed 参数', async () => {
    const spec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const textInputs = spec.inputs.filter(i => i.kind === 'text');
    expect(textInputs).toHaveLength(1);
    expect(textInputs[0]?.field).toBe('prompt');
    expect(textInputs[0]?.classType).toBe('Krea2ImageNode');
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'SaveImage' })]);
    expect(spec.params.some(p => p.field === 'seed')).toBe(true);
  });

  it('krea2 提示词注入自定义节点的 prompt 字段', async () => {
    const spec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(spec, krea2T2iJson, { prompt: '赛博朋克城市夜景' });
    expect(prompt['1'].inputs.prompt).toBe('赛博朋克城市夜景');
    expect(prompt['1'].inputs.seed).toBe(1981045336);
  });

  it('introspect minimax-h3-t2v：嵌套 prompt 文字输入 + 视频输出', async () => {
    const spec = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    const textInputs = spec.inputs.filter(i => i.kind === 'text');
    expect(textInputs.map(i => i.field)).toEqual(['model.prompt']);
    expect(textInputs[0]?.classType).toBe('MinimaxHailuo03TextToVideoNode');
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'video', classType: 'SaveVideo' })]);
    expect(spec.params.some(p => p.field === 'seed')).toBe(true);
  });

  it('minimax-h3-t2v 提示词注入 model.prompt 字段', async () => {
    const spec = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(spec, h3T2vJson, { prompt: '一只发光鹿在森林里奔跑' });
    expect(prompt['23'].inputs['model.prompt']).toBe('一只发光鹿在森林里奔跑');
    expect(prompt['23'].inputs.model).toBe('MiniMax H3');
  });

  it('minimax-h3-flf2v：首尾帧两个参考图输入 + 视频输出', async () => {
    const spec = await workflow.introspectWorkflow(h3Flf2vJson, OBJECT_INFO);
    const images = spec.inputs.filter(i => i.kind === 'image');
    expect(images).toHaveLength(2);
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'video', classType: 'SaveVideo' })]);
  });

  it('buildSpecs 文件探测：模板占位素材缺失 → 标记必传', async () => {
    const specs = await workflow.buildSpecs();
    const flf2v = specs.find(s => s.id === 'minimax-h3-flf2v');
    expect(flf2v).toBeDefined();
    const images = flf2v!.inputs.filter(i => i.kind === 'image');
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.required).toBe(true);
      expect(img.defaultValue).toBeUndefined();
    }
    const t2v = specs.find(s => s.id === 'minimax-h3-t2v');
    expect(t2v!.inputs.some(i => i.kind === 'image')).toBe(false);
  });
});
