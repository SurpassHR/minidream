import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wfDir = path.resolve(__dirname, '../workflows');
const readWf = (name: string) => JSON.parse(fs.readFileSync(path.join(wfDir, name), 'utf8'));

const h3T2vJson = readWf('video-minimax-h3-t2v.json');
const h3I2vJson = readWf('video-minimax-h3-i2v.json');
const h3R2vJson = readWf('video-minimax-h3-r2v.json');
const krea2T2iJson = readWf('image_krea2_turbo_t2i.json');
const krea2T2iInt8Json = readWf('image_krea2_turbo_t2i_int8.json');
const krea2StyleRefJson = readWf('image_krea2_turbo_int8_image_style_reference.json');

/** 手写的最小 UI 格式（LiteGraph）工作流：全部是纯本地节点 */
const uiFixtureJson = {
  last_node_id: 6,
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      widgets_values: ['v1-5-pruned.safetensors'],
      outputs: [
        { name: 'MODEL', links: [1] },
        { name: 'CLIP', links: [3, 5] },
      ],
    },
    {
      id: 2,
      type: 'CLIPTextEncode',
      title: 'positive',
      widgets_values: ['a cute cat'],
      inputs: [{ name: 'clip', link: 3 }],
      outputs: [{ name: 'CONDITIONING', links: [2] }],
    },
    {
      id: 3,
      type: 'CLIPTextEncode',
      title: 'negative',
      widgets_values: ['lowres, blurry'],
      inputs: [{ name: 'clip', link: 5 }],
      outputs: [{ name: 'CONDITIONING', links: [4] }],
    },
    {
      id: 4,
      type: 'KSampler',
      widgets_values: [42, 'randomize', 20, 7, 'euler', 'normal', 1],
      inputs: [
        { name: 'model', link: 1 },
        { name: 'positive', link: 2 },
        { name: 'negative', link: 4 },
        { name: 'latent_image', link: 6 },
      ],
      outputs: [{ name: 'LATENT', links: [7] }],
    },
    {
      id: 5,
      type: 'EmptyLatentImage',
      widgets_values: [512, 768, 1],
      outputs: [{ name: 'LATENT', links: [6] }],
    },
    {
      id: 6,
      type: 'SaveImage',
      widgets_values: ['director-wb'],
      inputs: [{ name: 'images', link: 7 }],
    },
  ],
  links: [
    [1, 1, 0, 4, 0, 'MODEL'],
    [2, 2, 0, 4, 1, 'CONDITIONING'],
    [3, 1, 1, 2, 0, 'CLIP'],
    [4, 3, 0, 4, 2, 'CONDITIONING'],
    [5, 1, 1, 3, 0, 'CLIP'],
    [6, 5, 0, 4, 3, 'LATENT'],
    [7, 4, 0, 6, 0, 'LATENT'],
  ],
};

const OBJECT_INFO: Record<string, any> = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['sd_xl_base.safetensors', 'v1-5-pruned.safetensors'], { default: 'sd_xl_base.safetensors' }] } },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true, default: '' }] } },
    output: ['CONDITIONING'],
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
  /* ---------- MiniMax H3 本地节点（comfyui-minimax-h3） ---------- */
  ResolutionSelector: {
    input: { required: { aspect_ratio: ['COMBO', {}], megapixels: ['FLOAT', {}], multiple: ['INT', {}] } },
    output: ['INT', 'INT'],
  },
  ImageScaleToTotalPixels: {
    input: { required: { upscale_method: ['COMBO', {}], megapixels: ['FLOAT', {}], resolution_steps: ['INT', {}] }, optional: { image: ['IMAGE', {}] } },
    output: ['IMAGE'],
  },
  GetImageSize: {
    input: { optional: { image: ['IMAGE', {}] } },
    output: ['INT', 'INT', 'INT'],
  },
  VAELoader: {
    input: { required: { vae_name: [['a.safetensors'], {}] } },
    output: ['VAE'],
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT', {}] }, optional: { vae: ['VAE', {}] } },
    output: ['IMAGE'],
  },
  VAEDecodeAudio: {
    input: { required: { samples: ['LATENT', {}] }, optional: { vae: ['VAE', {}] } },
    output: ['AUDIO'],
  },
  KSamplerSelect: {
    input: { required: { sampler_name: [['res_multistep', 'euler'], {}] } },
    output: ['SAMPLER'],
  },
  BasicScheduler: {
    input: { required: { scheduler: ['COMBO', {}], steps: ['INT', {}], denoise: ['FLOAT', {}] }, optional: { model: ['MODEL', {}] } },
    output: ['SIGMAS'],
  },
  BasicGuider: {
    input: { optional: { model: ['MODEL', {}], conditioning: ['CONDITIONING', {}] } },
    output: ['GUIDER'],
  },
  SamplerCustomAdvanced: {
    input: { optional: { noise: ['NOISE', {}], guider: ['GUIDER', {}], sampler: ['SAMPLER', {}], sigmas: ['SIGMAS', {}], latent_image: ['LATENT', {}] } },
    output: ['LATENT', 'LATENT'],
  },
  UNETLoader: {
    input: { required: { unet_name: [['a.safetensors'], {}], weight_dtype: ['COMBO', {}] } },
    output: ['MODEL'],
  },
  TextGenerate: {
    input: {
      required: {
        system_prompt: ['STRING', {}],
        user_prompt: ['STRING', {}],
      },
    },
    output: ['STRING'],
  },
  StringConcatenate: {
    input: {
      required: {
        string_a: ['STRING', {}],
        string_b: ['STRING', {}],
        delimiter: ['STRING', {}],
      },
    },
    output: ['STRING'],
  },
  ConditioningZeroOut: {
    input: { required: { conditioning: ['CONDITIONING', {}] } },
    output: ['CONDITIONING'],
  },
  PreviewAny: {
    input: { required: { source: ['*', {}] } },
    output: ['*'],
  },
  CLIPLoader: {
    input: { required: { clip_name: [['a.safetensors'], {}], type: ['COMBO', {}], device: ['COMBO', {}] } },
    output: ['CLIP'],
  },
  RandomNoise: {
    input: { required: { noise_seed: ['INT', {}] } },
    output: ['NOISE'],
  },
  CreateVideo: {
    input: { required: { fps: ['INT', {}], bit_depth: ['INT', {}] }, optional: { images: ['IMAGE', {}], audio: ['AUDIO', {}] } },
    output: ['VIDEO'],
  },
  ComfyMathExpression: {
    input: { required: { expression: ['STRING', {}] }, optional: { 'values.a': ['FLOAT,INT,BOOLEAN', {}], 'values.b': ['FLOAT,INT,BOOLEAN', {}] } },
    output: ['FLOAT', 'INT', 'BOOLEAN'],
  },
  PrimitiveFloat: {
    input: { required: { value: ['FLOAT', {}] } },
    output: ['FLOAT'],
  },
  PrimitiveInt: {
    input: { required: { value: ['INT', {}] } },
    output: ['INT'],
  },
  PrimitiveBoolean: {
    input: { required: { value: ['BOOLEAN', {}] } },
    output: ['BOOLEAN'],
  },
  PrimitiveStringMultiline: {
    input: { required: { value: ['STRING', { multiline: true }] } },
    output: ['STRING'],
  },
  ComfySwitchNode: {
    input: { required: { switch: ['BOOLEAN', {}] }, optional: { on_false: ['*', {}], on_true: ['*', {}] } },
    output: ['*'],
  },
  LoraLoaderModelOnly: {
    input: { required: { lora_name: [['a.safetensors'], {}], strength_model: ['FLOAT', {}] }, optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  MiniMaxH3ImageToVideo: {
    input: {
      required: { prompt: ['STRING', { multiline: true }], width: ['INT', {}], height: ['INT', {}], length: ['INT', {}] },
      optional: { clip: ['CLIP', {}], vae: ['VAE', {}], first_frame: ['IMAGE', {}], last_frame: ['IMAGE', {}] },
    },
    output: ['CONDITIONING', 'LATENT'],
  },
  MiniMaxH3ReferenceToVideo: {
    input: {
      required: {
        prompt: ['STRING', { multiline: true }],
        width: ['INT', {}],
        height: ['INT', {}],
        length: ['INT', {}],
        ref_images: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'ref',
                inputs: {
                  required: { ref_image_0: ['IMAGE', {}], ref_image_1: ['IMAGE', {}] },
                  optional: { ref_image_2: ['IMAGE', {}] },
                },
              },
            ],
          },
        ],
      },
      optional: { clip: ['CLIP', {}], vae: ['VAE', {}], audio_vae: ['VAE', {}] },
    },
    output: ['CONDITIONING', 'LATENT'],
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

  /* ---------- UI 格式（LiteGraph） ---------- */

  it('UI 格式识别与转换：链接→输入、widget→字段、seed randomize 剔除', () => {
    expect(workflow.isUiFormat(uiFixtureJson)).toBe(true);
    const api = workflow.convertUiToApi(uiFixtureJson, OBJECT_INFO);
    expect(api['4'].class_type).toBe('KSampler');
    expect(api['4'].inputs.model).toEqual(['1', 0]);
    expect(api['4'].inputs.positive).toEqual(['2', 0]);
    expect(api['4'].inputs.latent_image).toEqual(['5', 0]);
    // widget 值按 object_info 顺序映射，seed 后的 randomize 额外值被跳过
    expect(api['4'].inputs.seed).toBe(42);
    expect(api['4'].inputs.steps).toBe(20);
    expect(api['4'].inputs.cfg).toBe(7);
    expect(api['4'].inputs.sampler_name).toBe('euler');
    expect(api['4'].inputs.scheduler).toBe('normal');
    expect(api['4'].inputs.denoise).toBe(1);
    expect(api['4'].inputs).not.toHaveProperty('randomize');
    expect(api['2'].inputs.text).toBe('a cute cat');
    expect(api['5'].inputs.width).toBe(512);
    expect(api['5'].inputs.height).toBe(768);
    expect(api['6'].inputs.filename_prefix).toBe('director-wb');
    expect(api['6'].inputs.images).toEqual(['4', 0]);
  });

  it('UI 格式工作流 introspection：文字输入 + 图片输出 + 参数提取', async () => {
    const spec = await workflow.introspectWorkflow(uiFixtureJson, OBJECT_INFO);
    const textInputs = spec.inputs.filter(i => i.kind === 'text');
    expect(textInputs).toHaveLength(2);
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'SaveImage' })]);
    const byField = Object.fromEntries(spec.params.map(p => [p.field, p]));
    expect(byField.seed?.type).toBe('INT');
    expect(byField.width?.default).toBe(512);
    expect(byField.sampler_name?.options).toEqual(['euler', 'dpmpp_2m']);
  });

  it('UI 格式提示词注入正向 CLIPTextEncode 节点', async () => {
    const spec = await workflow.introspectWorkflow(uiFixtureJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(spec, uiFixtureJson, { prompt: '赛博朋克城市夜景' });
    expect(prompt['2'].inputs.text).toBe('赛博朋克城市夜景');
  });

  it('根据 imageGen settings 注入默认参数与随机/固定 seed', async () => {
    const spec = await workflow.introspectWorkflow(uiFixtureJson, OBJECT_INFO);
    const promptFixed = await workflow.buildPrompt(spec, uiFixtureJson, {
      prompt: '测试固定种子',
      settings: {
        seedMode: 'fixed',
        seed: 123456,
        steps: 25,
        cfg: 8.5,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 0.8,
        width: 768,
        height: 768,
      },
    });
    expect(promptFixed['4'].inputs.seed).toBe(123456);
    expect(promptFixed['4'].inputs.steps).toBe(25);
    expect(promptFixed['4'].inputs.cfg).toBe(8.5);
    expect(promptFixed['4'].inputs.sampler_name).toBe('dpmpp_2m');
    expect(promptFixed['4'].inputs.scheduler).toBe('karras');
    expect(promptFixed['4'].inputs.denoise).toBe(0.8);
    expect(promptFixed['5'].inputs.width).toBe(768);
    expect(promptFixed['5'].inputs.height).toBe(768);

    const promptRandom = await workflow.buildPrompt(spec, uiFixtureJson, {
      prompt: '测试随机种子',
      settings: {
        seedMode: 'random',
        seed: -1,
        steps: 20,
        cfg: 7.0,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1.0,
        width: 1024,
        height: 1024,
      },
    });
    expect(typeof promptRandom['4'].inputs.seed).toBe('number');
    expect(promptRandom['4'].inputs.seed).toBeGreaterThanOrEqual(0);
  });

  it('buildSpecs 文件探测：占位素材缺失 → 标记必传', async () => {
    const specs = await workflow.buildSpecs();
    const styleRef = specs.find(s => s.id === 'image_krea2_turbo_int8_image_style_reference');
    expect(styleRef).toBeDefined();
    const images = styleRef!.inputs.filter(i => i.kind === 'image');
    expect(images).toHaveLength(1);
    for (const img of images) {
      expect(img.required).toBe(true);
      expect(String(img.defaultValue ?? '').trim()).toBe('');
    }
    const t2i = specs.find(s => s.id === 'image_krea2_turbo_t2i');
    expect(t2i!.inputs.some(i => i.kind === 'image')).toBe(false);
  });

  /* ---------- MiniMax H3 本地模板（templates/video_minimax_h3_*） ---------- */

  it('子图展开：t2v 实例替换为内部节点，提示词/分辨率/时长正确接线', () => {
    const api = workflow.convertUiToApi(h3T2vJson, OBJECT_INFO);
    const h3 = api['140_sg131'];
    expect(h3.class_type).toBe('MiniMaxH3ImageToVideo');
    expect(typeof h3.inputs.prompt).toBe('string');
    expect(h3.inputs.prompt.length).toBeGreaterThan(10); // 实例 named 值注入
    expect(h3.inputs.width).toEqual(['115', 0]);
    expect(h3.inputs.height).toEqual(['115', 1]);
    expect(h3.inputs.length).toEqual(['140_sg132', 1]); // ComfyMathExpression
    expect(h3.inputs.clip).toEqual(['140_sg128', 0]);
    expect(h3.inputs).not.toHaveProperty('first_frame');
    expect(h3.inputs).not.toHaveProperty('last_frame');
    // wi-skip：已连接字段跳过对应位置 widget 值 → type/device 映射正确
    expect(api['140_sg128'].inputs.clip_name).toBe('qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors');
    expect(api['140_sg128'].inputs.type).toBe('minimax');
    expect(api['140_sg128'].inputs.device).toBe('default');
    expect(api['140_sg127'].inputs.unet_name).toBe('minimax_h3_fl2va_pruned_int8_convrot.safetensors');
    expect(api['92'].class_type).toBe('SaveVideo');
    expect(api['92'].inputs.video).toEqual(['140_sg130', 0]);
    // 无残留子图实例节点
    expect(Object.values(api).some((n: any) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(n.class_type))).toBe(false);
  });

  it('子图展开：i2v 参考图链接到 LoadImage，宽度来自 ResolutionSelector', () => {
    const api = workflow.convertUiToApi(h3I2vJson, OBJECT_INFO);
    const h3 = api['105_sg104'];
    expect(h3.class_type).toBe('MiniMaxH3ImageToVideo');
    expect(h3.inputs.first_frame).toEqual(['114', 0]);
    expect(h3.inputs.width).toEqual(['115', 0]);
    expect(h3.inputs.height).toEqual(['115', 1]);
    expect(api['114'].class_type).toBe('LoadImage');
    expect(api['114'].inputs.image).toBe('transparent_rgb_gaming_mouse.png');
  });

  it('r2v（无子图）：参考图/提示词经链接接入 MiniMaxH3ReferenceToVideo', () => {
    const api = workflow.convertUiToApi(h3R2vJson, OBJECT_INFO);
    expect(api['136'].class_type).toBe('MiniMaxH3ReferenceToVideo');
    expect(api['136'].inputs.prompt).toEqual(['138', 0]);
    expect(api['138'].class_type).toBe('PrimitiveStringMultiline');
    expect(api['136'].inputs['ref_images.ref_image_0']).toEqual(['137', 0]);
    expect(api['136'].inputs['ref_images.ref_image_1']).toEqual(['139', 0]);
  });

  it('本地 H3 模板 introspection：文字/参考图输入 + 视频输出', async () => {
    const t2v = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    expect(t2v.inputs.filter(i => i.kind === 'text')).toHaveLength(1);
    expect(t2v.inputs.some(i => i.kind === 'image')).toBe(false);
    expect(t2v.outputs).toEqual([expect.objectContaining({ kind: 'video', classType: 'SaveVideo' })]);

    const i2v = await workflow.introspectWorkflow(h3I2vJson, OBJECT_INFO);
    expect(i2v.inputs.filter(i => i.kind === 'image')).toHaveLength(1);
    expect(i2v.inputs.filter(i => i.kind === 'text')).toHaveLength(1);

    const r2v = await workflow.introspectWorkflow(h3R2vJson, OBJECT_INFO);
    expect(r2v.inputs.filter(i => i.kind === 'image')).toHaveLength(2);
    expect(r2v.inputs.filter(i => i.kind === 'text')).toHaveLength(1);
    expect(r2v.inputs.find(i => i.kind === 'text')?.classType).toBe('PrimitiveStringMultiline');
  });

  it('本地 H3 模板提示词注入：t2v 注入 H3 节点 prompt，r2v 注入 PrimitiveString 节点', async () => {
    const t2vSpec = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    const t2vPrompt = await workflow.buildPrompt(t2vSpec, h3T2vJson, { prompt: '一只发光鹿在森林里奔跑' });
    expect(t2vPrompt['140_sg131'].inputs.prompt).toBe('一只发光鹿在森林里奔跑');

    const r2vSpec = await workflow.introspectWorkflow(h3R2vJson, OBJECT_INFO);
    const r2vPrompt = await workflow.buildPrompt(r2vSpec, h3R2vJson, { prompt: '参考图上的人物望向镜头' });
    expect(r2vPrompt['138'].inputs.value).toBe('参考图上的人物望向镜头');
    expect(r2vPrompt['136'].inputs.prompt).toEqual(['138', 0]);
  });

  it('Krea2 Turbo 模板 introspection 与 buildPrompt 正确处理子图展开、提示词与参考图注入', async () => {
    // 1. Krea2 T2I (FP8)
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    expect(t2iSpec.inputs.some(i => i.kind === 'image')).toBe(false);
    expect(t2iSpec.inputs.some(i => i.kind === 'text')).toBe(true);
    expect(t2iSpec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'SaveImage' })]);

    const t2iPrompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, { prompt: 'A futuristic city in neon rain' });
    expect(t2iPrompt['30_sg19'].class_type).toBe('PrimitiveStringMultiline');
    expect(t2iPrompt['30_sg19'].inputs.value).toBe('A futuristic city in neon rain');
    expect(t2iPrompt['29'].class_type).toBe('SaveImage');

    // 2. Krea2 T2I (INT8)
    const t2iInt8Spec = await workflow.introspectWorkflow(krea2T2iInt8Json, OBJECT_INFO);
    const t2iInt8Prompt = await workflow.buildPrompt(t2iInt8Spec, krea2T2iInt8Json, { prompt: 'Int8 test prompt' });
    expect(t2iInt8Prompt['30_sg19'].inputs.value).toBe('Int8 test prompt');

    // 3. Krea2 Style Reference (INT8)
    const styleSpec = await workflow.introspectWorkflow(krea2StyleRefJson, OBJECT_INFO);
    expect(styleSpec.inputs.some(i => i.kind === 'image')).toBe(true);
    expect(styleSpec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'SaveImage' })]);

    const stylePrompt = await workflow.buildPrompt(styleSpec, krea2StyleRefJson, {
      prompt: 'A fantasy treehouse',
      uploaded: { 'image-69': 'style_input.png' },
    });
    expect(stylePrompt['30_sg19'].inputs.value).toBe('A fantasy treehouse');
    expect(stylePrompt['69'].class_type).toBe('LoadImage');
    expect(stylePrompt['69'].inputs.image).toBe('style_input.png');
  });
});
