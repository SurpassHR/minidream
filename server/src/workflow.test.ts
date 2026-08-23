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
const seedvr2Json = readWf('image_seedvr2_upscale.json');

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
        scheduler: [['normal', 'karras', 'simple', 'exponential', 'sgm_uniform', 'ddim_uniform', 'beta'], {}],
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
  PreviewImage: {
    input: { required: { images: ['IMAGE', {}] } },
    output: ['IMAGE'],
  },
  SaveVideo: {
    input: { required: { filename_prefix: ['STRING', { default: 'ComfyUI' }] }, optional: { images: ['IMAGE', {}], video: ['VIDEO', {}] } },
    output: ['VIDEO'],
  },
  LatentUpscaleBy: {
    input: { required: { upscale_method: ['COMBO', {}], scale_by: ['FLOAT', {}] }, optional: { samples: ['LATENT', {}] } },
    output: ['LATENT'],
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
    input: {
      required: {
        vae_name: [
          [
            'a.safetensors',
            'minimax_h3_video_vae_fp16.safetensors',
            'minimax_h3_audio_vae_fp32.safetensors',
            'qwen_image_vae.safetensors',
            'Wan2.1_VAE.pth',
            'flux2-vae.safetensors',
          ],
          {},
        ],
      },
    },
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
    input: { required: { sampler_name: ['COMBO', { options: ['res_multistep', 'euler', 'dpmpp_2m'] }] } },
    output: ['SAMPLER'],
  },
  BasicScheduler: {
    input: { required: { scheduler: ['COMBO', { options: ['simple', 'karras', 'normal'] }], steps: ['INT', {}], denoise: ['FLOAT', {}] }, optional: { model: ['MODEL', {}] } },
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
    input: {
      required: {
        unet_name: [
          [
            'a.safetensors',
            // 模板实际引用的模型（与 ComfyUI 常见安装目录一致，供 buildPrompt 校验）
            'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
            'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
            'krea2_turbo_fp8_scaled.safetensors',
            'KREA2/krea2_turbo_int8_convrot.safetensors',
            'FLUX/KLEIN/fluxKleinFP8_flux2Klein9bFp8.safetensors',
            'KREA2/pornmasterKrea2_v2TurboInt8.safetensors',
          ],
          {},
        ],
        weight_dtype: ['COMBO', {}],
      },
    },
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
    input: {
      required: {
        clip_name: [
          ['a.safetensors', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'qwen3vl_4b_fp8_scaled.safetensors', 'Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors'],
          {},
        ],
        type: ['COMBO', {}],
        device: ['COMBO', {}],
      },
    },
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
  LoraLoader: {
    input: {
      required: {
        lora_name: [
          [
            'None',
            'a.safetensors',
            'KREA2/Afterlight_v1.safetensors',
            'KREA2/lenovo_krea2.safetensors',
            'KREA2/RealisticSnapshotKrea2.safetensors',
          ],
          {},
        ],
        strength_model: ['FLOAT', {}],
        strength_clip: ['FLOAT', {}],
      },
    },
    output: ['MODEL', 'CLIP'],
  },
  LoraLoaderModelOnly: {
    input: {
      required: {
        lora_name: [
          [
            'a.safetensors',
            'KREA2/Afterlight_v1.safetensors',
            'krea2_style_reference.safetensors',
            'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
            'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
          ],
          {},
        ],
        strength_model: ['FLOAT', {}],
      },
      optional: { model: ['MODEL', {}] },
    },
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
  /* ---------- 新 Krea2 Turbo 模板（fluxKlein + KJNodes 全局变量）节点 ---------- */
  GetNode: {
    input: { required: { Constant: ['STRING', {}] } },
    output: ['MODEL'],
  },
  SetNode: {
    input: {
      optional: {
        MODEL: ['MODEL', {}],
        CLIP: ['CLIP', {}],
        CONDITIONING: ['CONDITIONING', {}],
        LATENT: ['LATENT', {}],
        VAE: ['VAE', {}],
        STRING: ['STRING', {}],
      },
    },
    output: [],
  },
  KSamplerAdvanced: {
    input: {
      // 与真实 ComfyUI 一致：control_after_generate 是前端专用值，不在后端 schema 里
      required: {
        model: ['MODEL', {}],
        add_noise: [['enable', 'disable'], {}],
        noise_seed: ['INT', {}],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'er_sde', 'dpmpp_sde', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'simple', 'karras'], {}],
        positive: ['CONDITIONING', {}],
        negative: ['CONDITIONING', {}],
        latent_image: ['LATENT', {}],
        start_at_step: ['INT', {}],
        end_at_step: ['INT', {}],
        return_with_leftover_noise: [['enable', 'disable'], {}],
      },
      optional: {},
    },
    output: ['LATENT'],
  },
  CLIPLoaderGGUF: {
    input: {
      required: {
        clip_name: [['Qwen3-8B-Q8_0.gguf'], {}],
        type: [['flux2'], {}],
      },
    },
    output: ['CLIP'],
  },
  ApplyKrea2NegPiP: {
    input: {
      required: {
        value_strength: ['FLOAT', {}],
        patch_txtfusion_refiners: ['BOOLEAN', {}],
        block_start: ['INT', {}],
        block_end: ['INT', {}],
        block_stride: ['INT', {}],
      },
      optional: { model: ['MODEL', {}], clip: ['CLIP', {}] },
    },
    output: ['MODEL', 'CLIP'],
  },
  PathchSageAttentionKJ: {
    input: { optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  FluxKVCache: {
    input: { optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  DyPE_FLUX: {
    input: { optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  SEGA: {
    input: { optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  'Power Lora Loader (rgthree)': {
    input: { optional: { model: ['MODEL', {}] } },
    output: ['MODEL'],
  },
  RTXVideoSuperResolution: {
    input: {
      required: {
        upscale_method: ['COMBO', {}],
        factor: ['INT', {}],
        quality: ['COMBO', {}],
      },
      optional: { image: ['IMAGE', {}] },
    },
    output: ['IMAGE'],
  },
  'Text Concatenate': {
    input: {
      required: {
        text_a: ['STRING', { multiline: true }],
        text_b: ['STRING', { multiline: true }],
        text_c: ['STRING', { multiline: true }],
        text_d: ['STRING', {}],
      },
    },
    output: ['STRING'],
  },
  'Text Multiline': {
    input: { required: { text: ['STRING', { multiline: true }] } },
    output: ['STRING'],
  },
  'StyleStringInjector2 //ZImagePowerNodes': {
    input: { optional: { string: ['STRING', {}] } },
    output: ['STRING'],
  },
  'ShowText|pysssss': {
    input: { required: { text: ['STRING', {}] } },
    output: ['STRING'],
  },
  Seed: {
    input: {
      required: {
        seed: ['INT', {}],
        control_after_generate: [['randomize', 'fixed', 'increment', 'decrement'], {}],
      },
    },
    output: ['INT'],
  },
  'SimpleMath+': {
    input: { required: { value: ['STRING', {}] }, optional: { a: ['FLOAT', {}], b: ['FLOAT', {}] } },
    output: ['FLOAT'],
  },
  'easy ifElse': {
    input: { optional: { boolean: ['BOOLEAN', {}], on_true: ['*', {}], on_false: ['*', {}] } },
    output: ['*'],
  },
  /* ---------- SeedVR2 图像放大（numz/ComfyUI-SeedVR2_VideoUpscaler + TTPlanetPig/Comfyui_TTP_Toolset） ---------- */
  ImageScaleBy: {
    input: { required: { upscale_method: [['lanczos', 'nearest-exact', 'bilinear'], {}], scale_by: ['FLOAT', {}] }, optional: { image: ['IMAGE', {}] } },
    output: ['IMAGE'],
  },
  'Get Image Size': {
    input: { optional: { image: ['IMAGE', {}] } },
    output: ['INT', 'INT'],
  },
  TTP_Image_Tile_Batch: {
    input: { required: { tile_width: ['INT', {}], tile_height: ['INT', {}] }, optional: { image: ['IMAGE', {}] } },
    output: ['IMAGE', 'IMAGE', 'IMAGE', 'IMAGE'],
  },
  TTP_Tile_image_size: {
    input: { required: { overlap_rate: ['FLOAT', {}] }, optional: { width_factor: ['FLOAT', {}], height_factor: ['FLOAT', {}], image: ['IMAGE', {}] } },
    output: ['INT', 'INT'],
  },
  TTP_Image_Assy: {
    input: { required: { padding: ['INT', {}] }, optional: { tiles: ['IMAGE', {}], positions: ['IMAGE', {}], original_size: ['IMAGE', {}], grid_size: ['IMAGE', {}] } },
    output: ['IMAGE'],
  },
  SeedVR2LoadDiTModel: {
    input: {
      required: {
        model: [['seedvr2_ema_3b_fp8_e4m3fn.safetensors', 'seedvr2_ema_3b_fp16.safetensors'], {}],
        device: [['cuda:0', 'cpu'], {}],
        blocks_to_swap: ['INT', {}],
        swap_io_components: ['BOOLEAN', {}],
        offload_device: [['cpu', 'cuda:0'], {}],
        cache_model: ['BOOLEAN', {}],
        attention_mode: [['sdpa', 'flash_attention'], {}],
      },
    },
    output: ['SEEDVR2_DIT'],
  },
  SeedVR2LoadVAEModel: {
    input: {
      required: {
        model: [['ema_vae_fp16.safetensors'], {}],
        device: [['cuda:0', 'cpu'], {}],
        encode_tiled: ['BOOLEAN', {}],
        encode_tile_size: ['INT', {}],
        encode_tile_overlap: ['INT', {}],
        decode_tiled: ['BOOLEAN', {}],
        decode_tile_size: ['INT', {}],
        decode_tile_overlap: ['INT', {}],
        tile_debug: [['false', 'true'], {}],
        offload_device: [['cpu', 'cuda:0'], {}],
        cache_model: ['BOOLEAN', {}],
      },
    },
    output: ['SEEDVR2_VAE'],
  },
  SeedVR2VideoUpscaler: {
    input: {
      required: {
        seed: ['INT', {}],
        resolution: ['INT', {}],
        max_resolution: ['INT', {}],
        batch_size: ['INT', {}],
        uniform_batch_size: ['BOOLEAN', {}],
        color_correction: [['wavelet', 'lab', 'hsv', 'adain'], {}],
        temporal_overlap: ['INT', {}],
        prepend_frames: ['INT', {}],
        input_noise_scale: ['FLOAT', {}],
        latent_noise_scale: ['FLOAT', {}],
        offload_device: [['cpu', 'cuda:0'], {}],
        enable_debug: ['BOOLEAN', {}],
      },
      optional: { image: ['IMAGE', {}], dit: ['SEEDVR2_DIT', {}], vae: ['SEEDVR2_VAE', {}] },
    },
    output: ['IMAGE'],
  },
  ResizeImageMaskNode: {
    input: {
      required: {
        resize_type: [
          'COMFY_DYNAMICCOMBO_V3',
          {
            options: [
              {
                key: 'scale dimensions',
                inputs: { required: { width: ['INT', {}], height: ['INT', {}] }, optional: { crop: ['COMBO', {}] } },
              },
            ],
          },
        ],
        scale_method: [['lanczos', 'bilinear'], {}],
      },
      optional: { input: ['IMAGE', {}] },
    },
    output: ['IMAGE'],
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

  it('按输出映射过滤 history 产物节点', () => {
    const spec = {
      id: 'demo', name: 'Demo', inputs: [], params: [],
      outputs: [{ id: 'images-9', kind: 'image' as const, label: '最终图片', nodeId: '9', classType: 'SaveImage' }],
    };
    const filtered = workflow.filterHistoryOutputs(spec, {
      '9': { images: [{ filename: 'final.png' }] },
      '10': { images: [{ filename: 'internal.png' }] },
    });
    expect(Object.keys(filtered)).toEqual(['9']);
  });

  it('手动 manifest 的数字和布尔参数注入前转换为 ComfyUI 类型', async () => {
    const spec = {
      id: 'manual',
      name: 'Manual',
      inputs: [{ id: 'text-2', kind: 'text' as const, label: '提示词', nodeId: '2', field: 'text', classType: 'CLIPTextEncode' }],
      params: [
        { id: 'steps-4', label: '步数', nodeId: '4', field: 'steps', type: 'INT' as const, default: 20 },
        { id: 'enabled-4', label: '启用', nodeId: '4', field: 'enabled', type: 'BOOLEAN' as const, default: false },
      ],
      outputs: [{ id: 'images-6', kind: 'image' as const, label: '结果', nodeId: '6', classType: 'SaveImage' }],
    };
    const prompt = await workflow.buildPrompt(spec, {
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'default' } },
      '4': { class_type: 'KSampler', inputs: { model: ['2', 0], steps: 20, enabled: false } },
      '6': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    }, { prompt: 'manual', params: { 'steps-4': '28', 'enabled-4': 'true' } });
    expect(prompt['4'].inputs.steps).toBe(28);
    expect(prompt['4'].inputs.enabled).toBe(true);
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

  it('UI 格式 Set/Get 虚拟节点解析：Get 输出重定向到同名 Set 输入来源，虚拟节点移除', () => {
    const fixture = {
      last_node_id: 4,
      nodes: [
        { id: 1, type: 'UNETLoader', widgets_values: ['a.safetensors', 'default'], outputs: [{ name: 'MODEL', links: [10] }] },
        { id: 2, type: 'SetNode', widgets_values: ['MOD'], properties: { previousName: 'MOD' }, inputs: [{ name: 'MODEL', link: 10 }], outputs: [{ name: 'MODEL', links: [] }] },
        { id: 3, type: 'GetNode', widgets_values: ['MOD'], outputs: [{ name: 'MODEL', links: [11] }] },
        { id: 4, type: 'FluxKVCache', inputs: [{ name: 'model', link: 11 }], outputs: [] },
      ],
      links: [
        [10, 1, 0, 2, 0, 'MODEL'],
        [11, 3, 0, 4, 0, 'MODEL'],
      ],
    };
    const api = workflow.convertUiToApi(fixture, OBJECT_INFO);
    // Get(MOD) → Set(MOD) 输入来源 UNETLoader
    expect(api['4'].inputs.model).toEqual(['1', 0]);
    // Set/Get 虚拟节点不再出现在 API 图里（否则 /prompt 报 missing_node_type）
    expect(Object.keys(api)).not.toContain('2');
    expect(Object.keys(api)).not.toContain('3');
    expect(Object.values(api).some((n: any) => n.class_type === 'SetNode' || n.class_type === 'GetNode')).toBe(false);
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

  it('imageGen settings 仅注入 seed 与宽高，采样参数保留工作流设计', async () => {
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
    // 全局 settings 覆盖 seed 与宽高
    expect(promptFixed['4'].inputs.seed).toBe(123456);
    expect(promptFixed['5'].inputs.width).toBe(768);
    expect(promptFixed['5'].inputs.height).toBe(768);
    // 采样参数（steps/cfg/sampler/scheduler/denoise）不再被全局默认覆盖，保留工作流模板值
    expect(promptFixed['4'].inputs.steps).toBe(20);
    expect(promptFixed['4'].inputs.cfg).toBe(7);
    expect(promptFixed['4'].inputs.sampler_name).toBe('euler');
    expect(promptFixed['4'].inputs.scheduler).toBe('normal');
    expect(promptFixed['4'].inputs.denoise).toBe(1);

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
    const i2v = specs.find(s => s.id === 'video-minimax-h3-i2v');
    expect(i2v).toBeDefined();
    const images = i2v!.inputs.filter(i => i.kind === 'image');
    expect(images).toHaveLength(1);
    for (const img of images) {
      expect(img.required).toBe(true);
      expect(String(img.defaultValue ?? '').trim()).toBe('');
    }
    const t2i = specs.find(s => s.id === 'image_krea2_turbo_t2i');
    expect(t2i!.inputs.some(i => i.kind === 'image')).toBe(false);
    const up = specs.find(s => s.id === 'image_seedvr2_upscale');
    expect(up).toBeDefined();
    const upImages = up!.inputs.filter(i => i.kind === 'image');
    expect(upImages).toHaveLength(1);
    expect(upImages[0]!.required).toBe(true);
    expect(String(upImages[0]!.defaultValue ?? '').trim()).toBe('');
  });

  /* ---------- SeedVR2 图像放大（API 格式：numz 官方节点 + TTP Toolset 分块） ---------- */

  it('SeedVR2 放大模板 introspection：图像输入 + 图片输出 + seed 参数', async () => {
    const spec = await workflow.introspectWorkflow(seedvr2Json, OBJECT_INFO);
    const images = spec.inputs.filter(i => i.kind === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]!.classType).toBe('LoadImage');
    expect(images[0]!.defaultValue).toBe('pasted/image (237).png');
    expect(spec.inputs.some(i => i.kind === 'text')).toBe(false);
    expect(spec.outputs).toEqual([expect.objectContaining({ kind: 'image', classType: 'PreviewImage' })]);
    // 仅暴露 seed 参数（其余参数保持工作流默认值）
    expect(spec.params).toEqual([expect.objectContaining({ field: 'seed', nodeId: '14', type: 'INT', default: 42 })]);
  });

  it('SeedVR2 放大模板 buildPrompt：上传图注入 + seed 注入 + 全节点保留', async () => {
    const spec = await workflow.introspectWorkflow(seedvr2Json, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(spec, seedvr2Json, {
      uploaded: { 'image-17': 'myphoto.png' },
      settings: { seedMode: 'fixed', seed: 123, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1, width: 1024, height: 1024 },
    });
    expect(prompt['17'].inputs.image).toBe('myphoto.png');
    expect(prompt['14'].inputs.seed).toBe(123);

    // 随机种子必须落在节点字段上限内（uint32），避免 ComfyUI 校验拒绝
    const promptRandom = await workflow.buildPrompt(spec, seedvr2Json, {
      uploaded: { 'image-17': 'myphoto.png' },
      settings: { seedMode: 'random', seed: -1, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1, width: 1024, height: 1024 },
    });
    const seedVal = promptRandom['14'].inputs.seed as number;
    expect(Number.isInteger(seedVal)).toBe(true);
    expect(seedVal).toBeGreaterThanOrEqual(0);
    expect(seedVal).toBeLessThanOrEqual(4294967295);
    expect(prompt['9'].class_type).toBe('PreviewImage');
    expect(prompt['9'].inputs.images).toEqual(['4', 0]);
    // 顶层 _meta 已剥离；无死节点裁剪（所有节点从 PreviewImage 反向可达）
    expect(prompt['_meta']).toBeUndefined();
    expect(Object.keys(prompt)).toHaveLength(15);
    expect(Object.values(prompt).some((n: any) => n.class_type === 'TTP_Image_Assy')).toBe(true);
    expect(Object.values(prompt).some((n: any) => n.class_type === 'SeedVR2VideoUpscaler')).toBe(true);
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

  it('Krea2 Turbo 模板（官方导出的 API 格式）introspection 与 buildPrompt 正确处理提示词/参数注入', async () => {
    // 官方导出的 API 格式：Set/Get 与 BYPASS 已由 ComfyUI 前端解析为直接连线
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    expect(t2iSpec.inputs.some(i => i.kind === 'image')).toBe(false);
    expect(t2iSpec.inputs.some(i => i.kind === 'text')).toBe(true);
    expect(t2iSpec.outputs.some(o => o.kind === 'image' && o.classType === 'PreviewImage')).toBe(true);
    // #555 被标记为提示词占位节点：作为 primary 文字输入暴露
    const primaryText = t2iSpec.inputs.find(i => i.kind === 'text' && i.primary);
    expect(primaryText).toEqual(expect.objectContaining({ nodeId: '555', field: 'text', classType: 'Text Multiline' }));

    const t2iPrompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, { prompt: 'A futuristic city in neon rain' });
    // 提示词写入 #555 占位节点，经前缀/后缀/风格管线流入 CLIPTextEncode；
    // #553 → #477 的 text 链接保持不被替换
    expect(t2iPrompt['555'].class_type).toBe('Text Multiline');
    expect(t2iPrompt['555'].inputs.text).toBe('A futuristic city in neon rain');
    expect(t2iPrompt['477'].class_type).toBe('CLIPTextEncode');
    expect(t2iPrompt['477'].inputs.text).toEqual(['553', 0]);
    expect(t2iPrompt['553'].inputs.string).toEqual(['547', 0]);
    expect(t2iPrompt['521'].inputs.text_b).toEqual(['555', 0]);
    expect(t2iPrompt['578'].class_type).toBe('PreviewImage');
    // API 图里不残留 Set/Get 虚拟节点
    const classTypes = Object.values(t2iPrompt).map((n: any) => n.class_type);
    expect(classTypes).not.toContain('SetNode');
    expect(classTypes).not.toContain('GetNode');
    // 模型/提示词链路已由前端解析为直接连线
    expect(t2iPrompt['478'].inputs.model).toEqual(['487', 0]);
    expect(t2iPrompt['520'].inputs.model).toEqual(['538', 0]); // BYPASS(SEGA/DyPE) 透传
    expect(t2iPrompt['476'].inputs.text).toEqual(['553', 0]);
    // widget 值完整（前端导出即权威映射）
    expect(t2iPrompt['478'].inputs.steps).toBe(12);
    expect(t2iPrompt['478'].inputs.sampler_name).toBe('er_sde');
    expect(t2iPrompt['478'].inputs.return_with_leftover_noise).toBe('disable');
  });

  it('buildPrompt 注入生成尺寸：EmptyLatentImage 宽高由链接值替换为具体数值', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'resolution test',
      resolution: { width: 1344, height: 768 },
    });
    expect(prompt['556:11'].class_type).toBe('EmptyLatentImage');
    expect(prompt['556:11'].inputs.width).toBe(1344);
    expect(prompt['556:11'].inputs.height).toBe(768);
  });

  it('buildPrompt 不传 resolution 时保留原有链接（默认分辨率）', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, { prompt: 'no resolution' });
    expect(Array.isArray(prompt['556:11'].inputs.width)).toBe(true);
    expect(Array.isArray(prompt['556:11'].inputs.height)).toBe(true);
  });

  it('buildPrompt 注入视频分辨率：MiniMaxH3ImageToVideo 宽高覆写', async () => {
    const h3Spec = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(h3Spec, h3T2vJson, {
      prompt: '一只发光鹿在森林里奔跑',
      resolution: { width: 1344, height: 768 },
    });
    const videoNode = Object.values(prompt).find((n: any) => n.class_type === 'MiniMaxH3ImageToVideo');
    expect(videoNode).toBeDefined();
    expect(videoNode.inputs.width).toBe(1344);
    expect(videoNode.inputs.height).toBe(768);
  });

  it('introspection 暴露文件类 combo 参数（unet/clip/vae）供插件配置使用', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const unets = t2iSpec.params.filter(p => p.field === 'unet_name');
    const clips = t2iSpec.params.filter(p => p.field === 'clip_name');
    const vaes = t2iSpec.params.filter(p => p.field === 'vae_name');
    // 活链上的加载器（523/480/481）暴露为 combo 且带选项
    expect(unets.some(p => p.type === 'combo' && p.options?.includes('KREA2/pornmasterKrea2_v2TurboInt8.safetensors'))).toBe(true);
    expect(clips.some(p => p.type === 'combo' && p.options?.includes('Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors'))).toBe(true);
    expect(vaes.some(p => p.type === 'combo' && p.options?.includes('Wan2.1_VAE.pth'))).toBe(true);
    // 死节点（fluxKlein 分支 482/483/484）已被裁剪：不暴露对应节点的参数
    expect(t2iSpec.params.some(p => p.nodeId === '482')).toBe(false);
    expect(t2iSpec.params.some(p => p.nodeId === '483')).toBe(false);
    expect(t2iSpec.params.some(p => p.nodeId === '484')).toBe(false);
    // 采样器/调度器仍为 combo
    expect(t2iSpec.params.some(p => p.field === 'sampler_name' && p.type === 'combo')).toBe(true);
    expect(t2iSpec.params.some(p => p.field === 'scheduler' && p.type === 'combo')).toBe(true);

    // 通过 params 注入文件 combo 值
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'model config test',
      params: { [unets[0]!.id]: 'KREA2/pornmasterKrea2_v2TurboInt8.safetensors' },
    });
    const unetLoader = Object.values(prompt).find((n: any) => n.class_type === 'UNETLoader');
    expect(unetLoader?.class_type).toBe('UNETLoader');
    expect(unetLoader?.inputs.unet_name).toBe('KREA2/pornmasterKrea2_v2TurboInt8.safetensors');
  });

  it('Power Lora Loader (rgthree)：暴露单个多选 LoRA 参数并去重到全部 LoRA 节点', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const loras = t2iSpec.params.filter(p => p.field === 'lora' && p.multiple);
    expect(loras).toHaveLength(1);
    expect(loras[0]!.id).toBe('lora-548');
    expect(loras[0]!.label).toBe('LoRA（多选）');
    expect(loras[0]!.type).toBe('combo');
    expect(loras[0]!.multiple).toBe(true);
    expect(loras[0]!.strengthable).toBe(true);
    expect(loras[0]!.min).toBe(-10);
    expect(loras[0]!.max).toBe(10);
    expect(loras[0]!.step).toBe(0.05);
    expect(loras[0]!.applyTo?.sort()).toEqual(['554', '557']);
    // 选项来自核心 LoraLoader 的完整 lora 列表（过滤 None），而非工作流内联列表
    expect(loras[0]!.options).toEqual(expect.arrayContaining(['a.safetensors', 'KREA2/Afterlight_v1.safetensors', 'KREA2/lenovo_krea2.safetensors']));
    expect(loras[0]!.options).not.toContain('None');
    // 默认值 = 主节点（548）已开启的 LoRA（含强度），模板中全部未开启
    expect(loras[0]!.default).toEqual([]);
  });

  it('Power Lora Loader (rgthree)：object_info 缺失时回退到工作流内联 LoRA 列表', async () => {
    const oi = JSON.parse(JSON.stringify(OBJECT_INFO));
    delete oi.LoraLoader;
    delete oi.LoraLoaderModelOnly;
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, oi);
    const loras = t2iSpec.params.filter(p => p.field === 'lora' && p.multiple);
    expect(loras).toHaveLength(1);
    expect(loras[0]!.options).toEqual(expect.arrayContaining(['KREA2/lenovo_krea2.safetensors', 'KREA2/realism_engine_krea2_v3.1.safetensors']));
  });

  it('buildPrompt 注入多选 LoRA：前 N 个槽位开启、保留默认强度，其余槽位关闭', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'lora injection test',
      params: { 'lora-548': ['KREA2/Afterlight_v1.safetensors', 'a.safetensors'] },
    });
    // 主节点 548：lora_1/lora_2 开启并填入所选 LoRA（保留槽位默认强度），其余关闭
    expect(prompt['548'].inputs.lora_1).toEqual({ on: true, lora: 'KREA2/Afterlight_v1.safetensors', strength: 0.6 });
    expect(prompt['548'].inputs.lora_2).toEqual({ on: true, lora: 'a.safetensors', strength: 0.4 });
    expect(prompt['548'].inputs.lora_3).toEqual({ on: false, lora: 'KREA2/realism_engine_krea2_v2.safetensors', strength: 0.4 });
    // 其余节点同样注入：原开启的槽位（554 的 lora_8、557 的 lora_4）被关闭
    expect(prompt['554'].inputs.lora_1).toMatchObject({ on: true, lora: 'KREA2/Afterlight_v1.safetensors' });
    expect(prompt['554'].inputs.lora_2).toMatchObject({ on: true, lora: 'a.safetensors' });
    expect(prompt['554'].inputs.lora_8).toMatchObject({ on: false });
    expect(prompt['557'].inputs.lora_1).toMatchObject({ on: true, lora: 'KREA2/Afterlight_v1.safetensors' });
    expect(prompt['557'].inputs.lora_4).toMatchObject({ on: false });
  });

  it('buildPrompt 注入带显式强度的 LoRA 项：使用指定强度覆盖槽位默认', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'lora strength injection test',
      params: {
        'lora-548': [
          { name: 'KREA2/Afterlight_v1.safetensors', strength: 0.7 },
          { name: 'a.safetensors', strength: -0.3 },
        ],
      },
    });
    expect(prompt['548'].inputs.lora_1).toEqual({ on: true, lora: 'KREA2/Afterlight_v1.safetensors', strength: 0.7 });
    expect(prompt['548'].inputs.lora_2).toEqual({ on: true, lora: 'a.safetensors', strength: -0.3 });
    expect(prompt['548'].inputs.lora_3).toMatchObject({ on: false });
    expect(prompt['557'].inputs.lora_1).toMatchObject({ on: true, strength: 0.7 });
  });

  it('buildPrompt 注入空 LoRA 列表：全部 Power Lora Loader 槽位关闭', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'clear lora test',
      params: { 'lora-548': [] },
    });
    for (const nid of ['548', '554', '557']) {
      const inputs = prompt[nid].inputs as Record<string, unknown>;
      for (const [key, value] of Object.entries(inputs)) {
        if (/^lora_\d+$/.test(key)) expect((value as { on?: boolean }).on).toBe(false);
      }
    }
  });

  it('未配置 LoRA 时保留工作流内各节点的原始 LoRA 设置', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, { prompt: 'keep defaults' });
    expect(prompt['554'].inputs.lora_8).toMatchObject({ on: true });
    expect(prompt['557'].inputs.lora_4).toMatchObject({ on: true });
  });

  it('多采样节点：采样器/调度器按节点分别暴露并可分别注入', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    // 3 个 KSamplerAdvanced 各自暴露一个采样器参数（不去重，无 applyTo）
    const samplers = t2iSpec.params.filter(p => p.field === 'sampler_name');
    expect(samplers).toHaveLength(3);
    expect(samplers.map(p => p.nodeId).sort()).toEqual(['478', '542', '545']);
    expect(samplers.every(p => !p.applyTo)).toBe(true);
    expect(samplers.map(p => p.label)).toEqual([
      '采样器 · 节点 478',
      '采样器 · 节点 542',
      '采样器 · 节点 545',
    ]);
    const schedulers = t2iSpec.params.filter(p => p.field === 'scheduler');
    expect(schedulers).toHaveLength(3);

    // 未配置时保留各节点模板内的采样器设计（er_sde → dpmpp_sde → er_sde）
    const promptDefault = await workflow.buildPrompt(t2iSpec, krea2T2iJson, { prompt: 'multi sampler default' });
    expect(promptDefault['478'].inputs.sampler_name).toBe('er_sde');
    expect(promptDefault['542'].inputs.sampler_name).toBe('dpmpp_sde');
    expect(promptDefault['545'].inputs.sampler_name).toBe('er_sde');

    // 按节点分别注入：只改目标节点，不影响其他节点
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'multi sampler test',
      params: {
        [samplers.find(p => p.nodeId === '478')!.id]: 'dpmpp_2m',
        [schedulers.find(p => p.nodeId === '542')!.id]: 'karras',
      },
    });
    expect(prompt['478'].inputs.sampler_name).toBe('dpmpp_2m');
    expect(prompt['478'].inputs.scheduler).toBe('simple'); // 未覆盖的调度器保留模板值
    expect(prompt['542'].inputs.sampler_name).toBe('dpmpp_sde'); // 未覆盖的采样器保留模板值
    expect(prompt['542'].inputs.scheduler).toBe('karras');
    expect(prompt['545'].inputs.sampler_name).toBe('er_sde');
    expect(prompt['545'].inputs.scheduler).toBe('simple');
  });

  it('死节点裁剪：输出无人消费的加载器不进入参数面板与提交图', async () => {
    const t2iSpec = await workflow.introspectWorkflow(krea2T2iJson, OBJECT_INFO);
    // 步数/CFG 等统一采样参数仍去重为单个控件（注入应用到全部采样节点）
    const steps = t2iSpec.params.filter(p => p.field === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.nodeId).toBe('478');
    expect(steps[0]!.applyTo?.sort()).toEqual(['542', '545']);
    const prompt = await workflow.buildPrompt(t2iSpec, krea2T2iJson, {
      prompt: 'dedupe test',
      params: { [steps[0]!.id]: 18 },
    });
    expect(prompt['478'].inputs.steps).toBe(18);
    expect(prompt['542'].inputs.steps).toBe(18);
    expect(prompt['545'].inputs.steps).toBe(18);
    // 死节点从提交图中消失，活链保留
    expect(prompt['482']).toBeUndefined(); // fluxKlein UNET
    expect(prompt['483']).toBeUndefined(); // Qwen3-8B GGUF CLIP
    expect(prompt['484']).toBeUndefined(); // flux2-vae
    expect(prompt['549']).toBeUndefined(); // 死链上的 PathchSageAttentionKJ
    expect(prompt['523'].class_type).toBe('UNETLoader');
    expect(prompt['480'].class_type).toBe('CLIPLoader');
  });

  it('分离式采样链（KSamplerSelect/BasicScheduler）暴露采样器与调度器并可注入', async () => {
    const h3Spec = await workflow.introspectWorkflow(h3T2vJson, OBJECT_INFO);
    const byField = Object.fromEntries(h3Spec.params.map(p => [p.field, p]));
    // KSamplerSelect 的 sampler_name 与 BasicScheduler 的 scheduler 进入白名单
    expect(byField.sampler_name?.type).toBe('combo');
    expect(byField.sampler_name?.options).toContain('euler');
    expect(byField.scheduler?.type).toBe('combo');
    expect(byField.scheduler?.options).toBeDefined();

    // 通过 params 注入到对应节点
    const prompt = await workflow.buildPrompt(h3Spec, h3T2vJson, {
      prompt: 'sampler chain test',
      params: {
        [byField.sampler_name!.id]: 'res_multistep',
        [byField.scheduler!.id]: 'karras',
      },
    });
    const samplerNode = Object.values(prompt).find((n: any) => n.class_type === 'KSamplerSelect');
    const schedulerNode = Object.values(prompt).find((n: any) => n.class_type === 'BasicScheduler');
    expect(samplerNode?.inputs.sampler_name).toBe('res_multistep');
    expect(schedulerNode?.inputs.scheduler).toBe('karras');
  });

  /* ---------- 提交前校验（缺失模型 / 子目录别名 / 非法 combo） ---------- */

  it('模型装在子目录时按 basename 别名解析为已安装路径', () => {
    const prompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' },
      },
    };
    const oi = {
      UNETLoader: {
        input: {
          required: {
            unet_name: [['MINIMAX/H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors'], {}],
          },
        },
      },
    };
    workflow.resolveModelCombos(prompt, oi);
    expect(prompt['1'].inputs.unet_name).toBe('MINIMAX/H3/minimax_h3_fl2va_pruned_int8_convrot.safetensors');
  });

  it('模型缺失时给出可读错误（含缺失文件名与同类已安装模型）', () => {
    const prompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors' },
      },
    };
    const oi = {
      UNETLoader: {
        input: { required: { unet_name: [['KREA2/krea2_turbo_int8_convrot.safetensors'], {}] } },
      },
    };
    expect(() => workflow.resolveModelCombos(prompt, oi)).toThrowError(
      /krea2_turbo_fp8_scaled\.safetensors.*diffusion_models.*krea2_turbo_int8_convrot/s,
    );
  });

  it('非文件 combo 值不在允许列表时给出可读错误', () => {
    const prompt = {
      '1': {
        class_type: 'KSampler',
        inputs: { sampler_name: 'not_a_sampler' },
      },
    };
    const oi = {
      KSampler: {
        input: { required: { sampler_name: [['euler', 'dpmpp_2m'], {}] } },
      },
    };
    expect(() => workflow.validateComboValues(prompt, oi)).toThrowError(/sampler_name.*not_a_sampler/);
  });

  it('buildPrompt 在自定义节点未安装时一次性列出全部缺失节点并提示安装包', async () => {
    const oiNoKj = JSON.parse(JSON.stringify(OBJECT_INFO)) as typeof OBJECT_INFO;
    delete oiNoKj.ApplyKrea2NegPiP;
    delete oiNoKj.PathchSageAttentionKJ;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/object_info')) {
          return new Response(JSON.stringify(oiNoKj), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    workflow.invalidateComfyCaches();
    const spec = await workflow.introspectWorkflow(krea2T2iJson, oiNoKj);
    await expect(workflow.buildPrompt(spec, krea2T2iJson, { prompt: 'test' })).rejects.toThrowError(
      /ApplyKrea2NegPiP（需安装自定义节点 blue-pen5805\/ComfyUI-krea2-negpip）[\s\S]*PathchSageAttentionKJ（需安装自定义节点 kijai\/ComfyUI-KJNodes）/,
    );
  });

  it('buildPrompt 在 FP8 模型缺失时直接给出可读错误（而非 ComfyUI 的 Value not in list）', async () => {
    const oiNoFp8 = JSON.parse(JSON.stringify(OBJECT_INFO)) as typeof OBJECT_INFO;
    oiNoFp8.UNETLoader.input.required.unet_name[0] = ['KREA2/krea2_turbo_int8_convrot.safetensors'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/object_info')) {
          return new Response(JSON.stringify(oiNoFp8), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    workflow.invalidateComfyCaches();
    const spec = await workflow.introspectWorkflow(krea2T2iJson, oiNoFp8);
    // fluxKlein 死节点已被裁剪，活链上的 pornmasterKrea2 缺失时给出可读错误
    await expect(workflow.buildPrompt(spec, krea2T2iJson, { prompt: '可爱的小猫' })).rejects.toThrowError(
      /KREA2\/pornmasterKrea2_v2TurboInt8\.safetensors.*models\/diffusion_models\//s,
    );
  });
});
