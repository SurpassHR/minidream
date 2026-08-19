import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DirectorError } from '../types.js';
import { importAssetFile } from '../assets/assets-store.js';
import { ComfyUIClient } from '../comfy/client.js';
import { buildWorkflow } from '../comfy/workflow.js';
import { listDesigns, updateDesign, type DesignObject } from './store.js';

function designPrompt(design: DesignObject): string {
  return [design.style, design.description]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(', ').trim();
}

function templateFor(design: DesignObject): { text: string; workflowName: string } {
  const wfDir = process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
  const workflowName = design.template;
  try {
    return { text: readFileSync(join(wfDir, `${workflowName}.template.json`), 'utf8'), workflowName };
  } catch {
    throw new DirectorError('INVALID_PATCH', `模板不存在: ${workflowName}`);
  }
}

export async function runDesignGenerationTask(
  projectDir: string,
  designId: string,
  comfy: ComfyUIClient,
): Promise<Record<string, unknown>> {
  const design = listDesigns(projectDir).find((item) => item.id === designId);
  if (!design) throw new DirectorError('NODE_NOT_FOUND', `设计对象不存在: ${designId}`);
  const prompt = designPrompt(design);
  if (!prompt) throw new DirectorError('INVALID_PATCH', '请先填写风格或视觉描述');
  const template = templateFor(design);
  const workflow = buildWorkflow(design.template, {
    prompt,
    seed: Math.floor(Math.random() * 2 ** 31),
    width: 1024, height: 1024, steps: 30, cfg: 7, negative_prompt: '',
  });
  const promptId = await comfy.submit(workflow, randomUUID());
  const output = await comfy.waitForDone(promptId);
  if (output.media.length === 0) throw new DirectorError('INVALID_PATCH', '生成完成但无输出媒体');

  const tmpDir = mkdtempSync(join(tmpdir(), 'director-design-'));
  const ext = extname(output.media[0]!.filename) || '.png';
  const tmpPath = join(tmpDir, `design-${designId}${ext}`);
  try {
    await comfy.download(output.media[0]!, tmpPath);
    const asset = importAssetFile(tmpPath);
    const done = updateDesign(projectDir, designId, { status: 'done', assetId: asset.id, error: '' });
    return { design: done, promptId, workflow: template.workflowName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = updateDesign(projectDir, designId, { status: 'failed', error: message });
    return { design: failed, error: message };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
