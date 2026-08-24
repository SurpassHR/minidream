import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowSpec } from './workflow.js';
import { DEFAULT_PLUGIN_RESPONSE_POLICY, parsePluginResponsePolicy, pluginSkillPath, type PluginResponsePolicy } from './workflow-skill.js';

export type ResponseContainer = 'text' | 'collapsible';
export type ResponseFormat = 'plain' | 'markdown' | 'code';
export type ResponseTiming = 'submit' | 'complete' | 'always';
export type ResponseSource = string;

export interface PluginResponseBlock {
  id: string;
  type: 'field' | 'template' | 'assistant-reply';
  source?: ResponseSource;
  template?: string;
  label?: string;
  container: ResponseContainer;
  format: ResponseFormat;
  defaultOpen?: boolean;
  language?: string;
  timing: ResponseTiming;
  visibleWhen?: {
    source: ResponseSource;
    operator: 'exists' | 'not-empty';
  };
}

export interface PluginResponseProtocol {
  version: 1;
  thinking: {
    enabled: boolean;
    container: ResponseContainer;
    format: ResponseFormat;
    defaultOpen?: boolean;
    language?: string;
  };
  blocks: PluginResponseBlock[];
  result: { display: 'outside-bubble' };
}

export interface PluginResponseContext {
  plugin: { name: string; description?: string };
  input: Record<string, unknown>;
  param: Record<string, unknown>;
  generation: {
    prompt?: unknown;
    negativePrompt?: unknown;
    workflowName?: unknown;
    intent?: unknown;
  };
  route: {
    requestedWorkflow?: unknown;
    finalWorkflow?: unknown;
    reason?: unknown;
  };
  result: {
    count?: unknown;
    types?: unknown;
    status?: unknown;
  };
  assistant: { reply?: unknown };
}

export interface RenderedResponseBlock {
  id: string;
  order?: number;
  type: PluginResponseBlock['type'] | 'thinking';
  source?: string;
  label?: string;
  content: string;
  container: ResponseContainer;
  format: ResponseFormat;
  defaultOpen?: boolean;
  language?: string;
  timing: ResponseTiming;
}

const SOURCE_RE = /^(plugin\.(?:name|description)|input\.[a-z0-9][a-z0-9_-]{0,63}|param\.[a-z0-9][a-z0-9_-]{0,63}|generation\.(?:prompt|negativePrompt|workflowName|intent)|route\.(?:requestedWorkflow|finalWorkflow|reason)|result\.(?:count|types|status)|assistant\.reply)$/;
const MAX_BLOCKS = 100;
const MAX_TEXT = 10_000;
const MAX_ID = 80;
const MAX_LABEL = 200;
const MAX_LANGUAGE = 40;

export function pluginResponsePath(id: string, root: string): string {
  return path.join(path.dirname(pluginSkillPath(id, root)), 'response.json');
}

export function readPluginResponseProtocol(id: string, root: string): PluginResponseProtocol | null {
  const file = pluginResponsePath(id, root);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as PluginResponseProtocol : null;
  } catch {
    return null;
  }
}

export function writePluginResponseProtocol(id: string, protocol: PluginResponseProtocol, root: string): void {
  const file = pluginResponsePath(id, root);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(protocol, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function deletePluginResponseProtocol(id: string, root: string): void {
  const file = pluginResponsePath(id, root);
  if (existsSync(file)) rmSync(file, { force: true });
}

export function resolvePluginResponseProtocol(
  id: string,
  spec: WorkflowSpec,
  root: string,
): PluginResponseProtocol {
  const saved = readPluginResponseProtocol(id, root);
  if (saved && validatePluginResponseProtocol(saved, spec).length === 0) return saved;
  return legacyPolicyToResponseProtocol(parsePluginResponsePolicy(readSkillForResponse(id, root)));
}

function readSkillForResponse(id: string, root: string): string | null {
  const file = pluginSkillPath(id, root);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

export function ensurePluginResponseProtocol(id: string, spec: WorkflowSpec, root: string): PluginResponseProtocol {
  const saved = readPluginResponseProtocol(id, root);
  if (saved && validatePluginResponseProtocol(saved, spec).length === 0) return saved;
  const protocol = resolvePluginResponseProtocol(id, spec, root);
  writePluginResponseProtocol(id, protocol, root);
  return protocol;
}

/** 在插件生命周期中补齐 response.json，但不覆盖有效的用户自定义协议。 */
export function syncPluginResponseProtocol(spec: WorkflowSpec, root: string): void {
  ensurePluginResponseProtocol(spec.id, spec, root);
}

function baseBlock(overrides: Partial<PluginResponseBlock>): PluginResponseBlock {
  return {
    id: 'block',
    type: 'template',
    container: 'text',
    format: 'plain',
    timing: 'always',
    ...overrides,
  };
}

export function defaultPluginResponseProtocol(): PluginResponseProtocol {
  return {
    version: 1,
    thinking: {
      enabled: true,
      container: 'collapsible',
      format: 'plain',
      defaultOpen: false,
    },
    blocks: [
      baseBlock({
        id: 'generation-prompt',
        type: 'field',
        source: 'generation.prompt',
        label: '生成提示词',
        format: 'code',
        language: 'text',
        timing: 'submit',
      }),
      baseBlock({
        id: 'generation-route',
        type: 'field',
        source: 'route.finalWorkflow',
        label: '工作流路由',
        timing: 'submit',
      }),
      baseBlock({
        id: 'assistant-reply',
        type: 'assistant-reply',
        source: 'assistant.reply',
        format: 'markdown',
        timing: 'always',
      }),
    ],
    result: { display: 'outside-bubble' },
  };
}

export function responseProtocolAllowsPrompt(protocol: PluginResponseProtocol, spec: WorkflowSpec): boolean {
  const primaryIds = new Set(spec.inputs.filter(input => !input.hidden && input.primary).map(input => input.id));
  return protocol.blocks.some(block => {
    if (block.type === 'template') {
      return /\{\{\s*generation\.prompt(?:\s*\||\s*\}\})/.test(block.template ?? '')
        || [...(block.template ?? '').matchAll(/\{\{\s*input\.([a-z0-9][a-z0-9_-]{0,63})/g)].some(match => primaryIds.has(match[1]!));
    }
    return block.source === 'generation.prompt' || (block.source?.startsWith('input.') && primaryIds.has(block.source.slice('input.'.length)));
  });
}

export function legacyPolicyToResponseProtocol(policy: PluginResponsePolicy): PluginResponseProtocol {
  const protocol = defaultPluginResponseProtocol();
  protocol.thinking = {
    enabled: policy.thinking !== 'hidden',
    container: 'collapsible',
    format: 'plain',
    defaultOpen: policy.thinking === 'visible',
  };
  protocol.blocks = protocol.blocks.filter(block => {
    if (block.source === 'generation.prompt') return policy.prompt === 'visible';
    if (block.source === 'route.finalWorkflow') return policy.route === 'visible';
    return true;
  });
  return protocol;
}

function visibleParamIds(spec: WorkflowSpec): Set<string> {
  return new Set(spec.params.filter(param => !param.hidden && param.llm !== false).map(param => param.id));
}

function visibleInputIds(spec: WorkflowSpec): Set<string> {
  return new Set(spec.inputs.filter(input => !input.hidden).map(input => input.id));
}

function hasNegativePrompt(spec: WorkflowSpec): boolean {
  return spec.params.some(param =>
    !param.hidden && param.llm !== false && /负面|反面|negative/i.test(`${param.label} ${param.description ?? ''}`),
  );
}

function sourceAllowed(source: string, spec: WorkflowSpec): boolean {
  if (!SOURCE_RE.test(source)) return false;
  if (source.startsWith('input.')) return visibleInputIds(spec).has(source.slice('input.'.length));
  if (source.startsWith('param.')) return visibleParamIds(spec).has(source.slice('param.'.length));
  if (source === 'generation.negativePrompt') return hasNegativePrompt(spec);
  return true;
}

function validString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length <= max;
}

function validateDisplay(
  value: Partial<Pick<PluginResponseBlock, 'container' | 'format' | 'timing'>>,
  path: string,
  errors: string[],
): void {
  if (value.container !== 'text' && value.container !== 'collapsible') errors.push(`${path}.container 无效`);
  if (value.format !== 'plain' && value.format !== 'markdown' && value.format !== 'code') errors.push(`${path}.format 无效`);
  if (value.timing !== 'submit' && value.timing !== 'complete' && value.timing !== 'always') errors.push(`${path}.timing 无效`);
}

export function validatePluginResponseProtocol(protocol: unknown, spec: WorkflowSpec): string[] {
  const errors: string[] = [];
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return ['protocol 必须是对象'];
  const value = protocol as Partial<PluginResponseProtocol>;
  if (value.version !== 1) errors.push('protocol.version 必须为 1');
  if (!value.result || value.result.display !== 'outside-bubble') errors.push('result.display 必须为 outside-bubble');

  const thinking = value.thinking;
  if (!thinking || typeof thinking !== 'object') {
    errors.push('thinking 必须是对象');
  } else {
    if (typeof thinking.enabled !== 'boolean') errors.push('thinking.enabled 必须是布尔值');
    if (thinking.container !== 'text' && thinking.container !== 'collapsible') errors.push('thinking.container 无效');
    if (thinking.format !== 'plain' && thinking.format !== 'markdown' && thinking.format !== 'code') errors.push('thinking.format 无效');
    if (thinking.defaultOpen !== undefined && typeof thinking.defaultOpen !== 'boolean') errors.push('thinking.defaultOpen 无效');
    if (thinking.language !== undefined && !validString(thinking.language, MAX_LANGUAGE)) errors.push('thinking.language 无效');
  }

  if (!Array.isArray(value.blocks)) {
    errors.push('blocks 必须是数组');
    return errors;
  }
  if (value.blocks.length > MAX_BLOCKS) errors.push(`blocks 不能超过 ${MAX_BLOCKS} 项`);
  const ids = new Set<string>();
  value.blocks.forEach((raw, index) => {
    const path = `blocks[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    const block = raw as Partial<PluginResponseBlock>;
    if (!validString(block.id, MAX_ID)) errors.push(`${path}.id 无效`);
    else if (ids.has(block.id!)) errors.push(`${path}.id 重复：${block.id}`);
    else ids.add(block.id!);
    if (block.type !== 'field' && block.type !== 'template' && block.type !== 'assistant-reply') errors.push(`${path}.type 无效`);
    validateDisplay(block, path, errors);
    if (block.label !== undefined && !validString(block.label, MAX_LABEL)) errors.push(`${path}.label 无效`);
    if (block.language !== undefined && !validString(block.language, MAX_LANGUAGE)) errors.push(`${path}.language 无效`);
    if (block.type === 'field' || block.type === 'assistant-reply') {
      if (typeof block.source !== 'string' || !sourceAllowed(block.source, spec)) errors.push(`${path}.source 无效：${String(block.source)}`);
      if (block.type === 'assistant-reply' && block.source !== 'assistant.reply') errors.push(`${path}.source 必须为 assistant.reply`);
      if (block.type === 'field' && block.source === 'assistant.reply') errors.push(`${path}.source 不能为 assistant.reply`);
    }
    if (block.type === 'template') {

      if (typeof block.template !== 'string' || block.template.length > MAX_TEXT) {
        errors.push(`${path}.template 无效`);
      } else {
        const placeholders = [...block.template.matchAll(/\{\{\s*([^{}|\s]+)/g)].map(match => match[1]);
        for (const source of placeholders) {
          if (!source || !sourceAllowed(source, spec)) errors.push(`${path}.template 占位符无效：${source}`);
        }
      }
    }
    if (block.visibleWhen) {
      if (!sourceAllowed(block.visibleWhen.source, spec)) errors.push(`${path}.visibleWhen.source 无效：${block.visibleWhen.source}`);
      if (block.visibleWhen.operator !== 'exists' && block.visibleWhen.operator !== 'not-empty') errors.push(`${path}.visibleWhen.operator 无效`);
    }
  });
  return errors;
}

function valueAt(source: string, context: PluginResponseContext): unknown {
  const [namespace, key] = source.split('.', 2);
  if (namespace === 'plugin') return context.plugin[key as keyof typeof context.plugin];
  if (namespace === 'input') return context.input[key!];
  if (namespace === 'param') return context.param[key!];
  if (namespace === 'generation') return context.generation[key as keyof typeof context.generation];
  if (namespace === 'route') return context.route[key as keyof typeof context.route];
  if (namespace === 'result') return context.result[key as keyof typeof context.result];
  if (namespace === 'assistant') return context.assistant[key as keyof typeof context.assistant];
  return undefined;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function renderResponseTemplate(template: string, context: PluginResponseContext): string {
  return template.replace(/\{\{\s*([^{}|\s]+)(?:\s*\|\s*default\s*:\s*"([^"]*)")?\s*\}\}/g, (_match, source: string, fallback?: string) => {
    const value = valueAt(source, context);
    const rendered = formatValue(value);
    return rendered || fallback || '';
  });
}

function shouldRender(block: PluginResponseBlock, context: PluginResponseContext): boolean {
  if (!block.visibleWhen) return true;
  const value = valueAt(block.visibleWhen.source, context);
  if (block.visibleWhen.operator === 'exists') return value !== undefined && value !== null;
  return formatValue(value).trim().length > 0;
}

export function renderResponseBlocks(
  protocol: PluginResponseProtocol,
  context: PluginResponseContext,
  timing: ResponseTiming,
): RenderedResponseBlock[] {
  return protocol.blocks
    .map((block, order) => ({ block, order }))
    .filter(({ block }) => block.timing === timing || block.timing === 'always')
    .sort((a, b) => a.order - b.order)
    .filter(({ block }) => shouldRender(block, context))
    .map(({ block, order }) => {
      const raw = block.type === 'template'
        ? block.template ?? ''
        : formatValue(block.source ? valueAt(block.source, context) : '');
      return {
        id: block.id,
        order,
        type: block.type,
        source: block.source,
        label: block.label,
        content: block.type === 'template' ? renderResponseTemplate(raw, context) : raw,
        container: block.container,
        format: block.format,
        defaultOpen: block.defaultOpen,
        language: block.language,
        timing: block.timing,
      };
    });
}
