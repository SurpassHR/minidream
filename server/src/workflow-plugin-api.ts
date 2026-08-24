import type { Express, Request, Response } from 'express';
import { convertUiToApi, getWorkflowJson, isUiFormat, introspectWorkflow, pruneDeadNodes, type WorkflowSpec } from './workflow.js';
import {
  deleteImportedWorkflow,
  deleteManifest,
  readManifest,
  readWorkflowJson,
  writeManifest,
  writeWorkflowJson,
  type WorkflowManifestRecord,
} from './workflow-plugin-store.js';
import {
  buildCatalogSpecs,
  getCatalogWorkflowJson,
  listCatalogSources,
  mergeRedetectedSpec,
  type WorkflowCatalogOptions,
  type WorkflowCatalogSource,
} from './workflow-catalog.js';
import { getObjectInfo } from './comfyui.js';
import { buildWorkflowGraph, createParamFromGraphField, type WorkflowGraph, type WorkflowGraphField } from './workflow-graph.js';
import { PLUGIN_SKILLS_DIR, deletePluginSkill, generatePluginSkill, readPluginSkill, syncPluginSkill, writeCustomSkill, writePluginSkill } from './workflow-skill.js';
import { defaultPluginResponseProtocol, deletePluginResponseProtocol, readPluginResponseProtocol, syncPluginResponseProtocol, validatePluginResponseProtocol, writePluginResponseProtocol, resolvePluginResponseProtocol, type PluginResponseProtocol } from './workflow-response.js';
import type { PluginSkillChatMessage, PluginSkillChatResult } from './agent/bridge.js';

export interface WorkflowNodeCandidate {
  nodeId: string;
  classType: string;
  title: string;
  fields: Array<{ field: string; type: string; connected: boolean }>;
}

export interface WorkflowPluginApiOptions {
  catalog: WorkflowCatalogOptions;
  dataRoot: string;
  objectInfo?: () => Promise<Record<string, any>>;
  isWorkflowEnabled?: (id: string) => boolean;
  invalidate: () => void;
  /** skill 文件落盘目录（默认仓库 .pi/skills） */
  skillsDir?: string;
  /** 用 plugin-skill-creator 为插件生成 SKILL.md 的调用方（未配置时 generate 端点返回 501） */
  generateSkill?: (spec: WorkflowSpec) => Promise<string>;
  /** 对话调整 Skill 的调用方；返回预览内容，不应在此处写盘 */
  chatSkill?: (
    spec: WorkflowSpec,
    currentSkill: string,
    history: PluginSkillChatMessage[],
    userMessage: string,
  ) => Promise<PluginSkillChatResult>;
}

function jsonError(res: Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

function safeSlug(value: string): string {
  const id = value
    .trim()
    .replace(/\.json$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!id) throw new Error('无法从文件名生成有效的工作流插件 ID');
  return id;
}

function sourceFor(source: WorkflowCatalogSource): WorkflowManifestRecord['source'] {
  return {
    type: source.source.type,
    workflowFile: source.source.type === 'imported' ? `workflows/${source.id}.json` : source.source.workflowFile,
  };
}

function validateWorkflowJson(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow 必须是 JSON 对象');
  const json = value as Record<string, any>;
  if (!isUiFormat(json)) {
    const entries = Object.values(json);
    if (!entries.length || !entries.some(node => node && typeof node === 'object' && typeof (node as any).class_type === 'string')) {
      throw new Error('不是有效的 ComfyUI 工作流：需要 API 格式节点映射或 UI 格式 nodes 数组');
    }
  }
  return json;
}

function nodeFields(json: Record<string, any>, objectInfoData: Record<string, any>): Map<string, Set<string>> {
  const api = isUiFormat(json)
    ? convertUiToApi(json, objectInfoData)
    : Object.fromEntries(Object.entries(json).filter(([id]) => id !== '_meta'));
  const fields = new Map<string, Set<string>>();
  for (const [id, node] of Object.entries(api)) {
    if (!node || typeof node !== 'object') continue;
    const classType = String((node as any).class_type ?? '');
    const info = objectInfoData[classType]?.input ?? {};
    const defs = { ...(info.required ?? {}), ...(info.optional ?? {}) } as Record<string, unknown>;
    const names = new Set([...Object.keys(defs), ...Object.keys((node as any).inputs ?? {})]);
    if (classType === 'Power Lora Loader (rgthree)' && Object.keys((node as any).inputs ?? {}).some(field => /^lora_\d+$/.test(field))) {
      names.add('lora');
    }
    fields.set(id, names);
  }
  return fields;
}

export function validateManifestStructure(previous: WorkflowSpec, next: WorkflowSpec): string | null {
  const groups = [
    ['inputs', previous.inputs, next.inputs, ['id', 'kind', 'nodeId', 'field', 'classType']],
    ['outputs', previous.outputs, next.outputs, ['id', 'kind', 'nodeId', 'classType']],
  ] as const;
  for (const [name, before, after, structural] of groups) {
    if (before.length !== after.length) return `${name} 映射数量不可改变`;
    for (let index = 0; index < before.length; index++) {
      const previousItem = before[index]!;
      const nextItem = after[index]!;
      for (const key of structural) {
        if (JSON.stringify((previousItem as any)[key]) !== JSON.stringify((nextItem as any)[key])) {
          return `${name} 映射结构不可修改：${key}`;
        }
      }
    }
  }
  return null;
}

export async function validateWorkflowManifest(
  manifest: WorkflowSpec,
  json: Record<string, any>,
  objectInfoData: Record<string, any> = {},
  requireOutput = true,
): Promise<string | null> {
  const fields = nodeFields(json, objectInfoData);
  const ids = new Set<string>();
  const addId = (group: string, id: string): string | null => {
    if (!id.trim()) return `${group} 映射 ID 不能为空`;
    if (ids.has(`${group}:${id}`)) return `${group} 映射 ID 重复：${id}`;
    ids.add(`${group}:${id}`);
    return null;
  };
  for (const input of manifest.inputs ?? []) {
    const idError = addId('inputs', input.id);
    if (idError) return idError;
    if (!fields.has(input.nodeId)) return `inputs 映射 ${input.id} 指向不存在节点：${input.nodeId}`;
    if (!fields.get(input.nodeId)!.has(input.field)) return `inputs 映射 ${input.id} 指向不存在字段：${input.nodeId}.${input.field}`;
  }
  for (const param of manifest.params ?? []) {
    const idError = addId('params', param.id);
    if (idError) return idError;
    if (!fields.has(param.nodeId)) return `params 映射 ${param.id} 指向不存在节点：${param.nodeId}`;
    if (!fields.get(param.nodeId)!.has(param.field)) return `params 映射 ${param.id} 指向不存在字段：${param.nodeId}.${param.field}`;
    for (const applyId of param.applyTo ?? []) {
      if (!fields.has(applyId)) return `params 映射 ${param.id} applyTo 指向不存在节点：${applyId}`;
    }
  }
  for (const input of manifest.inputs ?? []) {
    if (!['text', 'image', 'video'].includes(input.kind)) return `inputs 映射 ${input.id} 的类型无效`;
  }
  for (const param of manifest.params ?? []) {
    if (!['INT', 'FLOAT', 'BOOLEAN', 'STRING', 'SEED', 'combo'].includes(param.type)) return `params 映射 ${param.id} 的类型无效`;
  }
  for (const output of manifest.outputs ?? []) {
    if (!['image', 'video', 'text'].includes(output.kind)) return `outputs 映射 ${output.id} 的类型无效`;

    const idError = addId('outputs', output.id);
    if (idError) return idError;
    if (!fields.has(output.nodeId)) return `outputs 映射 ${output.id} 指向不存在节点：${output.nodeId}`;
  }
  if (requireOutput && !manifest.outputs?.some(output => !output.hidden)) return '至少保留一个可用输出映射';
  return null;
}

function graphFields(graph: WorkflowGraph): WorkflowGraphField[] {
  return graph.nodes.flatMap(node => node.fields);
}

export function validateParamMappings(manifest: WorkflowSpec, graph: WorkflowGraph): string | null {
  const fields = graphFields(graph);
  const seen = new Set<string>();
  for (const param of manifest.params ?? []) {
    const key = `${param.nodeId}:${param.field}`;
    if (seen.has(key)) return `params 映射重复：${key}`;
    seen.add(key);
    const field = fields.find(candidate => candidate.nodeId === param.nodeId && candidate.field === param.field);
    if (!field) return `params 映射 ${param.id} 指向不存在字段：${param.nodeId}.${param.field}`;
    if (!field.selectable || field.connected) return `params 映射 ${param.id} 只能指向未连接的 widget 字段`;
    const generated = createParamFromGraphField(field);
    if (param.id !== generated.id) return `params 映射 ${param.id} 的 ID 不符合字段映射：应为 ${generated.id}`;
    if (param.type !== generated.type) return `params 映射 ${param.id} 的类型不可修改：应为 ${generated.type}`;
    // applyTo 只由 graph 对共享采样参数/逻辑 LoRA 字段生成；校验直接对比同一来源，
    // 避免按“同名可勾选字段”重新推导导致 add_noise 等非共享重复字段误报结构不符。
    const expected = [...(field.applyTo ?? [])].sort();
    if (JSON.stringify([...(param.applyTo ?? [])].sort()) !== JSON.stringify(expected)) {
      return `params 映射 ${param.id} 的 applyTo 不符合工作流结构`;
    }
  }
  return null;
}

function inferType(value: unknown): string {
  if (Array.isArray(value)) return 'LINK';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INT' : 'FLOAT';
  if (typeof value === 'string') return 'STRING';
  return 'UNKNOWN';
}

async function objectInfoOf(options: WorkflowPluginApiOptions): Promise<Record<string, any>> {
  return (options.objectInfo ?? getObjectInfo)().catch(() => ({}));
}

async function nodeCandidates(options: WorkflowPluginApiOptions, source: WorkflowCatalogSource): Promise<WorkflowNodeCandidate[]> {
  const oi = await objectInfoOf(options);
  const json = source.json;
  const api = isUiFormat(json)
    ? convertUiToApi(json, oi)
    : Object.fromEntries(Object.entries(json).filter(([id]) => id !== '_meta'));
  const candidates: WorkflowNodeCandidate[] = [];
  for (const [nodeId, node] of Object.entries(api)) {
    if (!node || typeof node !== 'object') continue;
    const classType = String((node as any).class_type ?? '');
    const info = oi[classType]?.input ?? {};
    const defs = { ...(info.required ?? {}), ...(info.optional ?? {}) } as Record<string, any>;
    const fields = Object.entries((node as any).inputs ?? {}).map(([field, value]) => ({
      field,
      type: typeof defs[field] === 'string' ? defs[field] : inferType(value),
      connected: Array.isArray(value),
    }));
    candidates.push({ nodeId, classType, title: String((node as any)._meta?.title ?? classType), fields });
  }
  return candidates;
}

export function validateWorkflowOutputMappings(spec: WorkflowSpec, prompt: Record<string, any>): void {
  for (const output of spec.outputs.filter(item => !item.hidden)) {
    if (!prompt[output.nodeId]) throw new Error(`输出映射 ${output.id} 指向的节点不在提交图中：${output.nodeId}`);
  }
}

function llmSpec(spec: WorkflowSpec): Record<string, any> {
  const inputs = spec.inputs.filter(item => !item.hidden).map(({ nodeId: _nodeId, field: _field, classType: _classType, primary: _primary, defaultValue, ...item }) => ({
    ...item,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  }));
  const params = spec.params.filter(item => !item.hidden && item.llm !== false).map(({ nodeId: _nodeId, field: _field, applyTo: _applyTo, multiple, strengthable, options, llm: _llm, ...item }) => ({
    ...item,
    ...(multiple !== undefined ? { multiple } : {}),
    ...(strengthable !== undefined ? { strengthable } : {}),
    ...(options?.length ? { options: options.slice(0, 32) } : {}),
  }));
  const outputs = spec.outputs.filter(item => !item.hidden).map(({ nodeId: _nodeId, classType: _classType, ...item }) => item);
  return { id: spec.id, name: spec.name, description: spec.description, inputs, params, outputs };
}

export function serializeWorkflowForLlm(spec: WorkflowSpec): Record<string, any> {
  return llmSpec(spec);
}

/**
 * workflow.list 的紧凑摘要：保留选择工作流所需的 id/名称/用途/输入输出类型/可调参数名，
 * 以及每个映射的 description（用户为 LLM 填写的用途说明，类似 skill 的 description）。
 * 不含 default/min/max/step/options 等细节，避免 Agent 上下文被 JSON 细节淹没、误把原始 JSON 回贴给用户。
 */
export function summarizeWorkflowsForLlm(specs: WorkflowSpec[]): Record<string, any>[] {
  return specs.map(spec => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    inputs: (spec.inputs ?? []).filter(item => !item.hidden).map(item => ({
      kind: item.kind,
      label: item.label,
      ...(item.description?.trim() ? { description: item.description } : {}),
    })),
    outputs: (spec.outputs ?? []).filter(item => !item.hidden).map(item => ({
      kind: item.kind,
      label: item.label,
      ...(item.description?.trim() ? { description: item.description } : {}),
    })),
    params: (spec.params ?? []).filter(item => !item.hidden && item.llm !== false).map(item => ({
      id: item.id,
      label: item.label,
      type: item.type,
      ...(item.description?.trim() ? { description: item.description } : {}),
    })),
  }));
}

function currentSource(options: WorkflowPluginApiOptions, id: string): WorkflowCatalogSource | undefined {
  return listCatalogSources(options.catalog).find(source => source.id === id);
}

async function pluginList(options: WorkflowPluginApiOptions): Promise<Record<string, any>[]> {
  const specs = await buildCatalogSpecs(options.catalog);
  const sources = listCatalogSources(options.catalog);
  const specById = new Map(specs.map(spec => [spec.id, spec]));
  return sources.map(source => {
    const spec = specById.get(source.id);
    const read = readManifest(options.catalog.manifestDir, source.id);
    return {
      ...(spec ?? { id: source.id, name: source.id, inputs: [], params: [], outputs: [] }),
      source: source.source,
      hasManifest: read.status === 'valid',
      editable: true,
      enabled: options.isWorkflowEnabled?.(source.id) ?? true,
      available: source.source.type === 'bundled' || read.status === 'valid',
      ...(read.status === 'invalid' ? { manifestError: read.error } : {}),
    };
  });
}

export function createWorkflowPluginRouter(options: WorkflowPluginApiOptions): (req: Request, res: Response, next: () => void) => void {
  const skillsDir = options.skillsDir ?? PLUGIN_SKILLS_DIR;
  const skillSpec = async (id: string): Promise<WorkflowSpec | null> =>
    (await buildCatalogSpecs(options.catalog)).find(spec => spec.id === id) ?? null;
  return async (req, res, next) => {
    try {
      if (req.method === 'POST' && req.path === '/api/plugins/import') {
        const body = req.body ?? {};
        const raw = validateWorkflowJson(body.workflow);
        const filename = typeof body.filename === 'string' ? body.filename : '';
        const id = safeSlug(filename || String(body.name || 'workflow'));
        const existing = currentSource(options, id);
        if (existing && (!body.overwrite || existing.source.type === 'bundled')) {
          jsonError(res, 409, `工作流插件已存在：${id}`);
          return;
        }
        const source = { id, source: { type: 'imported' as const, workflowFile: `workflows/${id}.json` }, json: raw };
        const oi = await objectInfoOf(options);
        const detected = await introspectWorkflow(raw, oi);
        const manifest: WorkflowManifestRecord = {
          ...detected,
          // 导入只创建输入/输出契约；参数由节点视图显式勾选，避免表单默认暴露全部自动识别参数。
          params: [],
          id,
          name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : detected.name || id,
          description: detected.description,
          source: source.source,
          hasManifest: true,
          editable: true,
        };
        const validationError = await validateWorkflowManifest(manifest, raw, oi);
        if (validationError) {
          jsonError(res, 400, validationError);
          return;
        }
        writeWorkflowJson(options.dataRoot, id, raw);
        writeManifest(options.catalog.manifestDir, manifest);
        try {
          syncPluginSkill(manifest, skillsDir);
          syncPluginResponseProtocol(manifest, skillsDir);
        } catch (error) {
          console.error(`[workflow-skill] 生成 ${id} 失败:`, error);
        }
        options.invalidate();
        res.json({ ok: true, plugin: { ...manifest, enabled: options.isWorkflowEnabled?.(id) ?? true, available: true } });
        return;
      }

      const responseMatch = req.path.match(/^\/api\/plugins\/([^/]+)\/response(?:\/(regenerate))?$/);
      if (responseMatch) {
        const id = decodeURIComponent(responseMatch[1]!);
        const spec = await skillSpec(id);
        if (!spec) {
          jsonError(res, 404, `未找到工作流插件：${id}`);
          return;
        }
        if (req.method === 'GET') {
          const protocol = resolvePluginResponseProtocol(id, spec, skillsDir);
          res.json({ ok: true, protocol });
          return;
        }
        if (req.method === 'PUT' && !responseMatch[2]) {
          const protocol = req.body?.protocol as unknown;
          const errors = validatePluginResponseProtocol(protocol, spec);
          if (errors.length > 0) {
            jsonError(res, 400, errors.join('；'));
            return;
          }
          writePluginResponseProtocol(id, protocol as PluginResponseProtocol, skillsDir);
          res.json({ ok: true, protocol });
          return;
        }
        if (req.method === 'POST' && responseMatch[2] === 'regenerate') {
          const protocol = defaultPluginResponseProtocol();
          writePluginResponseProtocol(id, protocol, skillsDir);
          res.json({ ok: true, protocol });
          return;
        }
      }

      const skillMatch = req.path.match(/^\/api\/plugins\/([^/]+)\/skill(?:\/(regenerate|generate|chat))?$/);
      if (skillMatch) {
        const id = decodeURIComponent(skillMatch[1]!);
        const spec = await skillSpec(id);
        if (!spec) {
          jsonError(res, 404, `未找到工作流插件：${id}`);
          return;
        }
        if (req.method === 'GET') {
          const existing = readPluginSkill(id, skillsDir);
          if (existing) {
            res.type('text/markdown').send(existing);
          } else {
            const content = writePluginSkill(spec, skillsDir);
            res.type('text/markdown').send(content);
          }
          return;
        }
        if (req.method === 'PUT') {
          const content = req.body?.content;
          if (typeof content !== 'string' || !content.trim()) {
            jsonError(res, 400, 'content 必须是非空字符串');
            return;
          }
          writeCustomSkill(id, content, skillsDir);
          res.json({ ok: true });
          return;
        }
        if (req.method === 'POST' && req.path.endsWith('/skill/regenerate')) {
          writePluginSkill(spec, skillsDir);
          res.json({ ok: true });
          return;
        }
        if (req.method === 'POST' && req.path.endsWith('/skill/generate')) {
          if (!options.generateSkill) {
            res.status(501).json({ ok: false, error: '未配置 plugin-skill-creator 生成器' });
            return;
          }
          const content = await options.generateSkill(spec);
          writeCustomSkill(id, content, skillsDir);
          res.json({ ok: true, content });
          return;
        }
        if (req.method === 'POST' && req.path.endsWith('/skill/chat')) {
          if (!options.chatSkill) {
            res.status(501).json({ ok: false, error: '未配置 Skill 对话生成器' });
            return;
          }
          const userMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
          if (!userMessage) {
            jsonError(res, 400, 'message 必须是非空字符串');
            return;
          }
          const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
          const history: PluginSkillChatMessage[] = rawHistory
            .filter((item: unknown): item is { role: string; content: string } => {
              if (!item || typeof item !== 'object') return false;
              const value = item as { role?: unknown; content?: unknown };
              return (value.role === 'user' || value.role === 'assistant')
                && typeof value.content === 'string'
                && value.content.trim().length > 0;
            })
            .slice(-20)
            .map((item: { role: string; content: string }) => ({ role: item.role as 'user' | 'assistant', content: item.content.slice(0, 12_000) }));
          const suppliedSkill = typeof req.body?.currentSkill === 'string' ? req.body.currentSkill : '';
          const currentSkill = suppliedSkill.trim()
            ? suppliedSkill.slice(0, 100_000)
            : readPluginSkill(id, skillsDir) ?? generatePluginSkill(spec);
          const result = await options.chatSkill(spec, currentSkill, history, userMessage);
          res.json({ ok: true, reply: result.reply, skill: result.skill });
          return;
        }
      }

      const match = req.path.match(/^\/api\/plugins\/([^/]+)(?:\/(nodes|graph|redetect))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        const action = match[2];
        const source = currentSource(options, id);
        if (!source) {
          jsonError(res, 404, `未找到工作流插件：${id}`);
          return;
        }
        if (req.method === 'GET' && action === 'nodes') {
          res.json({ nodes: await nodeCandidates(options, source) });
          return;
        }
        if (req.method === 'GET' && action === 'graph') {
          const manifestRead = readManifest(options.catalog.manifestDir, id);
          const objectInfoData = await objectInfoOf(options);
          const manifest = manifestRead.status === 'valid'
            ? manifestRead.manifest
            : { params: [] };
          const graph = buildWorkflowGraph(source.json, objectInfoData, manifest);
          if (manifestRead.status === 'invalid') graph.manifestError = manifestRead.error;
          res.json({ graph });
          return;
        }
        if (req.method === 'POST' && action === 'redetect') {
          const read = readManifest(options.catalog.manifestDir, id);
          const current = read.status === 'valid' ? read.manifest : await introspectWorkflow(source.json, await objectInfoOf(options));
          const detected = await introspectWorkflow(source.json, await objectInfoOf(options));
          res.json(await mergeRedetectedSpec(current, detected));
          return;
        }
        if (req.method === 'PUT' && !action) {
          const manifest = req.body as WorkflowManifestRecord;
          if (!manifest || manifest.id !== id) {
            jsonError(res, 400, 'manifest.id 必须与 URL 中的工作流 ID 一致');
            return;
          }
          const previous = readManifest(options.catalog.manifestDir, id);
          const previousSpec = previous.status === 'valid'
            ? previous.manifest
            : await introspectWorkflow(source.json, await objectInfoOf(options));
          const structureError = validateManifestStructure(previousSpec, manifest);
          if (structureError) {
            jsonError(res, 400, structureError);
            return;
          }
          const objectInfoData = await objectInfoOf(options);
          const graph = buildWorkflowGraph(source.json, objectInfoData, previousSpec);
          const paramError = validateParamMappings(manifest, graph);
          if (paramError) {
            jsonError(res, 400, paramError);
            return;
          }
          const error = await validateWorkflowManifest(manifest, source.json, objectInfoData);
          if (error) {
            jsonError(res, 400, error);
            return;
          }
          const normalized = { ...manifest, source: sourceFor(source), hasManifest: true, editable: true };
          writeManifest(options.catalog.manifestDir, normalized);
          try {
            const spec = await skillSpec(id);
            if (spec) {
              syncPluginSkill(spec, skillsDir);
              syncPluginResponseProtocol(spec, skillsDir);
            }
          } catch (error) {
            console.error(`[workflow-skill] 重新生成 ${id} 失败:`, error);
          }
          options.invalidate();
          res.json({ ok: true, plugin: normalized });
          return;
        }
        if (req.method === 'DELETE' && !action) {
          if (source.source.type === 'imported') {
            deleteImportedWorkflow(options.dataRoot, id);
          }
          deleteManifest(options.catalog.manifestDir, id);
          try {
            deletePluginSkill(id, skillsDir);
            deletePluginResponseProtocol(id, skillsDir);
          } catch (error) {
            console.error(`[workflow-skill] 删除 ${id} skill 失败:`, error);
          }
          options.invalidate();
          res.json({ ok: true });
          return;
        }
      }

      if (req.method === 'GET' && req.path === '/api/plugins') {
        res.json(await pluginList(options));
        return;
      }
      if (req.method === 'GET' && req.path === '/api/workflows') {
        const specs = await buildCatalogSpecs(options.catalog);
        res.json(specs
          .filter(spec => options.isWorkflowEnabled?.(spec.id) ?? true)
          .map(spec => ({ ...spec, enabled: true })));
        return;
      }
      next();
    } catch (error) {
      jsonError(res, 400, (error as Error).message);
    }
  };
}
