/**
 * 通用 workflow 运行器核心：对任意 workflow 做 introspection，
 * 自动识别「输入」（文字/图像/视频）、「参数」（INT/FLOAT/BOOLEAN/SEED）与
 * 「输出」（图像/视频/文本），让前后端无需写死任何 workflow 结构。
 *
 * 支持两种格式：
 * - API 格式（workflow_api.json）：{ "3": { class_type, inputs } }
 * - UI 格式（LiteGraph，官方 workflow_templates 仓库即此格式）：
 *   { nodes: [{ id, type, widgets_values, inputs: [{name, link}] }], links }
 *   UI 格式在运行时用 /object_info 转成 API 格式（widget 值按节点输入定义顺序映射），
 *   新式模板（templates/ 下）的 `definitions.subgraphs` 子图实例会在转换前自动展开。
 *
 * 原理：
 * - /object_info 返回每个 class_type 的输入定义与类型
 * - 输入节点识别：CLIPTextEncode → 文字；LoadImage → 图像；LoadVideo → 视频；
 *   自定义节点上的 prompt 类 STRING 字段 → 文字
 * - 输出节点识别：SaveImage/PreviewImage → 图像，VHS_VideoCombine/SaveVideo → 视频，ShowText/SaveText → 文本
 * - 实际结果提取以 /history 的输出键（images/gifs/videos/text）为准，最权威
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getObjectInfo, fileExists, ComfyUIError } from './comfyui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOWS_DIR = path.resolve(__dirname, '../workflows');

/* ---------- 节点类名 → 输入/输出 kind 映射（稳定节点集合） ---------- */

const TEXT_INPUT_CLASSES = /^CLIPTextEncode/; // CLIPTextEncode / CLIPTextEncodeSDXL / CLIPTextEncodeFlux 等
const IMAGE_INPUT_CLASSES = new Set(['LoadImage', 'LoadImageMask', 'LoadImageSequence']);
const VIDEO_INPUT_CLASSES = new Set(['LoadVideo', 'VHS_VideoUpload', 'LoadVideoPath']);
const IMAGE_OUTPUT_CLASSES = new Set([
  'SaveImage',
  'PreviewImage',
  'SaveImageWebsocket',
  'SaveAnimatedPNG',
  'SaveAnimatedWEBP',
]);
const VIDEO_OUTPUT_CLASSES = new Set(['VHS_VideoCombine', 'SaveVideo', 'SaveAnimatedWEBP']);
const TEXT_OUTPUT_CLASSES = new Set(['ShowText', 'SaveText', 'PreviewText', 'TextOutputNode']);
/** UI 格式转换时跳过的节点（纯 UI 元素） */
const SKIP_NODE_TYPES = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode', 'Comment']);
/** 文件名类 combo（ckpt_name/vae_name/lora_name...），不作为参数暴露 */
const FILE_COMBO_FIELDS = new Set(['ckpt_name', 'vae_name', 'lora_name', 'unet_name', 'clip_name', 'control_net_name', 'audio_name']);

/** 常用参数节点的字段白名单 */
const PARAM_FIELDS: Record<string, string[]> = {
  KSampler: ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'],
  KSamplerAdvanced: ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  RandomNumberGenerator: ['seed'],
  NoiseRandomSeed: ['seed'],
};

/** object_info 不可用时的组合框兜底选项 */
const COMBO_HINTS: Record<string, string[]> = {
  sampler_name: ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc', 'lcm'],
  scheduler: ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'],
};

const PARAM_LABELS: Record<string, string> = {
  seed: '随机种子',
  steps: '步数',
  cfg: 'CFG',
  denoise: '重绘幅度',
  width: '宽度',
  height: '高度',
  batch_size: '批量',
  sampler_name: '采样器',
  scheduler: '调度器',
};

/* ---------- 类型定义 ---------- */

export interface WorkflowInput {
  id: string; // 'text-6'
  kind: 'text' | 'image' | 'video';
  label: string; // 提示词 / 参考图 / 输入视频
  nodeId: string;
  field: string; // 节点上的输入字段名
  classType: string;
  /** 当前 workflow 文件里该字段的默认值（注入前的占位） */
  defaultValue?: string;
  /** 是否必须由用户提供（素材缺失或工作流强依赖） */
  required?: boolean;
}

export interface WorkflowParam {
  id: string; // 'seed-3'
  label: string;
  nodeId: string;
  field: string;
  type: 'INT' | 'FLOAT' | 'BOOLEAN' | 'SEED' | 'STRING' | 'combo';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface WorkflowOutput {
  id: string; // 'images-9'
  kind: 'image' | 'video' | 'text';
  label: string;
  nodeId: string;
  classType: string;
}

export interface WorkflowSpec {
  id: string; // 文件名（去 .json）
  name: string;
  description?: string;
  /** 输入：需要前端收集（文字/上传素材） */
  inputs: WorkflowInput[];
  /** 参数：前端动态生成控件 */
  params: WorkflowParam[];
  /** 输出：前端据此渲染结果卡片 */
  outputs: WorkflowOutput[];
}

/* ---------- introspection ---------- */

const objectInfoCache: { at: number; data: Record<string, any> | null } = { at: 0, data: null };

async function objectInfo(): Promise<Record<string, any>> {
  if (objectInfoCache.data && Date.now() - objectInfoCache.at < 5 * 60_000) return objectInfoCache.data;
  const data = await getObjectInfo();
  objectInfoCache.at = Date.now();
  objectInfoCache.data = data;
  return data;
}

function labelOf(field: string): string {
  return PARAM_LABELS[field] ?? field;
}

/* ---------- UI 格式 → API 格式转换 ---------- */

export function isUiFormat(json: Record<string, any>): boolean {
  return Array.isArray(json?.nodes) && !('class_type' in json);
}

interface UiLink {
  originId: number;
  originSlot: number;
}

/** seed 类字段的 control_after_generate 额外值（widgets_values 里夹在字段中间，非 schema 字段） */
const CONTROL_SET = new Set(['randomize', 'fixed', 'increment', 'decrement']);

function widgetTypeOf(def: any): string | null {
  if (Array.isArray(def)) {
    const t = def[0];
    if (Array.isArray(t)) return 'COMBO'; // 老式 combo
    return typeof t === 'string' ? t : null;
  }
  if (def && typeof def === 'object' && typeof def.type === 'string') return def.type;
  return null;
}

function isWidgetType(def: any): boolean {
  const t = widgetTypeOf(def);
  if (!t) return false;
  return ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'SEED'].includes(t) || t.includes('COMBO');
}

/** 动态 combo（选项内嵌 inputs 的 schema） */
function dynamicComboOption(def: any, value: unknown): any | null {
  if (!Array.isArray(def) || typeof def[0] !== 'string') return null;
  const options = (def[1] as any)?.options;
  if (!Array.isArray(options) || !options.some((o: any) => o?.inputs)) return null;
  const key = String(value ?? (def[1] as any)?.default ?? options[0]?.key ?? '');
  return options.find((o: any) => String(o.key) === key) ?? options[0] ?? null;
}

/** 去掉 widget 组前缀（如 "model.style_reference" → "style_reference"） */
function normalizeField(name: string): string {
  return name.split('.').pop() ?? name;
}

/**
 * 把 UI 格式（官方 workflow_templates 的 LiteGraph JSON）转成 API 格式。
 * - 先展开 `definitions.subgraphs` 子图实例（新式官方模板，如 MiniMax H3 本地版）：
 *   实例节点（type 为子图 UUID）被替换为子图内部节点（id 重映射为 `${instId}_sg${id}`），
 *   子图输入槽位按名称解析：外部 link → 转发到消费节点；实例 widget 值 → 直接注入；
 *   实例输出重定向到子图内部真正的产出节点。
 * - link 输入：inputs[name] = [originId, originSlot]
 * - widget 值：按 /object_info 的输入定义顺序（required+optional）映射到字段；
 *   已由 link/上游值提供的 widget 字段会跳过其对应位置的 widget 值；
 *   动态 combo（COMFY_DYNAMICCOMBO_V3）的值后面跟着其选中选项的嵌套输入
 *   （点号名，如 model.prompt / model.aspect_ratio），递归展平；
 *   seed 的 control_after_generate 额外值（randomize/fixed/...）自动跳过；
 *   BOOLEAN 字符串（'True'/'False'）转为布尔。
 */

/** 展开全部子图实例，返回扁平化后的 nodes + links（主格式 link 数组） */
function expandSubgraphs(json: Record<string, any>): { nodes: any[]; links: any[] } {
  const defs = (json.definitions?.subgraphs ?? []) as any[];
  if (!defs.length) return { nodes: json.nodes ?? [], links: json.links ?? [] };
  const defById = new Map(defs.map(d => [d.id, d]));

  let nodes: any[] = (json.nodes ?? []).map((n: any) => ({ ...n }));
  let links: any[] = (json.links ?? []).map((l: any) => [...l]);
  let nextLinkId = links.reduce((m: number, l: any) => Math.max(m, Number(l[0]) || 0), 0) + 1;

  let guard = 0;
  while (guard++ < 10) {
    const inst = nodes.find(n => defById.has(n.type));
    if (!inst) break;
    const def = defById.get(inst.type)!;

    // 子图内部节点 id → 唯一新 id（实例 id 前缀，避免与主图冲突）
    const idMap = new Map<number, string>();
    for (const dn of def.nodes ?? []) idMap.set(dn.id, `${inst.id}_sg${dn.id}`);

    const instInputs = inst.inputs ?? [];
    const extIn = links.filter(l => l[3] === inst.id); // 指向实例的外链
    const extOut = links.filter(l => l[1] === inst.id); // 从实例出发的外链

    // 解析每个子图输入槽位：实例输入有外链 → 转发；否则取实例 widget 值（named 优先）
    const sgiFeed = new Map<number, { kind: 'ext'; link: any } | { kind: 'value'; value: unknown }>();
    for (const [slot, si] of (def.inputs ?? []).entries()) {
      const idx = (instInputs as any[]).findIndex((i: any) => i.name === si.name);
      const instIn = idx >= 0 ? instInputs[idx] : null;
      if (instIn?.link != null) {
        const ext = extIn.find((e: any) => e[0] === instIn.link);
        if (ext) {
          sgiFeed.set(slot, { kind: 'ext', link: ext });
          continue;
        }
      }
      // 优先取 widgets_values_named（官方模板按子图输入名给出全部值）；
      // 仅当 named 缺失（旧模板）才用 widgets_values 位置回退。
      const namedMap = inst.widgets_values_named;
      const value =
        namedMap && typeof namedMap === 'object'
          ? namedMap[si.name]
          : instIn
            ? inst.widgets_values?.[idx]
            : undefined;
      sgiFeed.set(slot, { kind: 'value', value });
    }

    // 子图输出槽位 ← 真正产出它的子图内部节点（def 内指向 outputNode 的链路）
    const outFeed = new Map<number, { originId: string; originSlot: number }>();
    for (const dl of def.links ?? []) {
      if (dl.target_id === def.outputNode?.id) {
        outFeed.set(dl.target_slot, {
          originId: idMap.get(dl.origin_id) ?? String(dl.origin_id),
          originSlot: dl.origin_slot,
        });
      }
    }

    const newNodes: any[] = [];
    const newLinks: any[] = [];
    const keepLinks = links.filter(l => l[3] !== inst.id && l[1] !== inst.id);

    for (const dn of def.nodes ?? []) {
      if (!dn || typeof dn !== 'object') continue;
      if (SKIP_NODE_TYPES.has(dn.type)) continue;
      if (dn.mode === 2 || dn.mode === 4) continue; // bypass / mute
      const mappedId = idMap.get(dn.id)!;
      const inputs = (dn.inputs ?? []).map((inp: any) => ({ ...inp }));

      for (const dl of def.links ?? []) {
        if (dl.target_id !== dn.id) continue;
        const inp = inputs.find((i: any) => i.link === dl.id);
        if (!inp) continue;
        if (dl.origin_id === def.inputNode?.id) {
          // 子图输入槽位 → 实例外链转发 / 实例 widget 值注入
          const feed = sgiFeed.get(dl.origin_slot);
          if (feed?.kind === 'ext') {
            const lid = nextLinkId++;
            newLinks.push([lid, feed.link[1], feed.link[2], mappedId, 0, feed.link[5] ?? '']);
            inp.link = lid;
          } else if (feed?.kind === 'value' && feed.value !== undefined) {
            inp.link = null;
            inp._resolved = feed.value;
          }
        } else if (dl.origin_id !== def.outputNode?.id) {
          // 子图内部节点间连线
          const lid = nextLinkId++;
          newLinks.push([lid, idMap.get(dl.origin_id) ?? String(dl.origin_id), dl.origin_slot, mappedId, 0, dl.type ?? '']);
          inp.link = lid;
        }
      }
      newNodes.push({ ...dn, id: mappedId, inputs });
    }

    // 实例输出重定向到子图内部产出节点
    for (const l of extOut) {
      const feed = outFeed.get(l[2]);
      if (feed) keepLinks.push([l[0], feed.originId, feed.originSlot, l[3], l[4], l[5]]);
    }

    nodes = [...nodes.filter(n => n.id !== inst.id), ...newNodes];
    links = [...keepLinks, ...newLinks];
  }
  return { nodes, links };
}

/** 单个 UI 节点 → API 节点；返回 null 表示跳过 */
function convertUiNode(
  node: any,
  linksMap: Map<number, UiLink>,
  objectInfoData: Record<string, any>,
): { class_type: string; inputs: Record<string, unknown>; _meta: { title: string } } | null {
  const inputs: Record<string, unknown> = {};
  const connected = new Set<string>();

  for (const inp of node.inputs ?? []) {
    if (inp.link != null) {
      const link = linksMap.get(inp.link);
      if (!link) continue;
      inputs[inp.name] = [String(link.originId), link.originSlot];
      connected.add(inp.name);
      connected.add(normalizeField(inp.name));
    } else if (inp._resolved !== undefined) {
      // 子图展开注入的上游值
      inputs[inp.name] = inp._resolved;
      connected.add(inp.name);
      connected.add(normalizeField(inp.name));
    }
  }

  const widgets = Array.isArray(node.widgets_values) ? (node.widgets_values as unknown[]) : [];
  const info = objectInfoData?.[node.type]?.input;
  let wi = 0;
  let lastField = '';

  const visit = (required: Record<string, unknown> | undefined, optional: Record<string, unknown> | undefined, prefix: string) => {
    for (const field of [...Object.keys(required ?? {}), ...Object.keys(optional ?? {})]) {
      const full = prefix ? `${prefix}.${field}` : field;
      const def = required?.[field] ?? optional?.[field];
      if (connected.has(full) || connected.has(normalizeField(full))) {
        // 已由 link/上游值提供且属于 widget 类型的字段：跳过其对应位置的 widget 值
        if (def && isWidgetType(def)) wi++;
        continue;
      }
      if (!isWidgetType(def)) continue; // link-only 类型没有 widget 值
      // 跳过 seed 的 control_after_generate 额外值
      if (lastField === 'seed' && wi < widgets.length && CONTROL_SET.has(String(widgets[wi]))) wi++;
      if (wi >= widgets.length) break;
      let value = widgets[wi];
      wi++;
      const wtype = widgetTypeOf(def);
      // BOOLEAN 字符串转布尔；INT/FLOAT 字符串转数字
      if (wtype === 'BOOLEAN' && (value === 'True' || value === 'False')) value = value === 'True';
      if ((wtype === 'INT' || wtype === 'FLOAT') && typeof value === 'string' && value.trim() !== '') value = Number(value);
      inputs[full] = value;
      lastField = normalizeField(full);
      // 动态 combo：展平选中选项的嵌套输入
      const option = dynamicComboOption(def, value);
      if (option?.inputs) visit(option.inputs.required, option.inputs.optional, full);
    }
  };

  if (info) {
    visit(info.required, info.optional, '');
  } else {
    // 无 object_info 兜底：widget 值按序给到未连接的输入
    const fields = (node.inputs ?? []).filter((i: any) => i.link == null).map((i: any) => i.name);
    for (const f of fields) {
      if (wi >= widgets.length) break;
      const norm = normalizeField(f);
      if (!connected.has(norm)) {
        inputs[norm] = widgets[wi];
        wi++;
      }
    }
  }

  return { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } };
}

export function convertUiToApi(json: Record<string, any>, objectInfoData: Record<string, any>): Record<string, any> {
  const { nodes, links } = expandSubgraphs(json);
  const linksMap = new Map<number, UiLink>();
  for (const l of links) {
    if (Array.isArray(l) && l.length >= 3) linksMap.set(l[0] as number, { originId: l[1] as number, originSlot: l[2] as number });
  }

  const out: Record<string, any> = {};
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (SKIP_NODE_TYPES.has(node.type)) continue;
    if (node.mode === 2 || node.mode === 4) continue; // bypass / mute
    const converted = convertUiNode(node, linksMap, objectInfoData);
    if (converted) out[String(node.id)] = converted;
  }
  return out;
}

/* ---------- 通用文本输入识别（自定义节点上的 prompt 类字段） ---------- */

/** 自定义节点上像 prompt 的 STRING 字段（含 model.prompt 这类嵌套名） */
function genericTextInputFields(
  cls: string,
  nodeInputs: Record<string, unknown>,
): { field: string; value: string }[] {
  if (TEXT_INPUT_CLASSES.test(cls)) return []; // CLIPTextEncode 走专用路径
  const fields: { field: string; value: string }[] = [];
  for (const field of Object.keys(nodeInputs)) {
    const base = normalizeField(field); // model.prompt → prompt
    if (/negative|负面|反向/i.test(base)) continue; // 负向提示词不作为输入
    if (!/prompt|描述|提示/i.test(base)) continue;
    if (typeof nodeInputs[field] !== 'string') continue; // 已由转换填充的值
    fields.push({ field, value: nodeInputs[field] as string });
  }
  return fields;
}

/* ---------- introspection ---------- */

export async function introspectWorkflow(json: Record<string, any>, objectInfoData?: Record<string, any>): Promise<WorkflowSpec> {
  const oi = objectInfoData ?? (await objectInfo().catch(() => undefined));
  const apiJson = isUiFormat(json) ? convertUiToApi(json, oi ?? {}) : json;

  const inputs: WorkflowInput[] = [];
  const params: WorkflowParam[] = [];
  const outputs: WorkflowOutput[] = [];

  for (const [nodeId, node] of Object.entries(apiJson)) {
    if (!node || typeof node !== 'object') continue;
    const { class_type: cls, inputs: nodeInputs, _meta } = node as {
      class_type?: string;
      inputs?: Record<string, unknown>;
      _meta?: { title?: string };
    };
    if (!cls || !nodeInputs) continue;
    const info = oi?.[cls]?.input;

    // 文字输入
    if (TEXT_INPUT_CLASSES.test(cls)) {
      inputs.push({
        id: `text-${nodeId}`,
        kind: 'text',
        label: '提示词',
        nodeId,
        field: 'text',
        classType: cls,
        defaultValue: typeof nodeInputs.text === 'string' ? nodeInputs.text : '',
      });
      continue;
    }
    // 官方模板常用 PrimitiveString / PrimitiveStringMultiline 承载提示词（经 link 注入到生成节点）
    if (/^PrimitiveString/.test(cls)) {
      inputs.push({
        id: `text-${nodeId}`,
        kind: 'text',
        label: '提示词',
        nodeId,
        field: 'value',
        classType: cls,
        defaultValue: typeof nodeInputs.value === 'string' ? nodeInputs.value : '',
      });
      continue;
    }
    // 图像输入
    if (IMAGE_INPUT_CLASSES.has(cls)) {
      inputs.push({
        id: `image-${nodeId}`,
        kind: 'image',
        label: '参考图',
        nodeId,
        field: 'image',
        classType: cls,
        defaultValue: typeof nodeInputs.image === 'string' ? nodeInputs.image : undefined,
      });
      continue;
    }
    // 视频输入
    if (VIDEO_INPUT_CLASSES.has(cls)) {
      const field = nodeInputs.video !== undefined ? 'video' : nodeInputs.audio !== undefined ? 'audio' : 'video';
      inputs.push({
        id: `video-${nodeId}`,
        kind: 'video',
        label: '输入视频',
        nodeId,
        field,
        classType: cls,
        defaultValue: typeof nodeInputs[field] === 'string' ? (nodeInputs[field] as string) : undefined,
      });
      continue;
    }
    // 输出
    if (IMAGE_OUTPUT_CLASSES.has(cls)) {
      outputs.push({
        id: `images-${nodeId}`,
        kind: 'image',
        label: _meta?.title || '生成图片',
        nodeId,
        classType: cls,
      });
      continue;
    }
    if (VIDEO_OUTPUT_CLASSES.has(cls)) {
      outputs.push({
        id: `videos-${nodeId}`,
        kind: 'video',
        label: _meta?.title || '生成视频',
        nodeId,
        classType: cls,
      });
      continue;
    }
    if (TEXT_OUTPUT_CLASSES.has(cls)) {
      outputs.push({
        id: `texts-${nodeId}`,
        kind: 'text',
        label: _meta?.title || '生成文本',
        nodeId,
        classType: cls,
      });
      continue;
    }

    // 自定义节点上的 prompt 类文字输入
    const genericTexts = genericTextInputFields(cls, nodeInputs);
    for (const { field, value } of genericTexts) {
      inputs.push({
        id: `text-${nodeId}-${field}`,
        kind: 'text',
        label: field === 'prompt' ? '提示词' : field,
        nodeId,
        field,
        classType: cls,
        defaultValue: value,
      });
    }
    const textFields = new Set(genericTexts.map(t => t.field));

    // 参数：白名单字段 + SEED 类型字段 + 名为 seed 的字段
    const allowlist = PARAM_FIELDS[cls];
    const required = (info?.required ?? {}) as Record<string, unknown>;
    const optional = (info?.optional ?? {}) as Record<string, unknown>;

    for (const field of Object.keys(nodeInputs)) {
      if (textFields.has(field)) continue; // 已是文字输入，不再作为参数
      const isAllowed = allowlist?.includes(field);
      const def = (required[field] ?? optional[field]) as any;
      const isSeedType = Array.isArray(def) ? def[0] === 'SEED' : def?.type === 'SEED';
      if (!isAllowed && !isSeedType && field !== 'seed') continue;
      if (FILE_COMBO_FIELDS.has(field)) continue;
      if (typeof nodeInputs[field] === 'object') continue; // 连到其他节点的输入，跳过

      let type: WorkflowParam['type'] = 'INT';
      let options: string[] | undefined;
      let min: number | undefined;
      let max: number | undefined;
      let step: number | undefined;
      let defVal: unknown = nodeInputs[field];

      if (Array.isArray(def)) {
        // 形如 ["STRING", {...}] 或 [["a","b"], {...}] 或 ["INT", {...}]
        const [t, opts] = def as [unknown, any];
        if (Array.isArray(t)) {
          type = 'combo';
          options = t as string[];
          defVal = nodeInputs[field] ?? opts?.default ?? t[0];
        } else {
          type = t as WorkflowParam['type'];
          defVal = nodeInputs[field] ?? opts?.default ?? 0;
          min = opts?.min;
          max = opts?.max;
          step = opts?.step;
        }
      } else if (def && typeof def === 'object') {
        type = (def.type as WorkflowParam['type']) ?? 'INT';
        defVal = nodeInputs[field] ?? def.default ?? 0;
        min = def.min;
        max = def.max;
        step = def.step;
      } else {
        // object_info 不可用（ComfyUI 未连接）或字段未收录 → 从值推断
        const v = nodeInputs[field];
        const comboHint = COMBO_HINTS[field];
        if (comboHint) {
          type = 'combo';
          options = comboHint;
          defVal = v ?? comboHint[0];
        } else if (typeof v === 'number') {
          type = Number.isInteger(v) ? 'INT' : 'FLOAT';
          defVal = v;
        } else if (typeof v === 'boolean') {
          type = 'BOOLEAN';
          defVal = v;
        } else {
          type = 'STRING';
          defVal = v ?? '';
        }
      }
      if (type === 'SEED') {
        defVal = (nodeInputs[field] as { seed?: unknown })?.seed ?? defVal;
      }

      params.push({
        id: `${field}-${nodeId}`,
        label: labelOf(field),
        nodeId,
        field,
        type: type === 'SEED' ? 'INT' : type,
        default: typeof defVal === 'number' ? defVal : defVal,
        min,
        max,
        step,
        options,
      });
    }
  }

  return {
    id: '',
    name: '',
    inputs,
    params,
    outputs,
  };
}

/* ---------- workflow 文件加载 ---------- */

export interface WorkflowFile {
  id: string;
  name: string;
  description?: string;
  json: Record<string, any>;
}

export function loadWorkflowFiles(): WorkflowFile[] {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const raw = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')) as Record<string, any>;
      const meta = (raw._meta ?? {}) as { name?: string; description?: string };
      return {
        id: f.replace(/\.json$/, ''),
        name: meta.name || f.replace(/\.json$/, ''),
        description: meta.description,
        json: raw,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/* ---------- 素材文件探测 ---------- */

const fileProbeCache = new Map<string, { at: number; exists: boolean }>();

/**
 * 探测 ComfyUI input 目录里是否存在素材文件。
 * 模板里 LoadImage 的占位文件名（如 krea_style_reference_image1.png）在用户机器上
 * 通常不存在 → 标记为必传，前端提示上传。缓存 5 分钟。
 */
async function probeInputFile(filename: string): Promise<boolean> {
  const cached = fileProbeCache.get(filename);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.exists;
  let exists = true;
  try {
    exists = await fileExists(filename, 'input');
  } catch {
    exists = true; // 连不上时不强制上传，按默认值走
  }
  fileProbeCache.set(filename, { at: Date.now(), exists });
  return exists;
}

/** 解析全部 workflow 为 spec */
export async function buildSpecs(): Promise<WorkflowSpec[]> {
  const files = loadWorkflowFiles();
  const oi = await objectInfo().catch(() => undefined);
  const specs: WorkflowSpec[] = [];
  for (const f of files) {
    const spec = await introspectWorkflow(f.json, oi);
    spec.id = f.id;
    spec.name = f.name;
    spec.description = f.description;
    // 探测素材占位文件是否存在，缺失则标记必传
    for (const input of spec.inputs) {
      if (input.kind === 'text') continue;
      const def = input.defaultValue;
      if (!def?.trim()) {
        input.required = true;
        continue;
      }
      const exists = await probeInputFile(def);
      if (!exists) {
        input.required = true;
        input.defaultValue = undefined;
      }
    }
    specs.push(spec);
  }
  return specs;
}

let specsCache: { at: number; specs: WorkflowSpec[] | null } = { at: 0, specs: null };

/** 切换 ComfyUI 实例后清空 introspection / 规格 / 素材探测缓存 */
export function invalidateComfyCaches(): void {
  objectInfoCache.at = 0;
  objectInfoCache.data = null;
  specsCache = { at: 0, specs: null };
  fileProbeCache.clear();
}


/** 带 30s 缓存的 spec 列表（开发期改 workflow 文件 30s 内生效） */
export async function buildSpecsCached(): Promise<WorkflowSpec[]> {
  if (specsCache.specs && Date.now() - specsCache.at < 30_000) return specsCache.specs;
  const specs = await buildSpecs();
  specsCache = { at: Date.now(), specs };
  return specs;
}

export async function getSpec(id: string): Promise<WorkflowSpec | null> {
  const specs = await buildSpecsCached();
  return specs.find(s => s.id === id) ?? null;
}

/** 取 workflow 原始 JSON（构建 prompt 时用） */
export function getWorkflowJson(id: string): Record<string, any> | null {
  const file = loadWorkflowFiles().find(f => f.id === id);
  return file ? file.json : null;
}

/* ---------- prompt 构建（值注入） ---------- */

export interface BuildValues {
  prompt?: string;
  /** image/video 输入 → 已上传到 ComfyUI 的文件名 */
  uploaded?: Record<string, string>; // { [inputId]: filename }
  params?: Record<string, unknown>;
}

/** 从 object_info 里选一个已安装的 checkpoint（ckpt_name 为空时自动探测） */
async function resolveCheckpoints(
  json: Record<string, any>,
  objectInfoData: Record<string, any>,
): Promise<void> {
  const loaderNodes = Object.values(json).filter(
    (n: any) => n?.class_type === 'CheckpointLoaderSimple',
  ) as any[];
  if (!loaderNodes.length) return; // 无 checkpoint 节点 → 无需处理
  const loader = objectInfoData.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const options: string[] = Array.isArray(loader) && Array.isArray(loader[0]) ? loader[0] : [];
  if (!options.length) {
    throw new ComfyUIError('ComfyUI 未检测到任何 checkpoint 模型，请先在 ComfyUI 中安装模型（如 SD1.5/SDXL/Flux）');
  }
  for (const node of loaderNodes) {
    const cur = node.inputs?.ckpt_name;
    if (typeof cur === 'string' && cur && options.includes(cur)) continue;
    node.inputs.ckpt_name = options[0];
  }
}

export async function buildPrompt(
  spec: WorkflowSpec,
  json: Record<string, any>,
  values: BuildValues,
): Promise<Record<string, any>> {
  const oi = await objectInfo().catch(() => undefined);
  // UI 格式模板 → 先转成 API 格式（widget 默认值来自模板本身）
  const prompt = isUiFormat(json)
    ? convertUiToApi(json, oi ?? {})
    : (() => {
        const copy = JSON.parse(JSON.stringify(json)) as Record<string, any>;
        delete copy._meta; // API 格式顶层 _meta 是工作流元信息，不是节点
        return copy;
      })();

  // 文字输入注入
  const textInputs = spec.inputs.filter(i => i.kind === 'text');
  if (textInputs.length > 0) {
    const text = values.prompt?.trim();
    if (!text) throw new ComfyUIError('请输入提示词后再生成');
    // 启发式：优先注入「正面」节点（标题含 positive/prompt/正面 或占位文本较长），跳过明显负面节点
    const scored = textInputs
      .map(i => {
        const node = prompt[i.nodeId];
        const title = (node?._meta?.title ?? '') as string;
        let score = 0;
        if (/negative|负面|负向|反向|neg/i.test(title)) score -= 10;
        else if (/positive|正面|正向|prompt|提示/i.test(title)) score += 3;
        const cur = String(i.defaultValue ?? '');
        if (cur.trim()) score += Math.min(2, cur.length / 30);
        return { input: i, score };
      })
      .sort((a, b) => b.score - a.score);
    const target = scored[0]?.input;
    if (target) prompt[target.nodeId].inputs[target.field] = text;
  }

  // 上传素材注入
  for (const input of spec.inputs) {
    if (input.kind === 'text') continue;
    const filename = values.uploaded?.[input.id];
    if (filename) prompt[input.nodeId].inputs[input.field] = filename;
    // 未上传且非必传 → 保留模板默认文件名；必传但未上传 → 前端已拦截
  }

  // 参数注入
  for (const p of spec.params) {
    const v = values.params?.[p.id];
    if (v === undefined) continue;
    prompt[p.nodeId].inputs[p.field] = v;
  }

  // checkpoint 自动探测（仅当工作流含 checkpoint 节点）
  if (oi) await resolveCheckpoints(prompt, oi);

  return prompt;
}

/** 输入节点是否有强依赖（如 img2img 必须有参考图） */
export function requiredInputKinds(spec: WorkflowSpec): Set<'image' | 'video'> {
  const kinds = new Set<'image' | 'video'>();
  for (const input of spec.inputs) {
    if (input.kind === 'image' && (input.required || !String(input.defaultValue ?? '').trim())) kinds.add('image');
    if (input.kind === 'video' && (input.required || !String(input.defaultValue ?? '').trim())) kinds.add('video');
  }
  return kinds;
}
