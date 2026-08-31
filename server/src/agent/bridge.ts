import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorkflowSpec } from '../workflow.js';
import type { PluginCreatorSuggestions } from '../plugin-creator.js';
import { parsePluginSuggestions } from '../plugin-creator.js';
import { writeSeedExtension } from './seed.js';

export interface AgentStreamEvent {
  type: 'status' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'end';
  status?: string;
  delta?: string;
  tool?: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  result?: {
    id?: string;
    name?: string;
    content: unknown;
  };
  error?: string;
}

export interface AgentModel {
  id: string;
  provider: string;
  thinking: boolean;
  images: boolean;
}

/** 解析 `pi --list-models` 的表格输出。 */
export function parsePiModelList(stdout: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 6 || cells[0] === 'provider') continue;
    const [provider, model, , , thinking, images] = cells;
    if (!provider || !model) continue;
    models.push({
      id: `${provider}/${model}`,
      provider,
      thinking: thinking === 'yes',
      images: images === 'yes',
    });
  }
  return models;
}

export async function listAgentModels(): Promise<AgentModel[]> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn('pi', ['--list-models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.once('close', () => resolve(parsePiModelList(stdout)));
    child.once('error', () => resolve([]));
  });
}

export type AgentThinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 会话命名提示词：要求输出简洁中文标题，直接输出标题本身 */
const PROJECT_SKILL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.pi/skills/director-copilot/SKILL.md',
);
const PLUGIN_SKILL_CREATOR_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.pi/skills/plugin-creator/SKILL.md',
);

function appendSkillIsolationArgs(args: string[], includeProjectSkill: boolean): void {
  args.push('--no-skills');
  if (includeProjectSkill && fs.existsSync(PROJECT_SKILL_PATH)) {
    args.push('--skill', PROJECT_SKILL_PATH);
  }
}

const TITLE_SYSTEM_PROMPT = [
  '你是对话命名助手。根据用户的第一条消息，为这个对话生成一个简洁的中文标题。',
  '要求：',
  '- 不超过 12 个字',
  '- 概括消息的核心主题或意图，不要照抄原句',
  '- 直接输出标题本身，不要引号、不要解释、不要换行',
].join('\n');

export interface TitleGenOptions {
  model?: string;
  thinking?: AgentThinking;
  /** 超时毫秒数；默认 20s */
  timeoutMs?: number;
}

/** 模型可能输出的结束符 token */
const EOS_TOKEN_RE = /^(<\/s>|<\|endoftext\|>|<\|eot_id\|>)+/gi;

/**
 * 从 pi --print 输出中提取标题（取最后一行非状态/错误文本，并清理引号、标点与结束符 token）。
 * 输出疑似散文/句子（过长或含问叹号）时返回空串，交由调用方回退到截断标题。
 */
export function sanitizeTitle(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const candidates = lines.filter(line => !/API\s+\d{3}|^\[|^error|重试|retry|unavailable|unexpected/i.test(line));
  const picked = candidates.length ? (candidates[candidates.length - 1] ?? '') : '';
  // 原始行带问叹号（可能是对话/散文）→ 直接判定无效，避免被末尾清理规则掩盖
  if (/[？?！!]/.test(picked)) return '';
  const cleaned = picked
    .replace(EOS_TOKEN_RE, '')
    .replace(/^["'「『【（(，,]+/, '')
    .replace(/["'」』】）).。，,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  // 标题过长 → 判定为散文而非标题
  if (cleaned.length > 24) return '';
  return Array.from(cleaned).slice(0, 20).join('');
}

/**
 * 为对话生成标题：轻量、无工具的 Pi 调用（--print --no-tools --no-session）。
 * 失败、超时或输出不像标题时自动重试一次；仍失败返回 null，由调用方回退到截断标题，不打断主流程。
 */
export async function generateConversationTitle(
  userMessage: string,
  opts: TitleGenOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const args: string[] = ['--print', '--no-tools', '--no-session', '--thinking', opts.thinking ?? 'off'];
  appendSkillIsolationArgs(args, false);
  if (opts.model?.trim()) args.push('--model', opts.model.trim());
  args.push('--append-system-prompt', TITLE_SYSTEM_PROMPT);

  const runOnce = (): Promise<string | null> =>
    new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }
      let stdout = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (title: string | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(title);
      };
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 2000).unref();
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.once('close', () => {
        const title = sanitizeTitle(stdout);
        finish(title || null);
      });
      child.once('error', () => finish(null));
      child.stdin?.write(userMessage.slice(0, 400));
      child.stdin?.end();
    });

  for (let attempt = 0; attempt < 2; attempt++) {
    const title = await runOnce();
    if (title) return title;
  }
  return null;
}

export interface RunAgentOptions {
  model?: string;
  sessionId?: string;
  mcpServerUrl?: string;
  systemPrompt?: string;
  /** 虚构对话历史：构建为真实交替 user/assistant 消息，经动态生成的 Pi 扩展在每次 LLM 调用前注入请求头部 */
  seedHistory?: FabricatedTurn[];
  /** 删除消息后保留的可见会话历史；仅注入请求，不写入 Pi 会话日志。 */
  contextHistory?: FabricatedTurn[];
  /** 使用 contextHistory 重建上下文时必须禁用 Pi 持久会话，避免每轮重复注入历史。 */
  rebuildContext?: boolean;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  /** Pi 推理强度；默认 minimal，设置为 off 可优先响应速度。 */
  thinking?: AgentThinking;
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface FabricatedTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 将用户消息和多模态素材/上下文组装为发送给 Pi Agent 的输入文本。
 * 虚构对话历史不再拼接进文本——改由 seed.ts 构建真实交替 user/assistant
 * 消息、经动态生成的 Pi 扩展注入请求头部（参考 custom-first-control-prompt
 * 的请求路径注入机制，零会话日志写入、保持前缀缓存复用）。
 */
export function buildAgentInput(
  optionsOrMessage:
    | string
    | {
        message: string;
        sessionId?: string;
        images?: Array<string | { name?: string; dataUrl?: string; filename?: string }>;
        videos?: Array<string | { name?: string; dataUrl?: string; filename?: string }>;
        context?: string;
      },
  options: {
    sessionId?: string;
    images?: Array<string | { name?: string; dataUrl?: string; filename?: string }>;
    videos?: Array<string | { name?: string; dataUrl?: string; filename?: string }>;
    context?: string;
  } = {}
): string {
  const message =
    typeof optionsOrMessage === 'string'
      ? optionsOrMessage
      : optionsOrMessage.message;
  const opts =
    typeof optionsOrMessage === 'string' ? options : optionsOrMessage;

  const parts: string[] = [];
  if (opts.context?.trim()) {
    parts.push(`【上下文信息】\n${opts.context.trim()}`);
  }
  if (opts.images && opts.images.length > 0) {
    parts.push(
      `【参考图片】\n${opts.images
        .map((img, i) => {
          const obj = typeof img === 'string' ? null : img;
          const name = obj?.name || '';
          // 会话素材使用 imageN/videoN 名称，便于 Agent 将用户指令中的 @ 名称与文件对应。
          const label = name || `image${i + 1}`;
          // 优先展示已上传到 ComfyUI 的真实文件名（Agent 提交时按序传入）
          const shown = typeof img === 'string' ? img : obj?.filename || name || `image${i + 1}`;
          return `[${label}]: ${shown}`;
        })
        .join('\n')}`
    );
  }
  if (opts.videos && opts.videos.length > 0) {
    parts.push(
      `【参考视频】\n${opts.videos
        .map((vid, i) =>
          `[${typeof vid === 'string' ? `video${i + 1}` : vid.name || `video${i + 1}`}]: ${typeof vid === 'string' ? vid : vid.filename || vid.name || `video${i + 1}`}`
        )
        .join('\n')}`
    );
  }
  parts.push(`【用户指令】\n${message}`);
  return parts.join('\n\n');
}

export interface PluginSkillCreatorOptions {
  /** 超时毫秒数；默认 120s */
  timeoutMs?: number;
}

/** 把 spec 序列化为 skill 生成器输入：保留类型/description/范围等，剔除 nodeId/field 等实现细节 */
function serializeSpecForSkillCreator(spec: WorkflowSpec): string {
  const data = {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    inputs: spec.inputs
      .filter(input => !input.hidden)
      .map(input => ({
      kind: input.kind,
      label: input.label,
      // 节点标题（如 Positive Prompt/参考图），供模型生成可读参数名
      title: input.nodeTitle ?? input.label,
      primary: input.primary,
      required: input.required,
      // 过滤过长的 defaultValue（如模板内置提示词），避免混淆模型生成 prompt 而非 SKILL.md
      defaultValue: typeof input.defaultValue === 'string' && input.defaultValue.length > 120 ? '' : input.defaultValue,
      description: input.description,
    })),
    params: spec.params
      .filter(param => !param.hidden && param.llm !== false && !param.bypass)
      .map(param => ({
        id: param.id,
        label: param.label,
        // 节点标题（如 Width/Height），供模型生成可读参数名
        title: param.nodeTitle ?? param.label,
        type: param.type,
        default: param.default,
        min: param.min,
        max: param.max,
        step: param.step,
        options: param.options,
        multiple: param.multiple,
        strengthable: param.strengthable,
        applyTo: param.applyTo,
        description: param.description,
      })),
    outputs: spec.outputs
      .filter(output => !output.hidden)
      .map(output => ({
      kind: output.kind,
      label: output.label,
      description: output.description,
    })),
  };
  return JSON.stringify(data, null, 2);
}

/** 抑制前言/解释，要求直接输出 SKILL.md 本体 */
const PLUGIN_SKILL_CREATOR_SYSTEM_PROMPT = [
  '你是工作流插件的 Skill 作者。',
  '严格按照 plugin-creator skill 的规则为输入的插件 manifest 生成 SKILL.md。',
  '直接输出 SKILL.md 的完整内容本身：第一行必须是 ---（frontmatter 起始），',
  '不要任何前言、解释、分析、问候语或 Markdown 代码围栏（```）。',
  '不要输出思考过程。',
  '禁止生成 prompt 模板、场景描述或 YAML/JSON 配置格式。',
  '输出必须是标准 Markdown 文档，包含只含 name/description 的 frontmatter + # 标题 + ## 用途 + ## 输入 + ## 可控制参数 + ## 输出 + ## 使用规则 章节。不要生成 response frontmatter 或 ## 回复协议 章节。',
].join('\n');

/** 从 pi 输出提取 markdown：优先取 ``` 围栏内容，其次取 frontmatter 起的正文，否则取完整输出 */
function extractSkillMarkdown(stdout: string): string {
  const fenced = stdout.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
  if (fenced?.[1]?.trim()) return fenced[1].trim() + '\n';
  const trimmed = stdout.trim();
  if (trimmed.startsWith('---')) return trimmed + '\n';
  // 前言混入时：从第一个 frontmatter 分隔行（---）之后开始取
  const index = trimmed.indexOf('\n---\n');
  if (index >= 0) {
    const rest = trimmed.slice(index + 1).trim();
    if (rest.startsWith('---')) return rest + '\n';
  }
  return trimmed;
}

/** 验证提取的内容是否符合 SKILL.md 基本结构 */
function looksLikeSkillMd(content: string): boolean {
  const trimmed = content.trim();
  // 必须以 --- 开头（frontmatter）
  if (!trimmed.startsWith('---')) return false;
  // 必须包含 Skill 章节，回复协议由独立 response.json 管理
  if (!/##\s+(可控制参数|输入|用途|输出|使用规则)/.test(trimmed)) return false;
  if (/^response:\s*$/m.test(trimmed) || /^##\s+回复协议\s*$/m.test(trimmed)) return false;
  return true;
}

/**
 * 将 LLM 返回的 Skill 收敛到 manifest 契约，避免模型复述未暴露的内部参数。
 * 生成器输入已经过滤一次，这里是最后一道防线：只清理输入/参数/输出列表及使用规则，
 * 不改动用途描述，保留 LLM 对真实可控参数的自然语言说明。
 */
const SKILL_TYPE_LABEL: Record<string, string> = {
  INT: '整数',
  FLOAT: '浮点数',
  BOOLEAN: '布尔',
  SEED: '随机种子',
  STRING: '文本',
  combo: '下拉选项',
};
const SKILL_KIND_LABEL: Record<string, string> = {
  image: '图像',
  video: '视频',
  text: '文本',
  number: '数值',
  boolean: '布尔',
};
const formatSkillDefault = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

/**
 * 将 LLM 返回的 Skill 收敛到 manifest 契约。
 * 输入/可控制参数/输出三节用 spec 数据确定性重建：每项一行、必带 id（generation.submit 的键）
 * 与节点标题，避免模型省略 id、留空或重复；模型对某项目的自然语言描述（冒号后文本）
 * 若能匹配该项 id/节点标题则合并保留。其余章节（用途/使用规则）保留模型内容，
 * 仅剔除内部参数（llm:false / hidden / bypass）与跳过规则。
 */
export function sanitizePluginSkillToSpec(spec: WorkflowSpec, content: string): string {
  const visibleInputs = spec.inputs.filter(input => !input.hidden);
  const visibleParams = spec.params.filter(param => !param.hidden && param.llm !== false && !param.bypass);
  const visibleOutputs = spec.outputs.filter(output => !output.hidden);
  // 未暴露给 LLM 的内部参数 id（llm:false / hidden / bypass），Skill 中不得出现。
  const forbiddenIds = spec.params
    .filter(param => !visibleParams.includes(param))
    .map(param => param.id);
  const lines = content.trim().split(/\r?\n/);
  const sectionEnd = (start: number): number => {
    const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
    return next < 0 ? lines.length : next;
  };

  // 提取模型对某项的自然语言描述（第一个冒号后的文本）；只按 id / 节点标题匹配，
  // 避免泛 label（如 value/text）把描述误配到其他项。
  const extractModelNote = (modelLines: string[], keys: Array<string | undefined>): string => {
    const line = modelLines.find(item => keys.some(key => key && item.includes(key)));
    if (!line) return '';
    const idx = line.search(/[:：]/);
    if (idx < 0) return '';
    const rest = line.slice(idx + 1).replace(/[*`]/g, '').trim();
    return rest ? `：${rest}` : '';
  };

  // 用 spec 契约重建列表节：每项一行、必带 id；模型未写该节时追加（避免输入为空）。
  const rebuildSection = (
    heading: string,
    rows: Array<{ key: string; render: (modelLines: string[]) => string }>,
    emptyText: string,
  ): void => {
    const start = lines.findIndex(line => line.trim() === heading);
    const modelLines = start >= 0 ? lines.slice(start + 1, sectionEnd(start)) : [];
    const body = rows.map(row => row.render(modelLines));
    if (start >= 0) {
      lines.splice(start + 1, sectionEnd(start) - start - 1, ...(body.length ? body : [emptyText]));
    } else if (body.length) {
      lines.push('', heading, ...body);
    }
  };

  rebuildSection('## 输入', visibleInputs.map(input => ({
    key: input.id,
    render: modelLines => {
      const title = input.nodeTitle && input.nodeTitle !== input.label ? `${input.nodeTitle}（${input.label}）` : (input.label || input.kind);
      const note = extractModelNote(modelLines, [input.id, input.nodeTitle]);
      return `- **${title}**（id \`${input.id}\`；类型 ${SKILL_KIND_LABEL[input.kind] ?? input.kind}）${note}`;
    },
  })), '无（工作流不接收外部输入）。');

  rebuildSection('## 可控制参数', visibleParams.map(param => ({
    key: param.id,
    render: modelLines => {
      const bits = [`id \`${param.id}\``, `类型 ${SKILL_TYPE_LABEL[param.type] ?? param.type}`];
      const def = formatSkillDefault(param.default);
      if (def) bits.push(`默认 ${def}`);
      if (param.min !== undefined) bits.push(`范围 ${param.min} ~ ${param.max ?? '∞'}`);
      if (param.multiple) bits.push(param.strengthable ? '多选（每项可调强度）' : '多选');
      if (param.type === 'combo' && param.options?.length) {
        bits.push(`可选：${param.options.slice(0, 8).join('、')}${param.options.length > 8 ? '…' : ''}`);
      }
      if (param.applyTo?.length) bits.push(`同时作用于节点 ${param.applyTo.join('、')}`);
      const title = param.nodeTitle && param.nodeTitle !== param.label ? `${param.nodeTitle}（${param.label}）` : (param.label || param.field);
      const note = extractModelNote(modelLines, [param.id, param.nodeTitle]);
      return `- **${title}**（${bits.join('；')}）${note}`;
    },
  })), '无（该工作流的 widget 由模板固定，不可由 LLM 调整）。');

  rebuildSection('## 输出', visibleOutputs.map(output => ({
    key: output.id,
    render: modelLines => {
      const note = extractModelNote(modelLines, [output.id, output.label]);
      return `- **${output.label}**（id \`${output.id}\`；类型 ${SKILL_KIND_LABEL[output.kind] ?? output.kind}）${note}`;
    },
  })), '无。');

  const allowedLora = visibleParams.some(param => /\blora\b/i.test(`${param.id} ${param.label} ${param.field}`));
  const sanitized = lines.filter(line => {
    if (forbiddenIds.some(id => line.includes(id))) return false;
    // bypass 从不属于 LLM 契约；相关规则也不能进入 Skill。
    if (/\b(?:bypass|skip(?:ping)?)\b/i.test(line) || /跳过/.test(line)) return false;
    // 当前工作流未暴露 LoRA 时，删除规则中模型补写的 LoRA 操作说明。
    if (!allowedLora && /\blora\b/i.test(line)) return false;
    return true;
  });
  return sanitized.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * 用 plugin-creator skill 为插件生成 SKILL.md（无工具的单次 pi 调用）。
 * 使用 --mode json 并通过 agent_end 事件主动终止进程（--print 模式完成后不退出）。
 * 失败、超时或空输出时抛错，由调用方决定是否回退到自动生成版。
 */
export async function runPluginSkillCreator(
  spec: WorkflowSpec,
  opts: PluginSkillCreatorOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const args: string[] = ['--mode', 'json', '--no-tools', '--no-session', '--thinking', 'off'];
  appendSkillIsolationArgs(args, false);
  if (fs.existsSync(PLUGIN_SKILL_CREATOR_PATH)) {
    args.push('--skill', PLUGIN_SKILL_CREATOR_PATH);
  }
  args.push('--no-context-files');
  args.push('--append-system-prompt', PLUGIN_SKILL_CREATOR_SYSTEM_PROMPT);
  const input = serializeSpecForSkillCreator(spec);

  /** 单次 pi 调用：发送 manifest JSON，收集 text_delta 拼装输出 */
  const runOnce = (): Promise<string> =>
    new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let text = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve(extractSkillMarkdown(text));
      };
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3000).unref();
        finish(new Error('plugin-creator 生成超时'));
      }, timeoutMs);

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let json: Record<string, any>;
      try {
        json = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行忽略
      }
      if (json.type === 'agent_end') {
        // --print 模式下 pi 完成后不退出，json 模式收到 agent_end 后主动终止
        child.kill('SIGTERM');
        finish();
        return;
      }
      if (json.type === 'message_update') {
        const ame = json.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          text += ame.delta;
        }
        return;
      }
      if (json.type === 'message') {
        const message = (json.message && typeof json.message === 'object' ? json.message : json) as { content?: unknown };
        const content = message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: string }).text === 'string') {
              text += (block as { text: string }).text;
            }
          }
        } else if (typeof content === 'string') {
          text += content;
        }
        return;
      }
      if (json.type === 'error') {
        finish(new Error(String(json.error ?? json.message ?? 'Agent 错误')));
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once('error', (err: Error) => finish(err));
    child.once('close', () => finish());
    child.stdin?.write(input);
    child.stdin?.end();
  });

  // 最多尝试 2 次：首次失败或输出不符合 SKILL.md 格式时重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await runOnce();
    if (content && looksLikeSkillMd(content)) return sanitizePluginSkillToSpec(spec, content);
    if (attempt === 1) {
      throw new Error('plugin-creator 未返回有效 SKILL.md 内容');
    }
  }
  throw new Error('plugin-creator 未返回有效 SKILL.md 内容');
}

export interface PluginSkillChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PluginSkillChatResult {
  reply: string;
  skill: string;
}

const PLUGIN_SKILL_CHAT_SYSTEM_PROMPT = [
  '你是工作流插件 Skill 的对话式编辑助手。',
  '用户会要求调整当前插件的 Skill。你必须结合插件 widget 契约、当前 Skill 和对话历史理解修改意图。',
  '只修改用户明确要求的内容；保留当前 Skill 中未要求变更的有效规则、参数、输入输出和回复协议。',
  '回复必须是一个 JSON 对象，不要 Markdown 代码围栏，不要 JSON 之外的解释：',
  '{"reply":"给用户看的简短中文说明","skill":"完整的新 SKILL.md 内容"}',
  'skill 必须是完整 SKILL.md：第一行是 ---，frontmatter 只含 name/description，',
  '并包含 # 标题、## 用途、## 输入、## 可控制参数、## 输出、## 使用规则。',
  '不得生成 prompt 模板、场景描述、表格、response frontmatter、## 回复协议 或虚构 widget 参数。',
].join('\\n');

function serializePluginSkillChatInput(
  spec: WorkflowSpec,
  currentSkill: string,
  history: PluginSkillChatMessage[],
  userMessage: string,
): string {
  const widgetContract = {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    inputs: spec.inputs.filter(input => !input.hidden).map(input => ({
      id: input.id,
      kind: input.kind,
      label: input.label,
      description: input.description,
      primary: input.primary,
      required: input.required,
    })),
    params: spec.params
      .filter(param => !param.hidden && param.llm !== false && !param.bypass)
      .map(param => ({
        id: param.id,
        label: param.label,
        type: param.type,
        default: param.default,
        min: param.min,
        max: param.max,
        step: param.step,
        options: param.options,
        multiple: param.multiple,
        strengthable: param.strengthable,
        applyTo: param.applyTo,
        description: param.description,
      })),
    outputs: spec.outputs.filter(output => !output.hidden).map(output => ({
      id: output.id,
      kind: output.kind,
      label: output.label,
      description: output.description,
    })),
  };
  return [
    '【插件 widget 契约】',
    JSON.stringify(widgetContract, null, 2),
    '',
    '【当前 Skill】',
    currentSkill,
    '',
    '【对话历史】',
    JSON.stringify(history.slice(-20), null, 2),
    '',
    '【用户本次调整要求】',
    userMessage,
  ].join('\\n');
}

function parsePluginSkillChatResult(text: string): PluginSkillChatResult {
  const trimmed = text.trim();
  const candidates = [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as { reply?: unknown; skill?: unknown };
      if (typeof parsed.reply !== 'string' || typeof parsed.skill !== 'string') continue;
      // 兼容测试/模型把换行编码成字面量 \\n：真实内容仍按 SKILL.md 形式交给前端。
      const skill = parsed.skill.startsWith('---') ? parsed.skill.replace(/\\+n/g, '\n') : parsed.skill;
      if (!looksLikeSkillMd(skill)) continue;
      return { reply: parsed.reply.trim(), skill: skill.endsWith('\n') ? skill : `${skill}\n` };
    } catch {
      // 继续尝试从输出中提取 JSON
    }
  }
  throw new Error('Skill 对话 Agent 未返回有效的 { reply, skill } JSON');
}

/**
 * 通过无工具 Pi 子进程对话式调整插件 Skill。只返回预览内容，不写入磁盘。
 */
export async function runPluginSkillChat(
  spec: WorkflowSpec,
  currentSkill: string,
  history: PluginSkillChatMessage[],
  userMessage: string,
  opts: PluginSkillCreatorOptions = {},
): Promise<PluginSkillChatResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const args: string[] = ['--mode', 'json', '--no-tools', '--no-session', '--thinking', 'off'];
  appendSkillIsolationArgs(args, false);
  if (fs.existsSync(PLUGIN_SKILL_CREATOR_PATH)) args.push('--skill', PLUGIN_SKILL_CREATOR_PATH);
  args.push('--no-context-files', '--append-system-prompt', PLUGIN_SKILL_CHAT_SYSTEM_PROMPT);
  const input = serializePluginSkillChatInput(spec, currentSkill, history, userMessage);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let text = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (error) reject(error);
      else {
        try {
          const result = parsePluginSkillChatResult(text);
          resolve({ ...result, skill: sanitizePluginSkillToSpec(spec, result.skill) });
        } catch (parseError) {
          reject(parseError);
        }
      }
    };
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
      finish(new Error('Skill 对话生成超时'));
    }, timeoutMs);

    let eventBuffer = '';
    const handleChatLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let json: Record<string, any>;
      try {
        json = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (json.type === 'agent_end') {
        child.kill('SIGTERM');
        finish();
        return;
      }
      if (json.type === 'message_update') {
        const event = json.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (event?.type === 'text_delta' && typeof event.delta === 'string') text += event.delta;
        return;
      }
      if (json.type === 'message') {
        const message = (json.message && typeof json.message === 'object' ? json.message : json) as { content?: unknown };
        if (typeof message.content === 'string') {
          text += message.content;
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: string }).text === 'string') {
              text += (block as { text: string }).text;
            }
          }
        }
        return;
      }
      if (json.type === 'error') finish(new Error(String(json.error ?? json.message ?? 'Agent 错误')));
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      eventBuffer += chunk.toString();
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() ?? '';
      for (const line of lines) handleChatLine(line);
    });
    child.once('error', (error: Error) => finish(error));
    child.once('close', () => finish());
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

const PLUGIN_CREATOR_SUGGESTION_SYSTEM_PROMPT = [
  '你是 ComfyUI 工作流插件的配置分析助手。',
  '根据输入的工作流事实（节点图、输入/输出候选、widget 候选），只输出一个 JSON 对象，不要 Markdown 围栏或任何其他文字：',
  '{"purpose":{"name":"插件名","description":"一句话用途","capabilities":["能力"]},',
  '"inputs":{"<候选id>":{"description":"用途说明","recommended":true}},',
  '"outputs":{"<候选id>":{"description":"用途说明","recommended":true}},',
  '"widgets":[{"nodeId":"3","field":"steps","exposure":"llm","reason":"采样步数常调"}],',
  '"response":{"recommendedPromptVisibility":true,"blocks":[{"source":"result.image","timing":"complete","format":"plain"}]}}',
  '硬性约束：',
  '- nodeId/field 只能引用输入 widgets 中列出的候选；exposure 只能是 llm/fixed/hidden/review。',
  '- connected:true 的字段由上游连线驱动，不能标为 llm；若它对插件用途重要（如尺寸、时长、帧数），应从其 sources 列出的上游节点 widget 中找到对应源头参数，并将那个源头参数标为 llm。',
  '- inputs/outputs 的键只能是输入候选的 id；不得虚构节点、字段或参数。',
  '- blocks.source 只能是 result.image / result.video / result.text；timing 只能是 submit/complete/always；format 只能是 plain/markdown/code。',
  '- 图像/视频产物永远在气泡外展示，不要为它们生成 submit 块。',
].join('\n');

/**
 * 用无工具 pi 子进程生成插件配置语义建议（严格 JSON）。
 * 只返回解析后的建议对象，不落盘；结构合法性由 applyPluginSuggestions 在合并时校验。
 */
export async function runPluginCreatorSuggestions(
  facts: string,
  opts: PluginSkillCreatorOptions = {},
): Promise<PluginCreatorSuggestions> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const args: string[] = ['--mode', 'json', '--no-tools', '--no-session', '--thinking', 'off'];
  appendSkillIsolationArgs(args, false);
  args.push('--no-context-files', '--append-system-prompt', PLUGIN_CREATOR_SUGGESTION_SYSTEM_PROMPT);

  const text = await new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('pi', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let output = '';
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
      finish(new Error('plugin-creator 配置建议生成超时'));
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let json: Record<string, any>;
      try {
        json = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (json.type === 'agent_end') {
        child.kill('SIGTERM');
        finish();
        return;
      }
      if (json.type === 'message_update') {
        const event = json.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (event?.type === 'text_delta' && typeof event.delta === 'string') output += event.delta;
        return;
      }
      if (json.type === 'message') {
        const message = (json.message && typeof json.message === 'object' ? json.message : json) as { content?: unknown };
        if (typeof message.content === 'string') output += message.content;
        else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: string }).text === 'string') {
              output += (block as { text: string }).text;
            }
          }
        }
        return;
      }
      if (json.type === 'error') finish(new Error(String(json.error ?? json.message ?? 'Agent 错误')));
    });
    child.once('error', (error: Error) => finish(error));
    child.once('close', () => finish());
    child.stdin?.write(facts);
    child.stdin?.end();
  });

  return parsePluginSuggestions(text);
}

/**
 * 启动 Pi CLI 子进程并以流式方式处理 JSON 事件流
 */
export async function runAgentStream(
  prompt: string,
  onEventOrOptions: ((event: AgentStreamEvent) => void) | RunAgentOptions,
  legacyOptions?: RunAgentOptions
): Promise<{ exitCode: number | null; error?: string }> {
  let onEvent: (event: AgentStreamEvent) => void;
  let options: RunAgentOptions;

  if (typeof onEventOrOptions === 'function') {
    onEvent = onEventOrOptions;
    options = legacyOptions ?? {};
  } else {
    options = onEventOrOptions ?? {};
    onEvent = options.onEvent ?? (() => {});
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  // 严格禁用宿主开发工具（bash/read/edit/write/fffind/context_tree_query等），仅允许 mcp 工具与 director 专属 skill
  const args: string[] = [
    '--mode', 'json',
    '--thinking', options.thinking ?? 'minimal',
  ];
  appendSkillIsolationArgs(args, true);
  // 关闭 AGENTS.md/CLAUDE.md 上下文文件自动发现：导演 Agent 的知识来源
  // 收敛为 director-copilot skill + --append-system-prompt + MCP 工具，
  // 避免全局/项目 AGENTS.md 注入宿主编码环境规则。
  args.push('--no-context-files');

  if (options.model?.trim()) {
    args.push('--model', options.model.trim());
  }

  args.push(

    '--tools', 'mcp',
    '--exclude-tools', 'bash,read,edit,write,fffind,ffgrep,grep,find,ls,context_tree_query,subagent,subagent_wait,subagent_supervisor,preview_export,studio_repl_send,studio_repl_status,studio_export_pdf,studio_export_html,ask_user_question,source_check,get_search_content,fetch_content',
  );

  if (options.sessionId && !options.rebuildContext) {
    args.push('--session-id', options.sessionId);
  } else {
    args.push('--no-session');
  }

  if (options.systemPrompt?.trim()) {
    args.push('--append-system-prompt', options.systemPrompt.trim());
  }

  let mcpConfigFile: string | null = null;
  if (options.mcpServerUrl) {
    // 写入临时的独立 MCP 配置文件，并使用 --mcp-config 显式指定，彻底隔离用户全局 ~/.pi/mcp.json（如 openreel/codegraph 等）
    const tmpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/.mcp-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    mcpConfigFile = path.resolve(tmpDir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(mcpConfigFile, JSON.stringify({
      mcpServers: {
        director: {
          url: options.mcpServerUrl,
        },
      },
    }, null, 2), 'utf8');
    args.push('--mcp-config', mcpConfigFile);
  }

  // 虚构对话历史：构建为真实交替 user/assistant 消息，经动态生成的 Pi 扩展
  // 在每次 LLM 调用前注入请求头部（参考 custom-first-control-prompt 的请求路径注入：
  // 零会话日志写入、字节级一致保持前缀缓存复用）。扩展文件随进程结束一并清理。
  let seedExtensionFile: string | null = null;
  const requestHistory = [
    ...(options.seedHistory ?? []),
    ...(options.contextHistory ?? []),
  ];
  if (requestHistory.length > 0) {
    seedExtensionFile = writeSeedExtension(requestHistory);
    if (seedExtensionFile) {
      args.push('--extension', seedExtensionFile);
    }
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(options.env ?? {}),
  };
  const cleanupMcpConfig = () => {
    if (mcpConfigFile) {
      try {
        fs.rmSync(mcpConfigFile, { force: true });
      } catch {
        // 清理失败不应覆盖 Agent 的原始结果
      }
      mcpConfigFile = null;
    }
    if (seedExtensionFile) {
      try {
        fs.rmSync(seedExtensionFile, { force: true });
      } catch {
        // 清理失败不应覆盖 Agent 的原始结果
      }
      seedExtensionFile = null;
    }
  };

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('pi', args, {
        cwd: options.cwd ?? process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      cleanupMcpConfig();
      onEvent({ type: 'error', error: errorMsg });
      onEvent({ type: 'end' });
      return resolve({ exitCode: -1, error: errorMsg });
    }

    const emitEvent = (event: AgentStreamEvent) => {
      onEvent(event);
    };

    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3000).unref();
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      });
    }

    // 写入用户 prompt
    child.stdin?.write(prompt);
    child.stdin?.end();

    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      resetIdleTimer();
      try {
        const json = JSON.parse(trimmed);
        if (handlePiJsonEvent(json, emitEvent)) {
          child.kill('SIGTERM');
        }
      } catch {
        // 非 JSON 行降级为 text delta
        emitEvent({ type: 'text', delta: line + '\n' });
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuffer += d.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanupMcpConfig();
      emitEvent({ type: 'end' });
      resolve({
        exitCode: code,
        error: code !== 0 && stderrBuffer ? stderrBuffer : undefined,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      cleanupMcpConfig();
      emitEvent({ type: 'error', error: err.message });
      emitEvent({ type: 'end' });
      resolve({ exitCode: -1, error: err.message });
    });
  });
}

/** 将 Pi 不同版本返回的工具参数统一为对象。 */
function normalizeToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非 JSON 字符串参数保持为空对象，避免阻断 Agent 流
    }
  }
  return {};
}

/**
 * 为工具调用生成稳定指纹：优先使用 Pi 的调用 ID；无 ID 时按名称和参数排序序列化。
 * 用于过滤同一调用同时以 tool_execution_start/tool_call 到达的重复事件。
 */
export function toolCallFingerprint(tool: {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}): string {
  if (tool.id) return `id:${tool.id}`;

  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  return `args:${tool.name}:${stable(tool.args ?? {})}`;
}

/**
 * 解析 Pi CLI --mode json 产生的事件
 */
export function handlePiJsonEvent(json: Record<string, unknown>, onEvent: (event: AgentStreamEvent) => void): boolean {
  if (json.type === 'agent_end') {
    return true;
  }

  if (json.type === 'message_end') {
    const message = json.message as Record<string, unknown> | undefined;
    if (message?.role === 'assistant' && message.stopReason === 'error') {
      const errorMessage = message.errorMessage;
      onEvent({
        type: 'error',
        error: typeof errorMessage === 'string' && errorMessage ? errorMessage : 'Agent 响应失败',
      });
    }
    return false;
  }

  // 1. 处理流式增量事件 (message_update -> text_delta / thinking_delta)
  if (json.type === 'message_update') {
    const ame = json.assistantMessageEvent as Record<string, unknown> | undefined;
    if (ame) {
      if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
        onEvent({ type: 'text', delta: ame.delta });
        return false;
      }
      if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
        onEvent({ type: 'thinking', delta: ame.delta });
        return false;
      }
    }
  }

  // 2. 处理标准 toolCall / toolResult。Pi 某些 MCP 版本会把工具包装成
  // mcp({ tool: 'director_generation_submit', args: { ... } })。
  if (json.type === 'tool_execution_start' || json.type === 'tool_call') {
    const rawName = String(json.toolName || json.name || json.tool || '');
    const rawArgs = normalizeToolArgs(json.args ?? json.arguments);
    const wrappedTool = rawName === 'mcp' && typeof rawArgs.tool === 'string'
      ? rawArgs.tool
      : undefined;
    const normalizedName = wrappedTool
      ? wrappedTool.replace(/^director_/, '').replace(/_/g, '.')
      : rawName;
    const normalizedArgs = wrappedTool ? normalizeToolArgs(rawArgs.args) : rawArgs;
    onEvent({
      type: 'tool_call',
      tool: {
        id: (json.toolCallId || json.id || '') as string,
        name: normalizedName,
        args: normalizedArgs,
      },
    });
    return false;
  }

  if (json.type === 'tool_execution_end' || json.type === 'tool_result') {
    onEvent({
      type: 'tool_result',
      result: {
        id: (json.toolCallId || json.id || '') as string,
        name: (json.toolName || json.name || json.tool) as string,
        content: json.result ?? json.content,
      },
    });
    return false;
  }

  // 3. 处理整条 message。不同 Pi 版本可能将内容放在 message.content 或顶层 content。
  if (json.type === 'message') {
    const message = (json.message && typeof json.message === 'object' ? json.message : json) as Record<string, unknown>;
    const content = message.content ?? json.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item.type === 'thinking' && typeof item.thinking === 'string') {
          onEvent({ type: 'thinking', delta: item.thinking });
        } else if (item.type === 'text' && typeof item.text === 'string') {
          onEvent({ type: 'text', delta: item.text });
        }
      }
      return false;
    }
    if (typeof content === 'string') {
      onEvent({ type: 'text', delta: content });
    }
    if (typeof message.thinking === 'string') {
      onEvent({ type: 'thinking', delta: message.thinking });
    }
    return false;
  }

  if (json.type === 'thinking') {
    onEvent({ type: 'thinking', delta: String(json.delta ?? json.content ?? '') });
    return false;
  }

  if (json.type === 'text') {
    onEvent({ type: 'text', delta: String(json.delta ?? json.content ?? '') });
    return false;
  }

  if (json.type === 'error') {
    onEvent({ type: 'error', error: String(json.error ?? json.message ?? 'Unknown agent error') });
  }
  return false;
}
