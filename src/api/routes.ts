import type { FastifyInstance } from 'fastify';
import { DirectorError, type Actor, type NodeType } from '../types.js';
import {
  createNode, updateNode, deleteNode, moveNode,
  createEdge, updateEdge, deleteEdge, loadGraph, saveGraph,
} from '../graph/graph-store.js';
import { syncNodeToFile } from '../sync/dual-writer.js';
import { listSnapshots, graphAtSnapshot, headSeq, futureSnapshotCount, approveOverwrite } from '../snapshots/snapshot-store.js';
import { listWorkspace, readWorkspaceFile, searchWorkspace } from '../workspace/accessor.js';
import { readFileSync, existsSync, mkdtempSync, createWriteStream, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { applyMutation, applyHeadSwitch } from './mutations.js';
import { graphToPromptYaml } from '../prompt/export.js';
import { GenerationQueue } from '../generation/queue.js';
import { TaskQueue } from '../tasks/queue.js';
import { ComfyUIClient } from '../comfy/client.js';
import {
  assetDirectoryPath, listAssets, importAssetFile, importAssetText, upsertAssetText, setAssetCaption, deleteAsset, readAssetText, assetFilePath,
  updateAsset, replaceAssetFile,
} from '../assets/assets-store.js';
import { OllamaClient } from '../ollama/client.js';
import { buildWorkflow } from '../comfy/workflow.js';
import { submitEmbeddingTask, submitVisionTask } from '../tasks/handlers.js';
import { buildAgentPrompt, runAgentCollect, runAgentStream } from '../agent/bridge.js';
import {
  appendChatMessage, createChatSession, deleteChatSession,
  listChatSessions, readChatHistory, renameChatSession,
} from '../agent/chat-history.js';
import type { ChatMessage } from '../agent/chat-history.js';
import { readStory, saveStory, completeStory, resetStory, buildStoryMarkdown } from '../story/store.js';
import {
  appendStoryChat, createStorySession, deleteStoryChatMessage, deleteStorySession,
  listStorySessions, readStoryChat, renameStorySession, truncateStoryChatMessage, updateStoryChatMessage,
} from '../story/chat-store.js';
import {
  addBoardRagAsset, createBoard, deleteBoard, findBoard, listBoards,
  removeBoardRagAsset, renameBoard, saveBoardPrompts, setBoardRagEnabled,
} from '../story/boards-store.js';
import { formatRagHits, ragSearch } from '../story/rag.js';
import { listDesigns, createDesign, updateDesign, deleteDesign } from '../design/store.js';
import { readSettings, saveSettings } from '../settings/settings-store.js';
import type { DesignKind, DesignObject } from '../design/store.js';
import {
  addProject, deleteProject, listProjects, rememberLastProject, removeProject, renameProject, resolveSwitchTarget, resolveComfyUrl,
} from '../projects/projects-store.js';
import { openDirectory, pickProjectDirectory } from '../projects/directory-picker.js';
import type { WsHandle } from './ws.js';

// 项目上下文：单一可变事实来源，/api/project/switch 热切换时整体替换
// （projectDir / queue / comfy 三者必须同属一个项目，避免切换后交叉引用旧目录）
export interface ProjectContext {
  projectDir: string;
  projectOpen: boolean;
  queue: GenerationQueue;
  taskQueue: TaskQueue;
  comfy: ComfyUIClient;
}

const PROJECT_SCOPED_PREFIXES = [
  '/api/graph', '/api/yaml/export', '/api/nodes', '/api/edges', '/api/import',
  '/api/snapshots', '/api/workspace', '/api/generation', '/api/comfy/config',
  '/api/agent', '/api/story', '/api/designs', '/api/assets',
];

function isProjectScopedPath(pathname: string): boolean {
  if (pathname === '/api/agent/models') return false;
  return PROJECT_SCOPED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function projectNotOpen(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }): unknown {
  return reply.code(409).send({ code: 'PROJECT_NOT_OPEN', message: '请先打开一个项目' });
}

function confirmOf(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  // Fastify query 参数值为字符串（如 'true'），需同时接受布尔与字符串形式
  const c = (query as Record<string, unknown>).confirm;
  return c === true || c === 'true';
}


// pi --thinking 合法级别（侧栏思考强度下拉的数据源）
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 生成 agent 专用 MCP 配置。
// AGENT 面板默认启用 director-workbench 画布工具；故事聊天传 false，使用空配置，
// 避免故事编剧看到或调用画布/节点能力。显式配置文件也能阻止 pi 回退加载用户全局 MCP。
export function writeAgentMcpConfig(mcpPort: number, includeWorkbench = true): string | null {
  try {
    const file = join(tmpdir(), `director-agent-mcp-${mcpPort}.json`);
    writeFileSync(file, JSON.stringify({
      mcpServers: includeWorkbench ? {
        'director-workbench': {
          type: 'http',
          url: `http://127.0.0.1:${mcpPort}/mcp`,
          directTools: true,
        },
      } : {},
    }, null, 2), 'utf8');
    return file;
  } catch {
    return null;
  }
}

// —— 故事向导对话式（story-chat）prompt 构造 ——
// 对话式 prompt 拆成 pi system prompt 与 stdin 用户上下文（纯函数，便于测试）。
const STORY_CHAT_HISTORY_WINDOW = 20;

export interface StoryChatPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const STORY_CHAT_FALLBACK_SYSTEM = '你是导演工作台的故事编剧（story-teller 对话模式）。你正在帮用户自由构思一个视频故事的创意。';

const STORY_CHAT_ISOLATION_RULES = [
  '故事编剧不得访问、检查、描述、创建、修改、连接、删除或操作画布、画布节点、图、编辑器或工作台 UI；这些能力对本角色不可用。',
  '不得声称已经执行任何画布或节点操作，也不得询问是否要创建、连接、修改或删除节点。',
  '只处理故事创作、MiniMax H3 提示词访谈、用户明确提供的素材和故事对话历史；不要把普通项目上下文解释成画布状态。',
  '如果用户询问画布或节点操作，简短说明本角色不支持该操作，然后回到故事创作。',
];

export function buildStoryChatPrompt(
  projectName: string,
  answers: Record<string, string>,
  history: ChatMessage[],
  message: string,
  rolePrompt?: string,
  ragContext?: string,
  mode: 'chat' | 'system' = 'chat',
): StoryChatPrompt {
  const systemParts: string[] = [rolePrompt?.trim() || STORY_CHAT_FALLBACK_SYSTEM, '角色隔离边界：', ...STORY_CHAT_ISOLATION_RULES, '要求：'];
  if (mode === 'chat') {
    systemParts.push('1. 用访谈语言写一句短问或确认，像资深编剧推进访谈，不要重复用户已确认的内容；');
    systemParts.push('2. 每次只问一件事；正文不要罗列选项，不要解释机器格式；');
    systemParts.push('3. 文末必须追加且仅追加一个 choice 代码块，围栏语言标记为 choice；');
    systemParts.push('4. choice 块必须是合法 JSON：{"question":"短问句","options":[{"id":"stable-id","label":"可发送的选项原文"}]}；');
    systemParts.push('5. options 2–4 项，互斥；label 用访谈语言，点击后会原样作为用户回答发回；');
    systemParts.push('6. 不要把「其他 / 自定义 / 我自己说」放进 options，前端会单独提供输入框；');
    systemParts.push('7. 用户说「你决定 / 随便 / I don\'t know」时自己选定并继续，不要停住追问；');
    systemParts.push('8. 用中文还是其它语言，以用户已选的访谈语言为准；尚未选择时先问语言。');
  } else {
    systemParts.push('1. 直接给出创作建议、扩展点子或追问，像资深编剧与导演讨论剧本一样自然；');
    systemParts.push('2. 结合项目设定与已有向导进度，不要重复用户已写的内容；');
    systemParts.push('3. 每次回答 100-200 字，聚焦推进故事；');
    systemParts.push('4. 用中文回答。');
  }

  const userParts: string[] = [];
  if (ragContext?.trim()) userParts.push('知识库检索（RAG）命中：\n' + ragContext.trim());
  userParts.push(`当前项目：${projectName}`);
  const filled = Object.entries(answers).filter(([, v]) => v && v.trim());
  if (filled.length > 0) {
    userParts.push('向导进度（已完成部分）：');
    for (const [id, v] of filled) userParts.push(`  ${id}: ${v}`);
  }
  if (history.length > 0) {
    userParts.push('\n对话历史：');
    for (const h of history.slice(-STORY_CHAT_HISTORY_WINDOW)) {
      userParts.push(`  ${h.who === 'user' ? '用户' : '编剧'}：${h.text}`);
    }
  }
  userParts.push(`\n用户消息：\n${message}`);
  return { systemPrompt: systemParts.join('\n'), userPrompt: userParts.join('\n') };
}

// —— story chat 图像附件：base64 → 临时文件，pi 通过 @file 参数接收 ——
// 剪贴板粘贴的图片在前端已转 data URL（data:image/png;base64,...）；纯 base64 兜底按 png 处理。
// 返回临时目录（含已写入的文件列表）；失败/空输入返回 null。调用方负责 finally 清理 tmpDir。
const STORY_IMAGE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp',
};
export function writeStoryChatImages(images: Array<{ name?: string; data?: string }>): { files: string[]; tmpDir: string } | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const tmpDir = mkdtempSync(join(tmpdir(), 'director-story-img-'));
  const files: string[] = [];
  for (const [i, img] of images.entries()) {
    const data = typeof img?.data === 'string' ? img.data : '';
    const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(data);
    const mime = m ? m[1]!.toLowerCase() : 'image/png';
    const buf = Buffer.from(m ? m[2]! : data, 'base64');
    if (buf.length === 0) continue;
    const file = join(tmpDir, `img-${i}${STORY_IMAGE_EXT[mime] ?? '.png'}`);
    writeFileSync(file, buf);
    files.push(file);
  }
  return { files, tmpDir };
}

// 仅把明确的视觉能力错误触发为降级，避免把鉴权/网络/限流错误误判为视觉不支持。
export function isVisionUnsupportedError(message: string): boolean {
  return /(vision|visual|image|multimodal|视觉|图像|图片)/i.test(message)
    && /(not support|unsupported|does not support|cannot|can't|invalid|不支持|不可用)/i.test(message);
}

const STORY_VISION_INSTRUCTION = '请用中文描述这张参考图中与故事创作有关的内容：主体、人物外观、场景、构图、光线、色彩和关键动作。只输出客观、具体的视觉描述，不要解释。';

// 图片附件 → 本地 Ollama 视觉描述。复用 OllamaClient 的文件路径能力，避免先写入全局素材库。
async function describeImageFiles(files: string[], taskQueue: TaskQueue): Promise<string[]> {
  try {
    const descriptions: string[] = [];
    for (const file of files) {
      const submitted = submitVisionTask(taskQueue, {
        operation: 'image-to-prompt', imagePath: file, instruction: STORY_VISION_INSTRUCTION,
      });
      const done = await submitted.completion;
      if (done.status !== 'success') throw new DirectorError('INVALID_PATCH', done.error ?? '视觉任务失败');
      const description = done.result?.prompt;
      if (typeof description !== 'string' || !description) throw new DirectorError('INVALID_PATCH', '视觉任务返回空描述');
      descriptions.push(description);
    }
    return descriptions;
  } catch (err) {
    if (err instanceof DirectorError && err.message.startsWith('视觉降级失败：')) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DirectorError('INVALID_PATCH', `视觉降级失败：${message}`);
  }
}

async function describeStoryImages(files: string[], taskQueue: TaskQueue): Promise<string> {
  const descriptions = await describeImageFiles(files, taskQueue);
  return `参考图视觉描述（由本地 Ollama 生成）：\n${descriptions.map((text, i) => `图片 ${i + 1}：${text}`).join('\n')}`;
}

// 对素材库图片做视觉 fallback，并把每条描述写回图片 caption，后续 @ 引用直接复用。
async function describeAssetImages(projectDir: string, assetIds: string[], taskQueue: TaskQueue): Promise<string> {
  const assets = assetIds
    .map((id) => listAssets(projectDir).find((asset) => asset.id === id))
    .filter((asset) => asset?.kind === 'img' && !asset.caption) as Array<{ id: string; kind: 'img'; name: string }>;
  if (assets.length === 0) return '';
  const parts: string[] = [];
  for (const asset of assets) {
    const submitted = submitVisionTask(taskQueue, {
      operation: 'image-to-prompt', projectDir, assetId: asset.id, instruction: STORY_VISION_INSTRUCTION,
    });
    const done = await submitted.completion;
    if (done.status !== 'success') throw new DirectorError('INVALID_PATCH', done.error ?? '视觉任务失败');
    const caption = typeof done.result?.prompt === 'string' ? done.result.prompt : '';
    if (!caption) continue;
    setAssetCaption(projectDir, asset.id, caption);
    parts.push(`图像素材「${asset.name}」的描述：${caption}`);
  }
  return parts.length > 0 ? `用户引用的图像素材描述（由本地 Ollama 生成）：\n${parts.join('\n')}` : '';
}

async function embedThroughQueue(taskQueue: TaskQueue, projectDir: string, texts: string[]): Promise<number[][]> {
  const { ollamaEmbedModel } = readSettings();
  if (!ollamaEmbedModel) throw new DirectorError('INVALID_PATCH', '未配置 Ollama Embedding 模型');
  const submitted = submitEmbeddingTask(taskQueue, { projectDir, model: ollamaEmbedModel, texts });
  const done = await submitted.completion;
  if (done.status !== 'success' || !Array.isArray(done.result?.embeddings)) {
    throw new DirectorError('INVALID_PATCH', done.error ?? 'Embedding 任务失败');
  }
  return done.result.embeddings as number[][];
}

// 故事对话拖入的非图像素材：文本读取内容，视频保留可识别的素材引用。
// 内容设置上限，避免单个大型知识文件撑爆对话上下文；视频不伪造视觉描述。
export function buildStoryAssetContext(projectDir: string, refs: Array<{ id?: string; name?: string; kind?: string }>): string {
  const parts: string[] = [];
  for (const ref of refs) {
    if (typeof ref?.id !== 'string') continue;
    const asset = listAssets(projectDir).find((item) => item.id === ref.id);
    if (!asset) continue;
    if (asset.kind === 'txt') {
      try {
        const content = readAssetText(projectDir, asset.id).slice(0, 12_000);
        parts.push(`文本素材「${asset.name}」：\n${content}`);
      } catch {
        parts.push(`文本素材「${asset.name}」：内容读取失败`);
      }
    } else if (asset.kind === 'img') {
      parts.push(asset.caption
        ? `图像素材「${asset.name}」：图像描述：${asset.caption}`
        : `图像素材「${asset.name}」：图片文件将作为视觉附件提供给模型。`);
    } else {
      const meta = asset.meta ? `（${asset.meta}）` : '';
      parts.push(`视频素材「${asset.name}」${meta}：请将其作为参考视频素材理解；当前请求未提供视频画面内容。`);
    }
  }
  return parts.length > 0 ? `用户引用的素材上下文：\n${parts.join('\n\n')}` : '';
}

export function buildStoryAssetImageFiles(projectDir: string, refs: Array<{ id?: string; kind?: string }>): { ids: string[]; files: string[] } {
  const assets = refs
    .filter((ref) => typeof ref.id === 'string')
    .map((ref) => listAssets(projectDir).find((asset) => asset.id === ref.id))
    .filter((asset) => asset?.kind === 'img' && !asset.caption) as Array<{ id: string; kind: 'img' }>;
  return { ids: assets.map((asset) => asset.id), files: assets.map((asset) => assetFilePath(projectDir, asset.id)) };
}

// AGENT 面板的 @ 素材上下文：文本直接注入，图片同时以 @ 文件参数交给 pi，视频保留元信息。
export function buildAgentAssetContext(projectDir: string, refs: Array<{ id?: string; name?: string; kind?: string }>): { context: string; imageFiles: string[]; imageAssetIds: string[] } {
  const parts: string[] = [];
  const imageFiles: string[] = [];
  for (const ref of refs) {
    if (typeof ref?.id !== 'string') continue;
    const asset = listAssets(projectDir).find((item) => item.id === ref.id);
    if (!asset) continue;
    if (asset.kind === 'txt') {
      try {
        parts.push(`文本素材「${asset.name}」：\n${readAssetText(projectDir, asset.id).slice(0, 12_000)}`);
      } catch {
        parts.push(`文本素材「${asset.name}」：内容读取失败`);
      }
    } else if (asset.kind === 'img') {
      const caption = asset.caption ? `\n图像描述：${asset.caption}` : '';
      if (!asset.caption) imageFiles.push(assetFilePath(projectDir, asset.id));
      parts.push(`图像素材「${asset.name}」${asset.caption ? '的描述已直接注入提示词' : '已作为图像附件提供给模型'}。${caption}`);
    } else {
      const meta = asset.meta ? `（${asset.meta}）` : '';
      parts.push(`视频素材「${asset.name}」${meta}：当前请求提供了视频文件引用，但未解析视频画面。`);
    }
  }
  return {
    context: parts.length > 0 ? `用户 @ 引用的素材上下文：\n${parts.join('\n\n')}` : '',
    imageFiles,
    imageAssetIds: refs
      .filter((ref) => typeof ref.id === 'string')
      .map((ref) => listAssets(projectDir).find((asset) => asset.id === ref.id))
      .filter((asset) => asset?.kind === 'img' && !asset.caption)
      .map((asset) => asset!.id),
  };
}


export function mountRoutes(
  app: FastifyInstance,
  ctx: ProjectContext,
  ws: WsHandle,
): void {
  const actor: Actor = 'user';

  // 项目目录是显式打开后才可用；全局设置、项目注册表和素材库不受此保护。
  app.addHook('preHandler', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? req.url;
    if (!ctx.projectOpen && isProjectScopedPath(pathname)) {
      return projectNotOpen(reply);
    }
  });

  app.get('/api/graph', async () => ({ graph: loadGraph(ctx.projectDir) }));

  // 画布 → MMH3 Prompt YAML 导出（chain 拓扑序 = 剧情顺序；结构性错误抛 YAML_EXPORT_FAILED）
  app.post('/api/yaml/export', async () => ({
    ...graphToPromptYaml(loadGraph(ctx.projectDir)),
  }));

  // —— 项目栏：手动添加的项目注册表（默认不自动发现） ——
  app.get('/api/projects', async () => ({
    projects: listProjects(ctx.projectDir).map((p) => ({ ...p, current: ctx.projectOpen && p.current })),
    projectOpen: ctx.projectOpen,
  }));

  // 打开本机原生目录选择器：不依赖当前项目，返回真实绝对路径；用户取消时 path=null
  app.get('/api/projects/pick-directory', async (_, reply) => {
    const result = pickProjectDirectory();
    if (!result.available) {
      return reply.code(501).send({ code: 'PROJECT_PICKER_UNAVAILABLE', message: '当前系统没有可用的目录选择器，请手动输入项目路径' });
    }
    return { path: result.path };
  });

  // 添加项目：校验为剧本项目（mmh3_prompts/prompts）或空目录后才可加入；持久化注册表
  app.post('/api/projects/add', async (req) => ({
    projects: addProject(ctx.projectDir, (req.body as { path?: string }).path ?? ''),
  }));

  // 重命名项目：同步重命名磁盘目录及项目注册表
  app.patch('/api/projects/rename', async (req, reply) => {
    const body = req.body as { path?: string; name?: string };
    try {
      const target = resolveSwitchTarget(ctx.projectDir, body.path ?? '');
      const renamingCurrent = ctx.projectOpen && target === ctx.projectDir;
      const { projects, newPath } = renameProject(ctx.projectDir, body.path ?? '', body.name ?? '');

      if (renamingCurrent) {
        ctx.projectDir = newPath;
        ctx.comfy = new ComfyUIClient(resolveComfyUrl(ctx.projectDir));
        ctx.queue = new GenerationQueue(ctx.projectDir, ctx.comfy, ctx.taskQueue);
        await ws.switchDir(ctx.projectDir);
      }

      return {
        projects: projects.filter((p) => ctx.projectOpen ? true : !p.current),
        newPath,
      };
    } catch (err) {
      if (err instanceof DirectorError) {
        const status = err.code === 'PROJECT_NOT_FOUND' ? 404 : err.code === 'FILE_CONFLICT' ? 409 : 400;
        return reply.code(status).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 删除项目：确认后递归删除磁盘目录，并从项目注册表移除
  app.delete('/api/projects', async (req, reply) => {
    const body = req.body as { path?: string; confirm?: boolean };
    if (body.confirm !== true) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除项目文件需 confirm=true' });
    }
    const target = resolveSwitchTarget(ctx.projectDir, body.path ?? '');
    const deletingCurrent = ctx.projectOpen && target === ctx.projectDir;
    try {
      const projects = deleteProject(ctx.projectDir, body.path ?? '');
      if (deletingCurrent) {
        ctx.projectDir = join(process.cwd(), '.director-no-project');
        ctx.projectOpen = false;
        ctx.comfy = new ComfyUIClient(resolveComfyUrl(ctx.projectDir));
        ctx.queue = new GenerationQueue(ctx.projectDir, ctx.comfy, ctx.taskQueue);
        await ws.switchDir(ctx.projectDir);
      }
      return {
        projects: projects.filter((p) => ctx.projectOpen ? true : !p.current),
        projectOpen: ctx.projectOpen,
      };
    } catch (err) {
      if (err instanceof DirectorError) {
        return reply.code(err.code === 'PROJECT_NOT_FOUND' ? 404 : 400).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 兼容旧调用：仅从注册表移除，不删除目录
  app.post('/api/projects/remove', async (req) => ({
    projects: removeProject(ctx.projectDir, (req.body as { path?: string }).path ?? ''),
  }));

  app.post('/api/project/switch', async (req, reply) => {
    const body = req.body as { path?: string };
    const target = resolveSwitchTarget(ctx.projectDir, body.path ?? '');
    if (!target) {
      return reply.code(400).send({ code: 'PROJECT_NOT_FOUND', message: `项目目录不存在: ${body.path ?? ''}` });
    }
    // 三者整体替换为同一项目，避免交叉引用旧目录：
    // comfy 按新项目 project 节点地址重建；queue 随之重建；watcher 切换监视目录
    ctx.projectDir = target;
    ctx.projectOpen = true;
    rememberLastProject(target);
    ctx.comfy = new ComfyUIClient(resolveComfyUrl(target));
    ctx.queue = new GenerationQueue(target, ctx.comfy, ctx.taskQueue);
    await ws.switchDir(target);
    return {
      graph: loadGraph(ctx.projectDir),
      projects: listProjects(ctx.projectDir),
      projectOpen: true,
    };
  });


  app.post('/api/nodes', async (req, reply) => {
    const body = req.body as {
      type: NodeType; title: string; fields?: Record<string, unknown>;
      position?: { x: number; y: number };
    };
    let nodeId = '';
    applyMutation(ctx.projectDir, actor, `创建节点 ${body.title}`, (g) => {
      const n = createNode(g, body);
      nodeId = n.id;
    });
    const graph = loadGraph(ctx.projectDir);
    const node = graph.nodes.find((n) => n.id === nodeId);
    // 创建节点时若指定了映射文件且目标文件尚不存在，则落盘（验收冒烟要求；
    // 文件已存在时不覆盖——遵守“冲突从不静默覆盖”约束，走 PATCH/导入流程同步）
    if (node) {
      const f = node.fields.filename;
      if (typeof f === 'string' && !existsSync(join(ctx.projectDir, f))) {
        syncNodeToFile(ctx.projectDir, node);
      }
    }
    reply.code(201);
    return { node };
  });

  app.patch('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { patch } = req.body as { patch: Record<string, unknown> };
    let updated;
    applyMutation(ctx.projectDir, actor, `更新节点 ${id}`, (g) => {
      updated = updateNode(g, id, patch);
      // 内容字段变化时同步映射文件
      const p = patch.fields as Record<string, unknown> | undefined;
      if (p && typeof p.content === 'string') {
        syncNodeToFile(ctx.projectDir, updated);
      }
    });
    return { node: updated };
  });

  app.delete('/api/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除节点需 confirm=true' });
    }
    applyMutation(ctx.projectDir, actor, `删除节点 ${id}`, (g) => { deleteNode(g, id); });
    return { ok: true };
  });

  app.post('/api/nodes/:id/move', async (req) => {
    const { id } = req.params as { id: string };
    const { position } = req.body as { position: { x: number; y: number } };
    let moved;
    applyMutation(ctx.projectDir, actor, `移动节点 ${id}`, (g) => { moved = moveNode(g, id, position); });
    return { node: moved };
  });

  app.post('/api/edges', async (req, reply) => {
    const body = req.body as {
      kind: 'ref' | 'chain' | 'exec'; source: string; target: string;
      label?: string; targetHandle?: string; replaceEdgeId?: string;
    };
    let edge;
    applyMutation(ctx.projectDir, actor, `创建边 ${body.source} -> ${body.target}`, (g) => {
      edge = createEdge(g, body);
    });
    reply.code(201);
    return { edge };
  });

  app.delete('/api/edges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除边需 confirm=true' });
    }
    applyMutation(ctx.projectDir, actor, `删除边 ${id}`, (g) => { deleteEdge(g, id); });
    return { ok: true };
  });

  // 修改边：改类型（ref/chain/exec）或标签；改为 chain 时重新校验线性约束
  app.patch('/api/edges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { patch: { kind?: 'ref' | 'chain' | 'exec'; label?: string } };
    let edge;
    applyMutation(ctx.projectDir, actor, `修改边 ${id}`, (g) => {
      edge = updateEdge(g, id, body.patch ?? {});
    });
    return { edge };
  });

  // 从工作区文件导入节点
  app.post('/api/import', async (req, reply) => {
    const body = req.body as {
      path: string; type: NodeType; title: string;
      filename?: string; position?: { x: number; y: number };
    };
    const content = readWorkspaceFile(ctx.projectDir, body.path);
    const filename = body.filename ?? body.path;
    let node;
    applyMutation(ctx.projectDir, actor, `导入文件 ${body.path}`, (g) => {
      const existing = g.nodes.find((n) => n.fields.filename === filename);
      if (existing) {
        node = updateNode(g, existing.id, { fields: { content } });
      } else {
        node = createNode(g, {
          type: body.type, title: body.title,
          fields: { filename, content },
          position: body.position,
        });
      }
    });
    reply.code(201);
    return { node };
  });

  app.get('/api/snapshots', async () => ({
    snapshots: listSnapshots(ctx.projectDir),
    headSeq: headSeq(ctx.projectDir),
  }));

  // 点击快照直接回滚（免确认）：重置图为目标快照状态并切换 HEAD，不追加新快照
  app.post('/api/snapshots/rollback', async (req, reply) => {
    const body = req.body as { seq: number };
    try {
      return { graph: applyHeadSwitch(ctx.projectDir, body.seq) };
    } catch (e) {
      if (e instanceof DirectorError) {
        return reply.code(400).send({ code: e.code, message: e.message });
      }
      throw e;
    }
  });

  // 撤销（Ctrl+Z）：HEAD 后退到前一个快照
  app.post('/api/snapshots/undo', async (req, reply) => {
    const snaps = listSnapshots(ctx.projectDir);
    const head = headSeq(ctx.projectDir);
    const prev = [...snaps].reverse().find((s) => s.seq < head);
    if (!prev) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '没有更早的快照可撤销' });
    }
    return { graph: applyHeadSwitch(ctx.projectDir, prev.seq) };
  });

  // 重做（Ctrl+Y / Ctrl+Shift+Z）：HEAD 前进到下一个（未来）快照
  app.post('/api/snapshots/redo', async (req, reply) => {
    const snaps = listSnapshots(ctx.projectDir);
    const head = headSeq(ctx.projectDir);
    const next = snaps.find((s) => s.seq > head);
    if (!next) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '没有更新的快照可重做' });
    }
    return { graph: applyHeadSwitch(ctx.projectDir, next.seq) };
  });

  // 覆盖未来（灰色）快照的一次性批准：确认对话框后调用，
  // 下一次写操作（recordSnapshot）发现未来快照时放行覆盖
  app.post('/api/snapshots/approve-overwrite', async () => {
    approveOverwrite();
    return { ok: true };
  });

  app.get('/api/workspace/list', async () => ({ paths: listWorkspace(ctx.projectDir) }));

  app.get('/api/workspace/search', async (req) => {
    const { q } = req.query as { q: string };
    return { hits: searchWorkspace(ctx.projectDir, q) };
  });

  app.get('/api/workspace/read', async (req) => {
    const { path } = req.query as { path: string };
    return { content: readWorkspaceFile(ctx.projectDir, path) };
  });

  // —— 生成执行：ComfyUI 状态与生成任务 ——
  app.get('/api/comfy/health', async () => ({
    healthy: await ctx.comfy.health(),
    baseUrl: ctx.comfy.baseUrl,
  }));

  // 自定义 ComfyUI 地址：写入 project 节点并热切换客户端
  app.post('/api/comfy/config', async (req, reply) => {
    const body = req.body as { baseUrl?: string };
    const url = (body.baseUrl ?? '').trim();
    if (!url || !/^https?:\/\//.test(url)) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '地址需以 http:// 或 https:// 开头' });
    }
    applyMutation(ctx.projectDir, actor, `配置 ComfyUI 地址 ${url}`, (g) => {
      const proj = g.nodes.find((n) => n.type === 'project');
      if (proj) {
        proj.fields.comfyuiUrl = url;
        proj.version += 1;
      } else {
        createNode(g, {
          type: 'project', title: g.projectName,
          fields: { comfyuiUrl: url },
          position: { x: 40, y: 40 },
        });
      }
    });
    ctx.comfy.setBaseUrl(url); // 热切换：后续生成与健康检查立即使用新地址
    const healthy = await ctx.comfy.health();
    return { ok: true, baseUrl: ctx.comfy.baseUrl, healthy };
  });

  // —— 全局设置（~/.director/settings.json，用户级跨项目）——
  // ComfyUI 地址 / agent 默认模型 / 思考强度；前端设置 modal 读写
  app.get('/api/settings', async () => ({ settings: readSettings() }));

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as {
      comfyUrl?: string; agentModel?: string; agentThinking?: string;
      prompts?: Record<string, string>;
      armorBreak?: string; armorBreakEnabled?: boolean;
      ollamaUrl?: string; ollamaModel?: string; ollamaEmbedModel?: string;
      theme?: 'dark' | 'light';
    };
    const settings = saveSettings({
      comfyUrl: typeof body.comfyUrl === 'string' ? body.comfyUrl : undefined,
      agentModel: typeof body.agentModel === 'string' ? body.agentModel : undefined,
      agentThinking: typeof body.agentThinking === 'string' ? body.agentThinking : undefined,
      prompts: body.prompts,
      armorBreak: typeof body.armorBreak === 'string' ? body.armorBreak : undefined,
      armorBreakEnabled: typeof body.armorBreakEnabled === 'boolean' ? body.armorBreakEnabled : undefined,
      ollamaUrl: typeof body.ollamaUrl === 'string' ? body.ollamaUrl : undefined,
      ollamaModel: typeof body.ollamaModel === 'string' ? body.ollamaModel : undefined,
      ollamaEmbedModel: typeof body.ollamaEmbedModel === 'string' ? body.ollamaEmbedModel : undefined,
      theme: body.theme === 'dark' || body.theme === 'light' ? body.theme : undefined,
    });
    // ComfyUI 地址变化 → 写回当前项目节点 + 热切换（复用 comfy/config 行为）
    if (settings.comfyUrl) {
      if (ctx.projectOpen) {
        applyMutation(ctx.projectDir, actor, `配置 ComfyUI 地址 ${settings.comfyUrl}`, (g) => {
          const proj = g.nodes.find((n) => n.type === 'project');
          if (proj) {
            proj.fields.comfyuiUrl = settings.comfyUrl;
            proj.version += 1;
          } else {
            createNode(g, {
              type: 'project', title: g.projectName,
              fields: { comfyuiUrl: settings.comfyUrl },
              position: { x: 40, y: 40 },
            });
          }
        });
      }
      // settings.json 是全局配置；即使没有项目，也应立即更新健康检查地址。
      ctx.comfy.setBaseUrl(settings.comfyUrl);
    }
    return { settings };
  });

  // —— 统一任务队列：全局任务列表不依赖当前项目 ——
  app.get('/api/tasks', async () => ({ tasks: ctx.taskQueue.list() }));

  app.post('/api/tasks/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return { ok: ctx.taskQueue.cancel(id), task: ctx.taskQueue.get(id) };
  });

  app.post('/api/tasks/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const retried = ctx.taskQueue.retry(id);
    if (!retried) {
      const current = ctx.taskQueue.get(id);
      if (!current) return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `任务不存在: ${id}` });
      return reply.code(409).send({ code: 'INVALID_PATCH', message: `任务当前状态不可重试: ${current.status}` });
    }
    reply.code(202);
    return { task: retried.task };
  });

  app.post('/api/generation/submit', async (req, reply) => {
    const body = req.body as { nodeId: string; confirm?: boolean };
    if (!body.confirm) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '提交生成需 confirm=true' });
    }
    const task = ctx.queue.submit(body.nodeId);
    reply.code(202);
    return { task };
  });

  app.get('/api/generation/status', async (req, reply) => {
    const { nodeId } = req.query as { nodeId: string };
    const task = ctx.queue.status(nodeId);
    if (!task) return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `无任务: ${nodeId}` });
    return { task };
  });

  app.get('/api/generation/queue', async () => ({ tasks: ctx.queue.list() }));

  app.post('/api/generation/cancel', async (req, reply) => {
    const body = req.body as { nodeId: string; confirm?: boolean };
    if (!body.confirm) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '取消生成需 confirm=true' });
    }
    const ok = ctx.queue.cancel(body.nodeId);
    return { ok };
  });

  // —— 素材库：项目级素材（<projectDir>/.director/assets） ——
  app.post('/api/assets/open-directory', async (_, reply) => {
    try {
      openDirectory(assetDirectoryPath(ctx.projectDir));
      return { ok: true };
    } catch (err) {
      if (err instanceof DirectorError) {
        return reply.code(400).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/assets', async () => ({ assets: listAssets(ctx.projectDir) }));

  app.post('/api/assets/import', async (req, reply) => {
    const { sourcePath } = req.body as { sourcePath: string };
    const rec = importAssetFile(ctx.projectDir, sourcePath);
    reply.code(201);
    return { asset: rec };
  });

  app.post('/api/assets/import-text', async (req, reply) => {
    const { name, content } = req.body as { name: string; content: string };
    const rec = importAssetText(ctx.projectDir, name, content);
    reply.code(201);
    return { asset: rec };
  });

  // 浏览器端上传：multipart 字段 file → 临时目录写盘 → importAssetFile 入库（finally 清理临时目录）
  app.post('/api/assets/upload', async (req, reply) => {
    // @fastify/multipart v8 的 req.file() 在非 multipart 请求下会抛错而非返回 undefined，
    // 先按契约校验 content-type 返回 400
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('multipart/form-data')) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '请求必须为 multipart/form-data' });
    }
    const file = await req.file(); // @fastify/multipart 注入
    if (!file) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '缺少 file 字段' });
    }
    const tmpDir = mkdtempSync(join(tmpdir(), 'director-upload-'));
    const tmpPath = join(tmpDir, file.filename || `upload-${randomUUID()}.bin`);
    try {
      await pipeline(file.file, createWriteStream(tmpPath));
      const asset = importAssetFile(ctx.projectDir, tmpPath);
      reply.code(201);
      return { asset };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  app.patch('/api/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; content?: string };
    try {
      return { asset: updateAsset(ctx.projectDir, id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
      }) };
    } catch (err) {
      if (err instanceof DirectorError) {
        return reply.code(err.code === 'NODE_NOT_FOUND' ? 404 : 400).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

  // 浏览器端替换素材文件：必须与原素材保持同一类型（图像/视频/文本）
  app.post('/api/assets/:id/replace', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('multipart/form-data')) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '请求必须为 multipart/form-data' });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ code: 'INVALID_PATCH', message: '缺少 file 字段' });
    const tmpDir = mkdtempSync(join(tmpdir(), 'director-replace-'));
    const tmpPath = join(tmpDir, file.filename || `replace-${randomUUID()}.bin`);
    try {
      await pipeline(file.file, createWriteStream(tmpPath));
      return { asset: replaceAssetFile(ctx.projectDir, id, tmpPath) };
    } catch (err) {
      if (err instanceof DirectorError) {
        return reply.code(err.code === 'NODE_NOT_FOUND' ? 404 : 400).send({ code: err.code, message: err.message });
      }
      throw err;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  app.delete('/api/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!confirmOf(req.query)) {
      return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除素材需 confirm=true' });
    }
    deleteAsset(ctx.projectDir, id);
    return { ok: true };
  });

  app.get('/api/assets/:id/content', async (req) => {
    const { id } = req.params as { id: string };
    return { content: readAssetText(ctx.projectDir, id) };
  });

  // 图像 captioning：Ollama 视觉模型描述图片 → 在图像同一位置生成同名 .txt 素材
  // （preview.png → preview.txt；重复执行按同名覆盖更新，不产生重复素材）
  app.post('/api/assets/:id/caption', async (req, reply) => {
    const { id } = req.params as { id: string };
    const asset = listAssets(ctx.projectDir).find((x) => x.id === id);
    if (!asset) {
      return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `素材不存在: ${id}` });
    }
    if (asset.kind !== 'img') {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '只有图像素材可以生成 caption' });
    }
    const { ollamaUrl, ollamaModel } = readSettings();
    if (!ollamaUrl || !ollamaModel) {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先在设置中配置 Ollama 地址与视觉模型' });
    }
    try {
      const submitted = submitVisionTask(ctx.taskQueue, { operation: 'caption', projectDir: ctx.projectDir, assetId: id });
      const done = await submitted.completion;
      if (done.status !== 'success') {
        return reply.code(400).send({ code: 'INVALID_PATCH', message: done.error ?? '生成 caption 任务失败' });
      }
      return { caption: done.result?.caption, asset: done.result?.asset };
    } catch (err) {
      if (err instanceof DirectorError) {
        return reply.code(400).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  });

// 项目聊天历史：按项目持久化（.director/chat.json），重启不丢；切换项目随项目加载
// —— AGENT 会话（多会话：列表/新建/重命名/删除；历史按会话作用域）——
app.get('/api/agent/sessions', async () => listChatSessions(ctx.projectDir));

app.post('/api/agent/sessions', async () => {
  const f = createChatSession(ctx.projectDir);
  return listChatSessions(ctx.projectDir);
});

app.patch('/api/agent/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string };
  renameChatSession(ctx.projectDir, id, body.title ?? '');
  return listChatSessions(ctx.projectDir);
});

app.delete('/api/agent/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteChatSession(ctx.projectDir, id);
  return listChatSessions(ctx.projectDir);
});

app.get('/api/agent/history', async (req) => {
  const { sessionId } = req.query as { sessionId?: string };
  return { messages: readChatHistory(ctx.projectDir, sessionId ?? null) };
});

// —— 故事向导（story-teller 角色页）——
// 进度存 .director/story.json；complete 时组装 Markdown 入库为 story_<项目名>.md 素材
app.get('/api/story', async () => {
  const story = readStory(ctx.projectDir);
  // 已完成时附带剧本 md（buildStoryMarkdown 单一来源；未完成返回 null，前端显示占位）
  const md = story.completedAt
    ? buildStoryMarkdown(loadGraph(ctx.projectDir).projectName || '未命名项目', story.answers)
    : null;
  return { story, md };
});

app.put('/api/story', async (req) => {
  const body = req.body as { step?: number; answers?: Record<string, string> };
  return { story: saveStory(ctx.projectDir, {
    step: typeof body.step === 'number' ? body.step : undefined,
    answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
  }) };
});

app.post('/api/story/complete', async (req, reply) => {
  const story = readStory(ctx.projectDir);
  if (story.completedAt) {
    return reply.code(409).send({ code: 'STORY_ALREADY_COMPLETED', message: '故事已完成，如需重新生成请先重置' });
  }
  const projectName = loadGraph(ctx.projectDir).projectName || '未命名项目';
  const md = buildStoryMarkdown(projectName, story.answers);
  const asset = importAssetText(ctx.projectDir, `story_${projectName}.md`, md);
  completeStory(ctx.projectDir, new Date().toISOString());
  reply.code(201);
  return { asset, story: readStory(ctx.projectDir), md };
});

// 重新生成：清空进度与 completedAt，回到第一步（spec 4.3 重新生成入口）
app.post('/api/story/reset', async () => {
  return { story: resetStory(ctx.projectDir) };
});

// —— 剧本项目（Story Boards）：项目容器 = 项目级系统提示词 + RAG 知识库 ——
// 空库自动落 Minimax-H3 Prompt Writer 默认板；boardId 不存在时相关接口抛 BOARD_NOT_FOUND
app.get('/api/story/boards', async () => ({ boards: listBoards(ctx.projectDir) }));
app.post('/api/story/boards', async (req) => {
  const body = req.body as { name?: string };
  createBoard(ctx.projectDir, body.name ?? '');
  return { boards: listBoards(ctx.projectDir) };
});
app.patch('/api/story/boards/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { name?: string };
  renameBoard(ctx.projectDir, id, body.name ?? '');
  return { boards: listBoards(ctx.projectDir) };
});
app.delete('/api/story/boards/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteBoard(ctx.projectDir, id);
  return { boards: listBoards(ctx.projectDir) };
});

// 项目级系统提示词（整体替换传入键；键未传 = 清空回退内置默认）
app.put('/api/story/boards/:id/system-prompts', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { storyTeller?: string; storySummarize?: string };
  const board = saveBoardPrompts(ctx.projectDir, id, {
    storyTeller: body.storyTeller ?? '',
    storySummarize: body.storySummarize ?? '',
  });
  return { board };
});

// RAG：开关 / 添加素材（asset id，txt 文本）/ 移除
app.post('/api/story/boards/:id/rag/toggle', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { enabled?: boolean };
  return { board: setBoardRagEnabled(ctx.projectDir, id, body.enabled === true) };
});
app.post('/api/story/boards/:id/rag/assets', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { assetId?: string };
  if (!body.assetId) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '缺少 assetId' });
  }
  return { board: addBoardRagAsset(ctx.projectDir, id, body.assetId) };
});
app.delete('/api/story/boards/:id/rag/assets/:assetId', async (req) => {
  const { id, assetId } = req.params as { id: string; assetId: string };
  return { board: removeBoardRagAsset(ctx.projectDir, id, assetId) };
});

// RAG 检索预览：返回命中片段（真实链路 = 分块 + Ollama embedding + 余弦 top-k）
app.post('/api/story/boards/:id/rag/search', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { query?: string; topK?: number };
  const board = findBoard(ctx.projectDir, id);
  if (!board) return reply.code(404).send({ code: 'BOARD_NOT_FOUND', message: '剧本项目不存在' });
  const r = await ragSearch(
    ctx.projectDir,
    board,
    body.query ?? '',
    body.topK ?? 3,
    (texts) => embedThroughQueue(ctx.taskQueue, ctx.projectDir, texts),
  );
  return r;
});

// —— 故事向导对话式（story-chat）——
// 历史独立存 .director/story-chat.json（与 AGENT 面板 chat.json 隔离）
// —— STORY 会话（多会话：列表/新建/重命名/删除；历史按会话作用域；boardId 归组）——
app.get('/api/story/chat/sessions', async (req) => {
  const { boardId } = req.query as { boardId?: string };
  return listStorySessions(ctx.projectDir, boardId ?? null);
});
app.post('/api/story/chat/sessions', async (req) => {
  const body = req.body as { boardId?: string };
  createStorySession(ctx.projectDir, body.boardId ?? null);
  return listStorySessions(ctx.projectDir, body.boardId ?? null);
});
app.patch('/api/story/chat/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string };
  renameStorySession(ctx.projectDir, id, body.title ?? '');
  return listStorySessions(ctx.projectDir, (req.query as { boardId?: string }).boardId ?? null);
});
app.delete('/api/story/chat/sessions/:id', async (req) => {
  const { id } = req.params as { id: string };
  deleteStorySession(ctx.projectDir, id);
  return listStorySessions(ctx.projectDir, (req.query as { boardId?: string }).boardId ?? null);
});

app.delete('/api/story/chat/messages/:index', async (req, reply) => {
  const { index } = req.params as { index: string };
  const { sessionId } = req.query as { sessionId?: string };
  const idx = Number.parseInt(index, 10);
  if (Number.isNaN(idx)) {
    return reply.code(400).send({ code: 'INVALID_INPUT', message: '无效的消息索引' });
  }
  deleteStoryChatMessage(ctx.projectDir, sessionId ?? null, idx);
  return { messages: readStoryChat(ctx.projectDir, sessionId ?? null) };
});

app.patch('/api/story/chat/messages/:index', async (req, reply) => {
  const { index } = req.params as { index: string };
  const { sessionId } = req.query as { sessionId?: string };
  const body = req.body as { text?: string; truncateAfter?: boolean };
  const idx = Number.parseInt(index, 10);
  if (Number.isNaN(idx)) {
    return reply.code(400).send({ code: 'INVALID_INPUT', message: '无效的消息索引' });
  }
  if (typeof body.text !== 'string' || !body.text.trim()) {
    return reply.code(400).send({ code: 'INVALID_INPUT', message: '消息内容不能为空' });
  }
  updateStoryChatMessage(ctx.projectDir, sessionId ?? null, idx, body.text);
  if (body.truncateAfter) {
    truncateStoryChatMessage(ctx.projectDir, sessionId ?? null, idx);
  }
  return { messages: readStoryChat(ctx.projectDir, sessionId ?? null) };
});

app.get('/api/story/chat/history', async (req) => {
  const { sessionId } = req.query as { sessionId?: string };
  return { messages: readStoryChat(ctx.projectDir, sessionId ?? null) };
});

app.post('/api/story/chat', async (req, reply) => {
  const body = req.body as {
    message?: string; model?: string; thinking?: string; persistAs?: string; sessionId?: string;
    systemPrompt?: string; boardId?: string; modelSupportsImages?: boolean;
    images?: Array<{ name?: string; data?: string }>;
    assetRefs?: Array<{ id?: string; name?: string; kind?: 'txt' | 'img' | 'vid' }>;
  };
  const message = (body.message ?? '').trim();
  // 附件（图片）允许空文本：消息与图片至少其一
  const images = Array.isArray(body.images) ? body.images : [];
  const assetRefs = Array.isArray(body.assetRefs) ? body.assetRefs : [];
  if (!message && images.length === 0 && assetRefs.length === 0) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '消息不能为空' });
  }
  // 图片附件 → 临时文件；随后作为 @file 传给 pi（模型可见）
  const imgAttach = writeStoryChatImages(images);
  // 组装对话上下文：项目名 + 向导答案 + 最近历史 + （可选）剧本项目提示词与 RAG 命中
  const graph = loadGraph(ctx.projectDir);
  const story = readStory(ctx.projectDir);
  const sessionId = body.sessionId ?? null;
  const history = readStoryChat(ctx.projectDir, sessionId);
  // 剧本项目：boardId 存在 → 项目级提示词（systemPrompt 缺省时回退）+ RAG 检索注入
  const board = body.boardId ? findBoard(ctx.projectDir, body.boardId) : undefined;
  const boardPrompt = board?.systemPrompts.storyTeller?.trim();
  const effectiveSystem = body.systemPrompt?.trim() || boardPrompt || undefined;
  // 系统动作（总结成稿等 persistAs 标记）不做 RAG 检索：查询是长指令，命中无意义
  let ragContext = '';
  if (message && board?.ragEnabled && board.ragAssets.length > 0 && !body.persistAs) {
    const r = await ragSearch(
      ctx.projectDir,
      board,
      message,
      3,
      (texts) => embedThroughQueue(ctx.taskQueue, ctx.projectDir, texts),
    );
    if (r.status === 'ok' && r.hits.length > 0) ragContext = formatRagHits(r.hits);
  }
  const assetContext = buildStoryAssetContext(ctx.projectDir, assetRefs);
  const assetImageInput = buildStoryAssetImageFiles(ctx.projectDir, assetRefs);
  const mode = body.persistAs === '（请总结成稿）' ? 'system' : 'chat';
  const buildPrompt = (visionContext = '') => {
    const context = [assetContext, visionContext].filter((part) => part.trim()).join('\n\n');
    return buildStoryChatPrompt(
      graph.projectName,
      story.answers,
      history,
      context ? `${message}\n\n${context}` : message,
      effectiveSystem,
      ragContext,
      mode,
    );
  };
  const prompt = buildPrompt();

  const baseCmd = (process.env.DIRECTOR_PI_CMD ?? 'pi --mode json').split(' ').filter(Boolean);
  if (!process.env.DIRECTOR_PI_CMD) {
    const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
    const mcpFile = writeAgentMcpConfig(mcpPort, false);
    if (mcpFile) baseCmd.push('--mcp-config', mcpFile);
  }
  if (body.model) baseCmd.push('--model', body.model);
  if (body.thinking && THINKING_LEVELS.includes(body.thinking)) {
    baseCmd.push('--thinking', body.thinking);
  }
  // 图片附件与无 caption 的素材库图片：视觉模型走 @绝对路径；文本模型会在下方改走 Ollama 描述降级。
  const imageFilesForPi = [...(imgAttach?.files ?? []), ...assetImageInput.files];
  const imageCmd = imageFilesForPi.length > 0
    ? [...baseCmd, ...imageFilesForPi.map((file) => '@' + file)]
    : baseCmd;

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (text: string) => reply.raw.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
  // 用户消息先落盘（不依赖 pi 是否正常退出）；agent 全文在流结束后落盘。
  // persistAs：系统动作（总结成稿/回填向导）的落盘标记——message 是长指令 prompt，
  // 若原文落盘会快速消耗 100 条历史上限并污染下次对话的 20 条上下文窗口。
  // boardId：自动创建会话时归组到剧本项目
  // 仅图片无文本时落盘标记占位，避免历史气泡为空；文本正常落盘
  appendStoryChat(ctx.projectDir, sessionId, 'user', body.persistAs ?? (message || (images.length > 0 ? '[图片附件]' : '[素材引用]')), body.boardId ?? null);
  let agentText = '';
  let pending = '';
  let flushTimer: NodeJS.Timeout | null = null;
  const flushPending = () => {
    if (pending) { send(pending); pending = ''; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  };
  const pushDelta = (delta: string) => {
    agentText += delta;
    pending += delta;
    if (pending.length >= 120) flushPending();
    else if (!flushTimer) flushTimer = setTimeout(flushPending, 60);
  };
  // 模型调用错误（403 等）：pi 在 message 事件里带 errorMessage；空输出时展示具体原因
  let modelError = '';
  const sendCollect = (line: string): boolean => {
    const t = line.trim();
    if (t.startsWith('{')) {
      try {
        const ev = JSON.parse(t) as {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string };
          message?: { errorMessage?: string };
        };
        if ((ev.type === 'message_start' || ev.type === 'message_end') && typeof ev.message?.errorMessage === 'string' && ev.message.errorMessage) {
          modelError = ev.message.errorMessage;
        }
        if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
          const delta = ev.assistantMessageEvent.delta ?? '';
          if (delta) pushDelta(delta);
        }
        return ev.type === 'agent_end';
      } catch {
        // 解析失败按文本行处理
      }
    }
    agentText += t + '\n';
    send(t);
    return false;
  };
  try {
    const idleMs = Number(process.env.DIRECTOR_AGENT_IDLE_MS) || 45_000;
    const imageFiles = imageFilesForPi;
      const describeFallbackImages = async (): Promise<string> => {
        const contexts: string[] = [];
        if (assetImageInput.ids.length > 0) contexts.push(await describeAssetImages(ctx.projectDir, assetImageInput.ids, ctx.taskQueue));
        if (imgAttach && imgAttach.files.length > 0) contexts.push(await describeStoryImages(imgAttach.files, ctx.taskQueue));
        return contexts.filter((context) => context.trim()).join('\n\n');
      };
    let runPrompt = prompt.userPrompt;
    let runCmd = imageCmd;
    let runSystemPrompt = prompt.systemPrompt;
    let idleKilled = false;
    let failureMessage = '';

    // 模型列表已明确标记为不支持视觉：先调用 Ollama，再把纯文本描述交给原模型。
    if (imageFiles.length > 0 && body.modelSupportsImages === false) {
      try {
        const visionContext = await describeFallbackImages();
        const visionPrompt = buildPrompt(visionContext);
        runPrompt = visionPrompt.userPrompt;
        runSystemPrompt = visionPrompt.systemPrompt;
        runCmd = baseCmd;
      } catch (err) {
        failureMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (!failureMessage) {
      // 故事聊天不注入项目目录/名称环境变量：保持故事角色与画布和工作台完全隔离
      const first = await runAgentStream(runCmd, runPrompt, sendCollect, {
        idleTimeoutMs: idleMs,
        systemPrompt: runSystemPrompt,
      });
      idleKilled = first.idleKilled;
      flushPending();

      // 能力未知时，只有明确的视觉能力错误且尚无输出才自动重试一次 Ollama 降级。
      const firstModelError = modelError;
      if (imageFiles.length > 0 && !body.modelSupportsImages && !idleKilled
        && agentText.trim().length === 0 && isVisionUnsupportedError(firstModelError)) {
        try {
          const visionContext = await describeFallbackImages();
          modelError = '';
          const retryPrompt = buildPrompt(visionContext);
          const retry = await runAgentStream(baseCmd, retryPrompt.userPrompt, sendCollect, {
            idleTimeoutMs: idleMs,
            systemPrompt: retryPrompt.systemPrompt,
          });
          idleKilled = retry.idleKilled;
          flushPending();
        } catch (err) {
          failureMessage = err instanceof Error ? err.message : String(err);
        }
      }
    }

    appendStoryChat(ctx.projectDir, sessionId, 'agent', agentText, body.boardId ?? null);
    if (failureMessage) send(`\n\n（${failureMessage}）`);
    else if (idleKilled) send('\n\n（输出已空闲停止）');
    else if (agentText.trim().length === 0) {
      send(modelError ? `\n\n（模型调用失败：${modelError}）` : '\n\n（输出为空）');
    }
    reply.raw.write('data: [DONE]\n\n');
  } catch (err) {
    send(`（agent 启动失败：${err instanceof Error ? err.message : String(err)}）`);
    reply.raw.write('data: [DONE]\n\n');
  } finally {
    // 图片临时文件只在 pi 读取期间需要，流结束后立即清理
    if (imgAttach) rmSync(imgAttach.tmpDir, { recursive: true, force: true });
  }
  reply.raw.end();
});

// —— 物体设计器（object-designer 角色页）——
// 对象设计列表存 .director/design.json；生成参考图走 /api/designs/:id/generate（Task 5）
app.get('/api/workflows', async () => {
  const wfDir = process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
  const names: string[] = [];
  try {
    for (const f of readdirSync(wfDir)) {
      const m = /^(.*)\.template\.json$/.exec(f);
      if (m) names.push(m[1]!);
    }
  } catch {
    // 目录不存在 → 空列表（前端显示「暂无模板」）
  }
  return { workflows: names.sort() };
});

app.get('/api/designs', async () => ({ designs: listDesigns(ctx.projectDir) }));

app.post('/api/designs', async (req, reply) => {
  const body = req.body as { kind?: string; name?: string };
  try {
    const design = createDesign(ctx.projectDir, body.kind as DesignKind, body.name ?? '');
    reply.code(201);
    return { design };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'INVALID_PATCH') {
      return reply.code(400).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

app.put('/api/designs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const patch = (req.body as { patch?: Record<string, unknown> }).patch ?? {};
  try {
    return { design: updateDesign(ctx.projectDir, id, patch as Partial<DesignObject>) };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'NODE_NOT_FOUND') {
      return reply.code(404).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

app.delete('/api/designs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!confirmOf(req.query)) {
    return reply.code(400).send({ code: 'CONFIRM_REQUIRED', message: '删除设计对象需 confirm=true' });
  }
  try {
    deleteDesign(ctx.projectDir, id);
    return { ok: true };
  } catch (err) {
    if (err instanceof DirectorError && err.code === 'NODE_NOT_FOUND') {
      return reply.code(404).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

// 生成参考图：同步等待 ComfyUI 完成 → 下载 → 素材库入库 → 状态写回对象。
// 模板规则：必须含 ${prompt}；允许变量 seed/width/height/steps/cfg/negative_prompt；
// 未知变量返回 400 并列出（引导用户调整自备模板）。
app.post('/api/designs/:id/generate', async (req, reply) => {
  const { id } = req.params as { id: string };
  const designs = listDesigns(ctx.projectDir);
  const design = designs.find((d) => d.id === id);
  if (!design) {
    return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `设计对象不存在: ${id}` });
  }
  if (design.status === 'generating') {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '该对象正在生成中' });
  }
  // 提示词 = 风格 + 描述（先于模板校验：描述缺失是最根本的请求方错误）；
  // 字段可能为 null/undefined（PUT patch 无校验透传 / design.json 手工编辑缺字段），
  // 用 typeof 守卫避免 .trim() 抛 TypeError → 500
  const prompt = [design.style, design.description]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(', ').trim();
  if (!prompt) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先填写风格或视觉描述' });
  }
  // 模板变量校验（模板不存在 / 缺 ${prompt} / 未知变量 → 400，不写状态）
  const wfDir = process.env.DIRECTOR_WORKFLOWS_DIR ?? join(process.cwd(), 'workflows');
  const templatePath = join(wfDir, `${design.template}.template.json`);
  let templateText: string;
  try {
    templateText = readFileSync(templatePath, 'utf8');
  } catch {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: `模板不存在: ${design.template}` });
  }
  // 提取正则与 buildWorkflow 的 ${([^}]+)} 保持一致：非常规变量名（如 ${foo-bar}）
  // 也必须被检出为“未知变量”→ 400，而不是漏检后走进生成流程
  const vars = [...templateText.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!);
  const SUPPORTED = new Set(['prompt', 'seed', 'width', 'height', 'steps', 'cfg', 'negative_prompt']);
  const unknown = [...new Set(vars)].filter((v) => !SUPPORTED.has(v));
  if (!vars.includes('prompt')) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '模板必须包含 ${prompt} 变量（文生图提示词入口）' });
  }
  if (unknown.length > 0) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: `模板包含不支持的变量: ${unknown.join(', ')}（支持: ${[...SUPPORTED].join(', ')}）` });
  }
  // ComfyUI 连接检查：未连接直接 400，不排队空转
  if (!(await ctx.comfy.health())) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先配置 ComfyUI 地址（点击顶栏 COMFYUI 徽章）' });
  }
  // 标记生成中 → 提交统一任务 → 等待 → 下载 → 入库
  updateDesign(ctx.projectDir, id, { status: 'generating' });
  const submitted = ctx.taskQueue.submit({
    kind: 'comfy-design',
    label: `参考图：${design.name}`,
    projectDir: ctx.projectDir,
    payload: { designId: id, comfyBaseUrl: ctx.comfy.baseUrl },
    dedupeKey: `comfy-design:${ctx.projectDir}:${id}`,
  });
  const done = await submitted.completion;
  if (done.status !== 'success') {
    const failed = updateDesign(ctx.projectDir, id, { status: 'failed', error: done.error ?? '参考图生成失败' });
    return { design: failed };
  }
  const generated = done.result?.design;
  if (!generated || typeof generated !== 'object') {
    const failed = updateDesign(ctx.projectDir, id, { status: 'failed', error: '参考图生成返回空结果' });
    return { design: failed };
  }
  return { design: generated };
});

// —— Ollama 本地视觉模型：图像 → 提示词（物体设计器「图像转描述」）——
// 配置（地址 + 视觉模型）在全局设置 settings.json；模型列表供设置面板下拉
// url 查询参数：设置面板「获取模型」用当前输入框地址拉取（未保存前即可预览）；缺省回退已保存地址
app.get('/api/ollama/models', async (req) => {
  const { url } = req.query as { url?: string };
  const ollamaUrl = (url ?? '').trim() || readSettings().ollamaUrl;
  if (!ollamaUrl) return { models: [] };
  try {
    return { models: await new OllamaClient(ollamaUrl).listModels() };
  } catch {
    // Ollama 未启动/不可达：返回空列表，设置面板不报错（保存后再拉取）
    return { models: [] };
  }
});

// 图像 captioning 指令：生成可复述/检索的详细中文描述（区别于物体设计器的文生图外观描述）
const CAPTION_INSTRUCTION = '请为这张图片生成一条详细的中文描述（caption），覆盖：主体（人物/动物/物体）及其外观与动作、场景环境、构图、光线、色调与风格。直接输出描述文本本身，不要解释、不要引号、不要 Markdown 标记。';

// 图像转提示词：指定素材库图片（assetId）→ base64 → Ollama 视觉模型 → 外观描述文本
app.post('/api/ollama/image-to-prompt', async (req, reply) => {
  const body = req.body as { assetId?: string; instruction?: string };
  const assetId = (body.assetId ?? '').trim();
  if (!assetId) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '缺少 assetId' });
  }
  // 素材必须是图片（assetFilePath 对未知 id 抛 NODE_NOT_FOUND）
  const asset = listAssets(ctx.projectDir).find((x) => x.id === assetId);
  if (!asset) {
    return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `素材不存在: ${assetId}` });
  }
  if (asset.kind !== 'img') {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '该素材不是图片，无法转提示词' });
  }
  const { ollamaUrl, ollamaModel } = readSettings();
  if (!ollamaUrl || !ollamaModel) {
    return reply.code(400).send({ code: 'INVALID_PATCH', message: '请先在设置中配置 Ollama 地址与视觉模型' });
  }
  // 默认指令：把图转成文生图可用的外观描述（物体设计器语境）；调用方可覆盖
  const instruction = (body.instruction ?? '').trim() ||
    '请用中文描述这张图片中主体（人物/场景/物品）的外观：外貌、材质、颜色、光影、构图要点。输出一段可直接作为文生图提示词的外观描述，只输出描述本身，不要解释、不要引号。';
  try {
    const submitted = submitVisionTask(ctx.taskQueue, {
      operation: 'image-to-prompt', projectDir: ctx.projectDir, assetId, instruction,
    });
    const done = await submitted.completion;
    if (done.status !== 'success') {
      return reply.code(400).send({ code: 'INVALID_PATCH', message: done.error ?? '图像转提示词任务失败' });
    }
    const prompt = typeof done.result?.prompt === 'string' ? done.result.prompt : '';
    if (!prompt) return reply.code(400).send({ code: 'INVALID_PATCH', message: '图像转提示词返回空结果' });
    return { prompt, assetId };
  } catch (err) {
    if (err instanceof DirectorError) {
      return reply.code(400).send({ code: err.code, message: err.message });
    }
    throw err;
  }
});

// 素材文件字节流（图片参考图预览 / 文本内容）：content-type 按扩展名（与 kindOf 可入库类型对齐）
app.get('/api/assets/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  // 一次查找取记录（不存在直接 404，不重复手抛 DirectorError；文件读取复用 store 的 assetFilePath）
  const rec = listAssets(ctx.projectDir).find((x) => x.id === id);
  if (!rec) {
    return reply.code(404).send({ code: 'NODE_NOT_FOUND', message: `素材不存在: ${id}` });
  }
  const ext = rec.ext.toLowerCase();
  const type = ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : ext === '.mp4' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
    : ext === '.mov' ? 'video/quicktime'
    : 'text/plain; charset=utf-8';
  reply.header('content-type', type);
  return reply.send(readFileSync(assetFilePath(ctx.projectDir, id)));
});

// —— 计划 4 Task 3：pi 桥 SSE 流式对话 ——
  app.post('/api/agent/chat', async (req, reply) => {
    const body = req.body as {
      message: string;
      chips?: Array<{ name: string; content: string }>;
      model?: string;
      thinking?: string;
      sessionId?: string;
      assetRefs?: Array<{ id?: string; name?: string; kind?: 'txt' | 'img' | 'vid' }>;
    };
    // 画布摘要：节点类型计数（agent 上下文，避免全量图塞爆提示词）
    const graph = loadGraph(ctx.projectDir);
    const counts = new Map<string, number>();
    for (const n of graph.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const graphSummary = [...counts.entries()].map(([t, c]) => `${c}×${t}`).join(' · ') || '空画布';

    const cmd = (process.env.DIRECTOR_PI_CMD ?? 'pi --mode json').split(' ').filter(Boolean);
    // 默认 pi 命令时注入 chat 专用 MCP 配置（只含 director-workbench，避免 openreel 等
    // 无关 MCP 拖慢启动/误操作其他画布）；自定义命令（mock/测试）不加参数
    if (!process.env.DIRECTOR_PI_CMD) {
      const mcpPort = Number(process.env.DIRECTOR_MCP_PORT ?? 4778);
      const mcpFile = writeAgentMcpConfig(mcpPort);
      if (mcpFile) cmd.push('--mcp-config', mcpFile);
    }
    // 模型透传（pi --model 支持 "provider/id" 形式）；不经过 shell，无注入风险
    if (body.model) cmd.push('--model', body.model);
    // 思考强度透传（pi --thinking）；非法级别忽略（防御式：意外值不生效）
    if (body.thinking && THINKING_LEVELS.includes(body.thinking)) {
      cmd.push('--thinking', body.thinking);
    }
    const assetInput = buildAgentAssetContext(ctx.projectDir, body.assetRefs ?? []);
    const prompt = buildAgentPrompt({
      message: body.message,
      chips: body.chips ?? [],
      graphSummary,
      assetContext: assetInput.context,
    });
    const imageCmd = assetInput.imageFiles.length > 0
      ? [...cmd, ...assetInput.imageFiles.map((file) => '@' + file)]
      : cmd;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (text: string) => reply.raw.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    const sessionId = body.sessionId ?? null;
    // 用户消息先落盘（不依赖 pi 是否正常退出）；agent 全文在流结束后落盘
    appendChatMessage(ctx.projectDir, sessionId, 'user', body.message);
    // 流式累积 agent 全文（pi --mode json 的 text_delta 增量拼接）；
    // 节流合并：delta 按 60ms/120 字符成块发送——逐 token 全量转发会让前端
    // 每次重渲染 ReactMarkdown，块级转发兼顾流式观感与渲染性能。
    let agentText = '';
    let pending = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flushPending = () => {
      if (pending) { send(pending); pending = ''; }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    };
    const pushDelta = (delta: string) => {
      agentText += delta;
      pending += delta;
      if (pending.length >= 120) flushPending();
      else if (!flushTimer) flushTimer = setTimeout(flushPending, 60);
    };
    // 行回调：json 模式解析 message_update/text_delta 增量；agent_end 表示输出完成
    // （提前终止进程，不等 pi 自然退出）；其他事件忽略；非 JSON 行（自定义命令/mock）
    // 按原行转发（兼容旧行为）。返回 true 时 runAgentStream 会 kill 子进程。
    // 模型调用错误（403 等）：pi 在 message 事件里带 errorMessage；空输出时展示具体原因
    let modelError = '';
    const sendCollect = (line: string): boolean => {
      const t = line.trim();
      if (t.startsWith('{')) {
        try {
          const ev = JSON.parse(t) as {
            type?: string;
            assistantMessageEvent?: { type?: string; delta?: string };
            message?: { errorMessage?: string };
          };
          if ((ev.type === 'message_start' || ev.type === 'message_end') && typeof ev.message?.errorMessage === 'string' && ev.message.errorMessage) {
            modelError = ev.message.errorMessage;
          }
          if (ev.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
            const delta = ev.assistantMessageEvent.delta ?? '';
            if (delta) pushDelta(delta);
          }
          return ev.type === 'agent_end';
        } catch {
          // 解析失败按文本行处理
        }
      }
      agentText += t + '\n';
      send(t);
      return false;
    };
    try {
      const idleMs = Number(process.env.DIRECTOR_AGENT_IDLE_MS) || 45_000;
      // 注入项目上下文（kanban KANBAN_TASK_ID 语义）：agent 进程内可感知当前项目
      const first = await runAgentStream(imageCmd, prompt, sendCollect, {
        idleTimeoutMs: idleMs,
      env: {
        DIRECTOR_PROJECT_DIR: ctx.projectDir,
        DIRECTOR_PROJECT_NAME: graph.projectName,
      },
    });
      let idleKilled = first.idleKilled;
      flushPending();

      // 能力未知时，只有明确的视觉能力错误且尚无输出才自动回退 Ollama；
      // 生成的描述会写回图片 caption，后续引用直接复用。
      if (assetInput.imageFiles.length > 0 && !idleKilled
        && agentText.trim().length === 0 && isVisionUnsupportedError(modelError)) {
        try {
          const visionContext = await describeAssetImages(ctx.projectDir, assetInput.imageAssetIds, ctx.taskQueue);
          const retryPrompt = buildAgentPrompt({
            message: body.message,
            chips: body.chips ?? [],
            graphSummary,
            assetContext: [assetInput.context, visionContext].filter((context) => context.trim()).join('\\n\\n'),
          });
          modelError = '';
          const retry = await runAgentStream(cmd, retryPrompt, sendCollect, {
            idleTimeoutMs: idleMs,
            env: {
              DIRECTOR_PROJECT_DIR: ctx.projectDir,
              DIRECTOR_PROJECT_NAME: graph.projectName,
            },
          });
          idleKilled = retry.idleKilled;
          flushPending();
        } catch (err) {
          send(`\\n\\n（${err instanceof Error ? err.message : String(err)}）`);
        }
      }

      appendChatMessage(ctx.projectDir, sessionId, 'agent', agentText);
      if (idleKilled) send('\n\n（输出已空闲停止）');
      else if (agentText.trim().length === 0) {
        send(modelError ? `\n\n（模型调用失败：${modelError}）` : '\n\n（输出为空）');
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      send(`（agent 启动失败：${err instanceof Error ? err.message : String(err)}）`);
      reply.raw.write('data: [DONE]\n\n');
    }
    reply.raw.end();
  });

  // pi 模型列表（内置面板模型下拉数据源）：解析 `pi --list-models` 表格输出
  app.get('/api/agent/models', async () => {
    const cmd = (process.env.DIRECTOR_PI_LIST_CMD ?? 'pi --list-models').split(' ').filter(Boolean);
    const { stdout } = await runAgentCollect(cmd);
    const models: Array<{ id: string; provider: string; thinking: boolean; images: boolean }> = [];
    for (const line of stdout.split('\n')) {
      const cells = line.trim().split(/\s+/);
      // 表头行与空行跳过；合法行：provider model context max-out thinking images
      if (cells.length < 6 || cells[0] === 'provider') continue;
      const [provider, model, , , thinking, images] = cells;
      if (!provider || !model) continue;
      models.push({
        id: `${provider}/${model}`,
        provider: provider!,
        thinking: thinking === 'yes',
        images: images === 'yes',
      });
    }
    return { models };
  });

  // DirectorError → HTTP 状态码
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DirectorError) {
      const status = err.code === 'CONFIRM_REQUIRED' ? 400
        : err.code === 'SNAPSHOT_FUTURE_EXISTS' ? 409
        : err.code === 'STORY_ALREADY_COMPLETED' ? 409
        : err.code === 'NODE_NOT_FOUND' || err.code === 'EDGE_NOT_FOUND' || err.code === 'SESSION_NOT_FOUND' || err.code === 'BOARD_NOT_FOUND' ? 404
        : 400;
      reply.code(status).send({ code: err.code, message: err.message });
      return;
    }
    reply.code(500).send({ code: 'INTERNAL', message: err.message });
  });
}