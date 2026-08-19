import { basename, extname } from 'node:path';
import { DirectorError, type TaskRecord } from '../types.js';
import {
  assetFilePath, listAssets, setAssetCaption, upsertAssetText,
} from '../assets/assets-store.js';
import { OllamaClient } from '../ollama/client.js';
import { ComfyUIClient } from '../comfy/client.js';
import { runDesignGenerationTask } from '../design/runner.js';
import { readSettings } from '../settings/settings-store.js';
import { TaskQueue } from './queue.js';

const DEFAULT_VISION_INSTRUCTION = '请用中文描述这张图片中主体（人物/场景/物品）的外观：外貌、材质、颜色、光影、构图要点。输出一段可直接作为文生图提示词的外观描述，只输出描述本身，不要解释、不要引号。';
const CAPTION_INSTRUCTION = '请为这张图片生成一条详细的中文描述（caption），覆盖：主体（人物/动物/物体）及其外观与动作、场景环境、构图、光线、色调与风格。直接输出描述文本本身，不要解释、不要引号、不要 Markdown 标记。';

type VisionPayload = {
  operation?: 'image-to-prompt' | 'caption';
  assetId?: string;
  imagePath?: string;
  instruction?: string;
};

type EmbeddingPayload = {
  model?: string;
  texts?: string[];
};

type DesignPayload = {
  designId?: string;
  comfyBaseUrl?: string;
};

export function submitVisionTask(queue: TaskQueue, input: {
  operation: 'image-to-prompt' | 'caption';
  assetId?: string;
  imagePath?: string;
  instruction?: string;
}): { task: TaskRecord; completion: Promise<TaskRecord> } {
  const dedupeKey = input.assetId
    ? `ollama-vision:${input.operation}:${input.assetId}`
    : undefined;
  return queue.submit({
    kind: 'ollama-vision',
    label: input.operation === 'caption' ? '生成图像 caption' : '图像转提示词',
    payload: input,
    dedupeKey,
  });
}

export function submitEmbeddingTask(queue: TaskQueue, input: {
  projectDir?: string;
  model: string;
  texts: string[];
}): { task: TaskRecord; completion: Promise<TaskRecord> } {
  return queue.submit({
    kind: 'ollama-embedding',
    label: '知识库向量检索',
    projectDir: input.projectDir,
    payload: { model: input.model, texts: input.texts },
  });
}

export function registerTaskHandlers(queue: TaskQueue): void {
  queue.register('comfy-design', runDesignTask);
  queue.register('ollama-vision', runVisionTask);
  queue.register('ollama-embedding', runEmbeddingTask);
}

async function runDesignTask(task: TaskRecord): Promise<Record<string, unknown>> {
  const payload = task.payload as DesignPayload;
  const designId = typeof payload.designId === 'string' ? payload.designId : '';
  const baseUrl = typeof payload.comfyBaseUrl === 'string' ? payload.comfyBaseUrl : '';
  if (!designId || !baseUrl) throw new DirectorError('INVALID_PATCH', '设计生成任务参数不完整');
  return runDesignGenerationTask(task.projectDir ?? '', designId, new ComfyUIClient(baseUrl));
}

async function runVisionTask(task: TaskRecord): Promise<Record<string, unknown>> {
  const payload = task.payload as VisionPayload;
  const assetId = typeof payload.assetId === 'string' ? payload.assetId : '';
  const imagePath = typeof payload.imagePath === 'string' ? payload.imagePath : '';
  const asset = assetId ? listAssets().find((item) => item.id === assetId) : undefined;
  if (payload.operation === 'caption' && !assetId) throw new DirectorError('INVALID_PATCH', 'caption 任务缺少图片素材');
  if (assetId && !asset) throw new DirectorError('NODE_NOT_FOUND', `素材不存在: ${assetId}`);
  if (asset && asset.kind !== 'img') throw new DirectorError('INVALID_PATCH', '该素材不是图片，无法调用视觉模型');
  if (!asset && !imagePath) throw new DirectorError('INVALID_PATCH', '视觉任务缺少图片路径');

  const { ollamaUrl, ollamaModel } = readSettings();
  if (!ollamaUrl || !ollamaModel) {
    throw new DirectorError('INVALID_PATCH', '请先在设置中配置 Ollama 地址与视觉模型');
  }
  const instruction = payload.operation === 'caption'
    ? CAPTION_INSTRUCTION
    : (payload.instruction?.trim() || DEFAULT_VISION_INSTRUCTION);
  const text = await new OllamaClient(ollamaUrl).imageToPrompt(
    ollamaModel,
    asset ? assetFilePath(asset.id) : imagePath,
    instruction,
  );
  if (payload.operation === 'caption') {
    const txtName = `${basename(asset!.name, extname(asset!.name))}.txt`;
    const textAsset = upsertAssetText(txtName, text);
    setAssetCaption(asset!.id, text);
    return { caption: text, asset: textAsset };
  }
  return { prompt: text, ...(assetId ? { assetId } : {}) };
}

async function runEmbeddingTask(task: TaskRecord): Promise<Record<string, unknown>> {
  const payload = task.payload as EmbeddingPayload;
  const model = typeof payload.model === 'string' ? payload.model : '';
  const texts = Array.isArray(payload.texts) ? payload.texts.filter((text): text is string => typeof text === 'string') : [];
  const { ollamaUrl } = readSettings();
  if (!ollamaUrl || !model) {
    throw new DirectorError('INVALID_PATCH', '请先在设置中配置 Ollama 地址与 Embedding 模型');
  }
  const embeddings = await new OllamaClient(ollamaUrl).embed(model, texts);
  return { embeddings };
}
