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
import type { ImageGenSettings } from './settings.js';
import type { Resolution } from './resolution.js';

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
/** UI 格式转换时跳过的节点（纯 UI 元素，无输入输出、不影响图） */
const SKIP_NODE_TYPES = new Set([
  'MarkdownNote',
  'Note',
  'Reroute',
  'PrimitiveNode',
  'Comment',
  'Bookmark (rgthree)',
  'Label (rgthree)',
]);
/** 文件名类 combo（ckpt_name/vae_name/lora_name...），不作为参数暴露 */
const FILE_COMBO_FIELDS = new Set(['ckpt_name', 'vae_name', 'lora_name', 'unet_name', 'clip_name', 'control_net_name', 'audio_name']);

/** 常用参数节点的字段白名单 */
const PARAM_FIELDS: Record<string, string[]> = {
  KSampler: ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'],
  KSamplerAdvanced: ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler'],
  KSamplerSelect: ['sampler_name'],
  BasicScheduler: ['scheduler', 'steps'],
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
  unet_name: '扩散模型 (Diffusion Model)',
  ckpt_name: '模型 (Checkpoint)',
  clip_name: 'CLIP',
  vae_name: 'VAE',
  lora_name: 'LoRA',
  control_net_name: 'ControlNet',
  audio_name: '音频模型',
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
  /** 与 id 指向节点同字段的其他节点（分阶段采样链的多个 KSampler 等），注入时一并写入 */
  applyTo?: string[];
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

/** seed 类字段：seed/noise_seed 等，其后可能跟着 frontend-only 的 control_after_generate 值 */
function isSeedField(name: string): boolean {
  return name === 'seed' || /seed$/i.test(name);
}

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
    if (inst.mode === 2 || inst.mode === 4) {
      // muted / bypass 的子图实例不参与生成：移除实例及其连线
      nodes = nodes.filter(n => n.id !== inst.id);
      links = links.filter(l => l[3] !== inst.id && l[1] !== inst.id);
      continue;
    }
    const def = defById.get(inst.type)!;

    // 子图内部节点 id → 唯一新 id（实例 id 前缀，避免与主图冲突）
    const idMap = new Map<number, string>();
    for (const dn of def.nodes ?? []) idMap.set(dn.id, `${inst.id}_sg${dn.id}`);

    const instInputs = inst.inputs ?? [];
    const extIn = links.filter(l => l[3] === inst.id); // 指向实例的外链
    const extOut = links.filter(l => l[1] === inst.id); // 从实例出发的外链

    // 构建子图实例 widget 输入到值的映射：
    // 1) 优先使用 widgets_values_named
    // 2) 若 inst.widgets_values 长度与 def.inputs 相同，说明 widgets_values 与 def.inputs 槽位 1:1 对齐
    // 3) 否则若 inst.inputs 中带有 widget 定义，且 widget 数量与 inst.widgets_values 相同，则按 widget 输入槽位顺序映射
    // 4) 否则回退到按 slot 索引映射
    const widgetValueMap = new Map<string, any>();
    if (inst.widgets_values_named && typeof inst.widgets_values_named === 'object') {
      for (const [k, v] of Object.entries(inst.widgets_values_named)) {
        widgetValueMap.set(k, v);
      }
    } else if (Array.isArray(inst.widgets_values)) {
      const defInputs = def.inputs ?? [];
      const widgetInputs = (instInputs as any[]).filter(i => i.widget != null);
      if (inst.widgets_values.length === defInputs.length) {
        defInputs.forEach((si: any, idx: number) => {
          widgetValueMap.set(si.name, inst.widgets_values[idx]);
        });
      } else if (widgetInputs.length === inst.widgets_values.length) {
        widgetInputs.forEach((wi, idx) => {
          widgetValueMap.set(wi.name, inst.widgets_values[idx]);
        });
      } else {
        defInputs.forEach((si: any, idx: number) => {
          widgetValueMap.set(si.name, inst.widgets_values[idx]);
        });
      }
    }

    // 解析每个子图输入槽位：实例输入有外链 → 转发；否则取实例 widget 值
    const sgiFeed = new Map<number, { kind: 'ext'; link: any } | { kind: 'value'; value: unknown }>();
    for (const [slot, si] of (def.inputs ?? []).entries()) {
      const instIn = (instInputs as any[]).find((i: any) => i.name === si.name);
      if (instIn?.link != null) {
        const ext = extIn.find((e: any) => e[0] === instIn.link);
        if (ext) {
          sgiFeed.set(slot, { kind: 'ext', link: ext });
          continue;
        }
      }
      const value = widgetValueMap.has(si.name) ? widgetValueMap.get(si.name) : undefined;
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
        // 已由 link/上游值提供且属于 widget 类型的字段：跳过其对应位置的 widget 值（及可能的 control_after_generate）
        if (def && isWidgetType(def)) {
          wi++;
          if (isSeedField(normalizeField(full)) && wi < widgets.length && CONTROL_SET.has(String(widgets[wi]))) {
            wi++;
          }
        }
        continue;
      }
      if (!isWidgetType(def)) continue; // link-only 类型没有 widget 值
      // 跳过 seed 类字段的 control_after_generate 额外值
      if (isSeedField(lastField) && wi < widgets.length && CONTROL_SET.has(String(widgets[wi]))) wi++;
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

/* ---------- Set/Get 虚拟节点解析 ---------- */

/**
 * Set/Get 是前端虚拟节点（KJNodes / diffus3 SetGet 等，仅有 JS 实现、无 Python 后端类），
 * ComfyUI 界面在排队前会把它们解析成直接连线；服务端转换必须做同样的解析，
 * 否则 API 格式里残留 SetNode/GetNode 会导致 /prompt 报 missing_node_type。
 */
const SET_GET_SET_TYPES = new Set(['SetNode', 'KJNodes.SetNode', 'diffus3.SetNode']);
const SET_GET_GET_TYPES = new Set(['GetNode', 'KJNodes.GetNode', 'diffus3.GetNode']);

/** 取 Set/Get 节点名：Constant widget → widgets_values[0] → previousName → 标题去 Set_/Get_ 前缀 */
function setGetName(node: any): string {
  const named = node.widgets_values_named;
  if (named && typeof named.Constant === 'string' && named.Constant.trim()) return named.Constant.trim();
  const w = Array.isArray(node.widgets_values) ? (node.widgets_values as unknown[]) : [];
  if (typeof w[0] === 'string' && (w[0] as string).trim()) return (w[0] as string).trim();
  const prev = node.properties?.previousName;
  if (typeof prev === 'string' && prev.trim()) return prev.trim();
  return String(node.title ?? '').replace(/^(Set|Get)_?/i, '').trim();
}

/**
 * 把 Set/Get 虚拟节点重写为直接连线：
 * - GetNode 的输出 = 同名 SetNode 输入的真实来源；SetNode 输出 = 其输入透传；
 * - 解析后删除所有 Set/Get 节点，指向它们的连线被吞掉，从它们出发的连线重定向到真实来源；
 * - 找不到同名 Set 的 Get（如 Set 在静音子图中）被丢弃，其输出连线一并移除。
 */
function resolveSetGet(nodes: any[], links: any[]): { nodes: any[]; links: any[] } {
  const linksMap = new Map<number, UiLink>();
  for (const l of links) {
    if (Array.isArray(l) && l.length >= 3) linksMap.set(l[0] as number, { originId: l[1] as number, originSlot: l[2] as number });
  }
  const nodesById = new Map<number, any>(nodes.map(n => [n.id, n]));
  const setByName = new Map<string, number>();
  for (const n of nodes) {
    if (!SET_GET_SET_TYPES.has(n.type)) continue;
    const name = setGetName(n);
    if (name && !setByName.has(name)) setByName.set(name, n.id);
  }

  const resolveCache = new Map<number, UiLink | null>();
  const visiting = new Set<number>();
  const resolveSource = (id: number): UiLink | null => {
    if (resolveCache.has(id)) return resolveCache.get(id)!;
    if (visiting.has(id)) return null; // 循环引用（非法图）
    visiting.add(id);
    let result: UiLink | null = null;
    const node = nodesById.get(id);
    if (node) {
      if (SET_GET_SET_TYPES.has(node.type)) {
        const input = (node.inputs ?? []).find((i: any) => i.link != null);
        const src = input?.link != null ? linksMap.get(input.link) : undefined;
        if (src) result = resolveSource(src.originId) ?? src;
      } else if (SET_GET_GET_TYPES.has(node.type)) {
        const setId = setByName.get(setGetName(node));
        if (setId !== undefined) result = resolveSource(setId);
      }
    }
    visiting.delete(id);
    resolveCache.set(id, result);
    return result;
  };

  const virtualIds = new Set<number>(
    nodes.filter(n => SET_GET_SET_TYPES.has(n.type) || SET_GET_GET_TYPES.has(n.type)).map(n => n.id),
  );

  const newLinks: any[] = [];
  for (const l of links) {
    if (!Array.isArray(l) || l.length < 3) continue;
    const [, originId, originSlot, targetId] = l as [number, number, number, number];
    if (virtualIds.has(targetId)) continue; // 指向 Set/Get 的输入连线被内部吞掉
    let newOriginId = originId;
    let newOriginSlot = originSlot;
    if (virtualIds.has(originId)) {
      const src = resolveSource(originId);
      if (!src) continue; // 无法解析的 Get → 丢弃其输出连线
      newOriginId = src.originId;
      newOriginSlot = src.originSlot;
    }
    newLinks.push([l[0], newOriginId, newOriginSlot, targetId, l[4], l[5]]);
  }

  return {
    nodes: nodes.filter(n => !virtualIds.has(n.id)),
    links: newLinks,
  };
}

export function convertUiToApi(json: Record<string, any>, objectInfoData: Record<string, any>): Record<string, any> {
  // 1. 展开子图实例
  let { nodes, links } = expandSubgraphs(json);
  // 2. 解析 Set/Get 虚拟节点为直接连线（重连后 links 仍保留原 link id）
  ({ nodes, links } = resolveSetGet(nodes, links));
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

/* ---------- 死节点裁剪 ---------- */

/** 类名去掉 pysssss 等自定义节点的 `|命名空间` 后缀 */
function baseClass(cls: string): string {
  return cls.split('|')[0] ?? cls;
}

/** 输出节点类（SaveImage/PreviewImage/ShowText 等，含 | 命名空间形式） */
const OUTPUT_NODE_CLASSES = new Set([
  ...IMAGE_OUTPUT_CLASSES,
  ...VIDEO_OUTPUT_CLASSES,
  ...TEXT_OUTPUT_CLASSES,
]);

/**
 * 裁剪「死节点」：输出不被任何节点消费、且自身不是输出节点的节点（如被停用的备用模型分支）。
 * ComfyUI 只执行从输出节点反向可达的节点，死节点不参与生成，只会污染参数面板、
 * 且若其引用的模型缺失还会导致提交前校验误报。从输出节点沿输入连线反向标记可达节点。
 */
export function pruneDeadNodes(api: Record<string, any>): Record<string, any> {
  const alive = new Set<string>();
  for (const [id, node] of Object.entries(api)) {
    if (node && OUTPUT_NODE_CLASSES.has(baseClass(String(node.class_type ?? '')))) alive.add(id);
  }
  // 从输出节点沿 input 连线（[originId, slot]）反向扩散
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of Object.entries(api)) {
      if (!alive.has(id) || !node || typeof node.inputs !== 'object') continue;
      for (const v of Object.values(node.inputs as Record<string, unknown>)) {
        if (Array.isArray(v) && typeof v[0] === 'string' && !alive.has(v[0])) {
          alive.add(v[0]);
          changed = true;
        }
      }
    }
  }
  const out: Record<string, any> = {};
  for (const [id, node] of Object.entries(api)) {
    if (alive.has(id)) out[id] = node;
  }
  return out;
}

/* ---------- introspection ---------- */

export async function introspectWorkflow(json: Record<string, any>, objectInfoData?: Record<string, any>): Promise<WorkflowSpec> {
  const oi = objectInfoData ?? (await objectInfo().catch(() => undefined));
  const apiJson = pruneDeadNodes(isUiFormat(json) ? convertUiToApi(json, oi ?? {}) : json);

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
      // 忽略 System Prompt 等模板内部系统提示词节点
      const title = String(node._meta?.title || '');
      if (title.toLowerCase().includes('system prompt')) {
        continue;
      }
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

    // 参数：白名单字段 + SEED 类型字段 + 名为 seed 的字段 + 文件类 combo（unet/clip/vae/lora 等）
    const allowlist = PARAM_FIELDS[cls];
    const required = (info?.required ?? {}) as Record<string, unknown>;
    const optional = (info?.optional ?? {}) as Record<string, unknown>;

    for (const field of Object.keys(nodeInputs)) {
      if (textFields.has(field)) continue; // 已是文字输入，不再作为参数
      const isAllowed = allowlist?.includes(field);
      const isFileCombo = FILE_COMBO_FIELDS.has(field);
      const def = (required[field] ?? optional[field]) as any;
      const isSeedType = Array.isArray(def) ? def[0] === 'SEED' : def?.type === 'SEED';
      if (!isAllowed && !isFileCombo && !isSeedType && field !== 'seed') continue;
      if (typeof nodeInputs[field] === 'object') continue; // 连到其他节点的输入，跳过

      let type: WorkflowParam['type'] = 'INT';
      let options: string[] | undefined;
      let min: number | undefined;
      let max: number | undefined;
      let step: number | undefined;
      let defVal: unknown = nodeInputs[field];

      if (Array.isArray(def)) {
        // 形如 ["STRING", {...}] / [["a","b"], {...}] / ["COMBO", {options:[...]}] / ["INT", {...}]
        const [t, opts] = def as [unknown, any];
        if (Array.isArray(t)) {
          type = 'combo';
          options = t as string[];
          defVal = nodeInputs[field] ?? opts?.default ?? t[0];
        } else if (t === 'COMBO' && Array.isArray(opts?.options)) {
          // 新式 combo：选项在第二元素 { options: [...] }
          type = 'combo';
          options = opts.options as string[];
          defVal = nodeInputs[field] ?? opts.default ?? opts.options[0];
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

  // 采样类字段（全局采样设置本就对同名参数逐一写入同一值）：同一字段只保留一个控件，
  // 注入时通过 applyTo 应用到该字段的全部节点（分阶段采样链的多个 KSampler 只显示一组采样器/调度器）。
  // 文件类 combo（unet/clip/vae/lora 等）不去重：工作流里可能存在多个真正不同的加载器。
  const SAMPLING_FIELDS = new Set(['seed', 'noise_seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler']);
  const byField = new Map<string, WorkflowParam>();
  const deduped: WorkflowParam[] = [];
  for (const p of params) {
    const first = SAMPLING_FIELDS.has(p.field) ? byField.get(p.field) : undefined;
    if (!first) {
      byField.set(p.field, p);
      deduped.push(p);
    } else {
      (first.applyTo ??= []).push(p.nodeId);
    }
  }

  return {
    id: '',
    name: '',
    inputs,
    params: deduped,
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

function formatWorkflowName(id: string): string {
  if (id === 'image_krea2_turbo_t2i') return 'Krea2 Turbo 文生图';
  return id;
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
        name: meta.name || formatWorkflowName(f.replace(/\.json$/, '')),
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
  settings?: ImageGenSettings;
  /** 生成比例 + 尺寸算出的目标宽高（null 时不注入，沿用工作流默认） */
  resolution?: Resolution | null;
}

/* ---------- 提交前模型/参数可用性校验 ---------- */

/** 常见自定义节点类 → 提供它的自定义节点包（API 格式工作流没有 properties.aux_id，靠此表补充安装提示） */
const KNOWN_CUSTOM_NODE_PACKAGES: Record<string, string> = {
  SetNode: 'kijai/ComfyUI-KJNodes',
  GetNode: 'kijai/ComfyUI-KJNodes',
  KJNodes_SetNode: 'kijai/ComfyUI-KJNodes',
  KJNodes_GetNode: 'kijai/ComfyUI-KJNodes',
  PathchSageAttentionKJ: 'kijai/ComfyUI-KJNodes',
  ApplyKrea2NegPiP: 'blue-pen5805/ComfyUI-krea2-negpip',
  CLIPLoaderGGUF: 'city96/ComfyUI-GGUF',
  DyPE_FLUX: 'wildminder/ComfyUI-DyPE',
  SEGA: 'wildminder/ComfyUI-DyPE',
  'Power Lora Loader (rgthree)': 'rgthree/rgthree-comfy',
  'Bookmark (rgthree)': 'rgthree/rgthree-comfy',
  'Label (rgthree)': 'rgthree/rgthree-comfy',
  RTXVideoSuperResolution: 'Comfy-Org/Nvidia_RTX_Nodes_ComfyUI',
  'StyleStringInjector2 //ZImagePowerNodes': 'martin-rizzo/ComfyUI-ZImagePowerNodes',
  // SeedVR2 图像/视频放大（numz/ComfyUI-SeedVR2_VideoUpscaler，四节点架构）
  SeedVR2LoadDiTModel: 'numz/ComfyUI-SeedVR2_VideoUpscaler',
  SeedVR2LoadVAEModel: 'numz/ComfyUI-SeedVR2_VideoUpscaler',
  SeedVR2VideoUpscaler: 'numz/ComfyUI-SeedVR2_VideoUpscaler',
  // TTP Toolset：分块放大（TTPlanetPig/Comfyui_TTP_Toolset）
  TTP_Image_Tile_Batch: 'TTPlanetPig/Comfyui_TTP_Toolset',
  TTP_Tile_image_size: 'TTPlanetPig/Comfyui_TTP_Toolset',
  TTP_Image_Assy: 'TTPlanetPig/Comfyui_TTP_Toolset',
  'SimpleMath+': 'cubiq/ComfyUI_essentials',
};

/**
 * 提交前校验：工作流用到的节点类型是否都在 ComfyUI 中安装。
 * 自定义节点（如 KJNodes 的 SetNode/GetNode）缺失时 ComfyUI 会返回 missing_node_type 400，
 * 这里提前检查并一次性列出全部缺失类型，附上对应的自定义节点包方便安装。
 */
export function assertNodeTypesInstalled(
  prompt: Record<string, any>,
  objectInfoData: Record<string, any>,
  json: Record<string, any>,
): void {
  const missing = new Map<string, string[]>();
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!node || typeof node !== 'object') continue;
    const cls = String((node as any).class_type ?? '');
    if (!cls || objectInfoData[cls]) continue;
    const title = (node as any)._meta?.title;
    const label = title && title !== cls ? `${title}（节点 ${nodeId}）` : `节点 ${nodeId}`;
    missing.set(cls, [...(missing.get(cls) ?? []), label]);
  }
  if (missing.size === 0) return;

  // UI 格式工作流带 properties.aux_id（优先），API 格式用已知包名表兜底
  const auxByClass = new Map<string, string>();
  const uiNodes: any[] = [
    ...((json?.nodes ?? []) as any[]),
    ...((json?.definitions?.subgraphs ?? []) as any[]).flatMap((d: any) => d?.nodes ?? []),
  ];
  for (const n of uiNodes) {
    const aux = n?.properties?.aux_id;
    if (typeof aux === 'string' && aux) auxByClass.set(String(n.type), aux);
  }

  const lines = [...missing.entries()].map(([cls, labels]) => {
    const aux = auxByClass.get(cls) ?? KNOWN_CUSTOM_NODE_PACKAGES[cls];
    return `- ${cls}${aux ? `（需安装自定义节点 ${aux}）` : ''}：${labels.join('、')}`;
  });
  throw new ComfyUIError(
    `工作流使用了 ComfyUI 未安装的节点类型：\n${lines.join('\n')}\n` +
      '请在 ComfyUI 中安装对应的自定义节点（ComfyUI Manager → Install Custom Nodes 搜索安装），安装后重启 ComfyUI 再重试；或改用其他工作流。',
  );
}

/** 文件类 combo 字段 → ComfyUI models 子目录（缺失模型错误提示用） */
const FILE_COMBO_FOLDERS: Record<string, string> = {
  ckpt_name: 'checkpoints',
  unet_name: 'diffusion_models',
  clip_name: 'text_encoders',
  vae_name: 'vae',
  lora_name: 'loras',
  control_net_name: 'controlnet',
  audio_name: 'audio',
};

/** 模型文件名 basename（去目录前缀、去扩展名） */
function modelBasename(name: string): string {
  return (name.split('/').pop() ?? name).replace(/\.(safetensors|pt|pth|bin|ckpt|sft)$/i, '');
}

/**
 * 提交前修正文件类 combo：
 * - 模板引用裸文件名但模型实际装在子目录（如 MINIMAX/H3/xxx.safetensors）→ 按 basename 别名替换为已安装路径；
 * - 模型确实未安装 → 抛可读错误（缺失文件、应放目录、可用同类模型），而不是 ComfyUI 的 “Value not in list”。
 */
export function resolveModelCombos(prompt: Record<string, any>, objectInfoData: Record<string, any>): void {
  for (const node of Object.values(prompt)) {
    if (!node || typeof node !== 'object') continue;
    const { class_type: cls, inputs } = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (!cls || !inputs) continue;
    const info = objectInfoData[cls]?.input;
    if (!info) continue;
    const defs: Record<string, unknown> = { ...(info.required ?? {}), ...(info.optional ?? {}) };
    for (const [field, value] of Object.entries(inputs)) {
      if (!(field in FILE_COMBO_FOLDERS) || typeof value !== 'string' || !value.trim()) continue;
      const def = defs[field] as any;
      const options: string[] = Array.isArray(def) && Array.isArray(def[0]) ? def[0] : [];
      if (!options.length || options.includes(value)) continue;
      // 子目录别名：模板写的是裸文件名，实际文件装在子目录
      const alias = options.find(o => o === value || o.endsWith(`/${value}`) || modelBasename(o) === modelBasename(value));
      if (alias) {
        inputs[field] = alias;
        continue;
      }
      const folder = FILE_COMBO_FOLDERS[field];
      const similar = suggestSimilarModels(value, options);
      const hint = similar.length
        ? `；或改用已安装的同类模型：${similar.join('、')}`
        : '；或更换其他工作流';
      throw new ComfyUIError(
        `工作流需要模型「${value}」（models/${folder}/），但 ComfyUI 中未安装。` +
          `请先把该模型下载到 ComfyUI/models/${folder}/${value}${hint}。`,
      );
    }
  }
}

/** 从已安装选项中找与缺失模型同家族的候选（basename 前两段前缀匹配，最多 3 个） */
function suggestSimilarModels(missing: string, options: string[]): string[] {
  const base = modelBasename(missing).toLowerCase();
  const tokens = base.split('_');
  const prefix = tokens.length >= 2 ? `${tokens[0] ?? ''}_${tokens[1] ?? ''}` : tokens[0] ?? '';
  return options
    .map(o => ({ o, b: modelBasename(o).toLowerCase() }))
    .filter(x => x.b !== base && x.b.startsWith(prefix))
    .sort((a, b) => a.b.length - b.b.length)
    .slice(0, 3)
    .map(x => x.o);
}

/** combo 选项是否像文件列表（模型/素材文件选择，含扩展名或路径分隔符） */
function isFileLikeCombo(options: string[]): boolean {
  return options.some(o => o.includes('/') || /\.[a-z0-9]{2,5}$/i.test(o));
}

/** 校验其余 combo 参数（采样器/调度器等）的值在允许列表内，给出可读错误 */
export function validateComboValues(prompt: Record<string, any>, objectInfoData: Record<string, any>): void {
  for (const node of Object.values(prompt)) {
    if (!node || typeof node !== 'object') continue;
    const { class_type: cls, inputs } = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (!cls || !inputs) continue;
    const info = objectInfoData[cls]?.input;
    if (!info) continue;
    const defs: Record<string, unknown> = { ...(info.required ?? {}), ...(info.optional ?? {}) };
    for (const [field, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const def = defs[field] as any;
      const options: string[] = Array.isArray(def) && Array.isArray(def[0]) ? def[0] : [];
      if (!options.length || options.includes(value)) continue;
      // 文件选择类 combo（LoadImage.image、素材占位等）由上传流程替换，不在此校验；模型文件由 resolveModelCombos 处理
      if (isFileLikeCombo(options)) continue;
      const shown = options.length > 6 ? [...options.slice(0, 6), '…'] : options;
      throw new ComfyUIError(
        `工作流参数「${field}」的值「${value}」不在允许列表内（可用值：${shown.join('、')}）。请检查 ComfyUI 设置或改用其他参数。`,
      );
    }
  }
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
  const prompt = pruneDeadNodes(
    isUiFormat(json)
      ? convertUiToApi(json, oi ?? {})
      : (() => {
          const copy = JSON.parse(JSON.stringify(json)) as Record<string, any>;
          delete copy._meta; // API 格式顶层 _meta 是工作流元信息，不是节点
          return copy;
        })(),
  );

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

  // 参数注入（优先使用显式传递的 params，未传递时从 settings 获取全局默认值）
  const s = values.settings;
  for (const p of spec.params) {
    let v = values.params?.[p.id];

    if (v === undefined && s) {
      if (p.field === 'seed' || p.field === 'noise_seed') {
        if (s.seedMode === 'fixed' && s.seed >= 0) {
          v = s.seed;
        } else {
          // 随机种子：优先取参数声明上限（如 SeedVR2 为 uint32），无上限时按 2^32-1 安全截断，
          // 避免超过节点字段最大值导致 ComfyUI 校验失败
          const max = typeof p.max === 'number' ? p.max : 4294967295;
          const min = typeof p.min === 'number' ? p.min : 0;
          v = min + Math.floor(Math.random() * (max - min + 1));
        }
      } else if (p.field === 'steps' && typeof s.steps === 'number') {
        v = s.steps;
      } else if (p.field === 'cfg' && typeof s.cfg === 'number') {
        v = s.cfg;
      } else if (p.field === 'sampler_name' && typeof s.sampler_name === 'string') {
        v = s.sampler_name;
      } else if (p.field === 'scheduler' && typeof s.scheduler === 'string') {
        v = s.scheduler;
      } else if (p.field === 'denoise' && typeof s.denoise === 'number') {
        v = s.denoise;
      } else if (p.field === 'width' && typeof s.width === 'number') {
        v = s.width;
      } else if (p.field === 'height' && typeof s.height === 'number') {
        v = s.height;
      }
    }

    if (v === undefined) continue;
    // 同一字段去重后应用到全部节点（分阶段采样链的多个 KSampler 等）
    for (const nid of [...(p.applyTo ?? []), p.nodeId]) {
      if (prompt[nid]?.inputs) prompt[nid].inputs[p.field] = v;
    }
  }

  // 生成尺寸注入：把链接型 width/height（来自 ResolutionSelector 等）替换为具体数值
  if (values.resolution) {
    injectResolution(prompt, values.resolution);
  }

  // checkpoint 自动探测（仅当工作流含 checkpoint 节点）
  if (oi) await resolveCheckpoints(prompt, oi);

  // 提交前校验：节点类型已安装 → 子目录模型别名解析 + 缺失模型/非法参数给出可读错误
  if (oi) {
    assertNodeTypesInstalled(prompt, oi, json);
    resolveModelCombos(prompt, oi);
    validateComboValues(prompt, oi);
  }

  return prompt;
}

/** 尺寸类节点：EmptyLatentImage / EmptySD3LatentImage 等 */
const RESOLUTION_CLASS_RE = /Empty.*(Latent|SD3|Flux)|(Latent|SD3).*Size/i;

/**
 * 把目标宽高写入 prompt 中的分辨率节点：
 * - 类名匹配的 latent 空节点（EmptyLatentImage/EmptySD3LatentImage 等）直接覆写；
 * - 宽高为 link 数组（由 ResolutionSelector 接线）的节点也覆写（覆盖 ModelSamplingFlux、MiniMaxH3*ToVideo 等）。
 */
export function injectResolution(prompt: Record<string, any>, res: Resolution): void {
  for (const node of Object.values(prompt)) {
    const inputs = (node as any)?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    if (typeof inputs.width === 'undefined' || typeof inputs.height === 'undefined') continue;
    const ct = String((node as any)?.class_type ?? '');
    const isLatentClass = RESOLUTION_CLASS_RE.test(ct);
    const isLinked = Array.isArray(inputs.width) && Array.isArray(inputs.height);
    if (isLatentClass || isLinked) {
      inputs.width = res.width;
      inputs.height = res.height;
    }
  }
}

/** 输入节点是否有强依赖（如必须上传参考图/视频） */
export function requiredInputKinds(spec: WorkflowSpec): Set<'image' | 'video'> {
  const kinds = new Set<'image' | 'video'>();
  for (const input of spec.inputs) {
    if (input.kind === 'image' && (input.required || !String(input.defaultValue ?? '').trim())) kinds.add('image');
    if (input.kind === 'video' && (input.required || !String(input.defaultValue ?? '').trim())) kinds.add('video');
  }
  return kinds;
}
