// MMH3 Prompt YAML 协议（v1）—— 与 ComfyUI 仓库 docs/mmh3-prompt-yaml-protocol.md 一致。
// 三方共享：mmh3 提示词 skill（写）、director-workbench（编排/校验）、
// ComfyUI-MiniMax-H3-Long-Video 节点 MMH3PromptYamlTest（解析）。

export const PROMPT_YAML_VERSION = 1;
export const MAX_SEG_PROMPTS = 64;

export interface PromptSegment {
  shot?: number;
  title?: string;
  keyframes?: string[];
  duration?: number; // 秒；全有或全无
  prompt: string;    // 必填：本段英文 H3 提示词
}

export interface PromptProtocolV1 {
  version?: number;
  project?: string;
  mode?: string;
  prompt?: string;          // 共享/全局 prompt
  segments?: PromptSegment[];
}

export interface ProtocolValidation {
  ok: boolean;
  errors: string[];
  segments: number;
  hasDurations: boolean;
  sharedPrompt: string;
}

// 结构校验：镜像 ComfyUI core/prompt_yaml.py 的 parse_prompt_yaml 规则。
// 输入应是已解析后的对象（JSON 或经 YAML 解析器得到），不含 YAML 语法层错误。
export function validatePromptProtocol(doc: unknown): ProtocolValidation {
  const res: ProtocolValidation = {
    ok: true, errors: [], segments: 0, hasDurations: false, sharedPrompt: '',
  };
  if (doc === undefined || doc === null) return res;
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    res.ok = false;
    res.errors.push('顶层必须是对象（mapping）');
    return res;
  }
  const d = doc as Record<string, unknown>;
  const version = d.version;
  if (version !== undefined && version !== PROMPT_YAML_VERSION) {
    res.ok = false;
    res.errors.push('不支持的版本：' + String(version));
    return res;
  }
  const prompt = d.prompt;
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') {
      res.ok = false;
      res.errors.push('prompt 必须是字符串');
    } else {
      res.sharedPrompt = prompt;
    }
  }
  const segments = d.segments;
  if (segments === undefined || segments === null) return res;
  if (!Array.isArray(segments)) {
    res.ok = false;
    res.errors.push('segments 必须是数组');
    return res;
  }
  if (segments.length > MAX_SEG_PROMPTS) {
    res.ok = false;
    res.errors.push('分段数超过上限 ' + MAX_SEG_PROMPTS);
  }
  const durations: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const item = segments[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      res.ok = false;
      res.errors.push('分段 ' + (i + 1) + ' 必须是对象');
      continue;
    }
    const s = item as Record<string, unknown>;
    const p = s.prompt;
    if (typeof p !== 'string' || p.trim() === '') {
      res.ok = false;
      res.errors.push('分段 ' + (i + 1) + ' 缺少非空 prompt');
      continue;
    }
    res.segments += 1;
    const dur = s.duration !== undefined ? s.duration : s.seconds;
    if (dur !== undefined && dur !== null) {
      if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) {
        res.ok = false;
        res.errors.push('分段 ' + (i + 1) + ' 的 duration 必须是正数');
      } else {
        durations.push(dur);
      }
    }
  }
  res.hasDurations = durations.length > 0;
  if (res.hasDurations && durations.length !== res.segments) {
    res.ok = false;
    res.errors.push('duration 必须全有或全无');
  }
  return res;
}

function yamlQuote(s: string): string {
  if (s === '') return '""';
  if (/^[a-zA-Z0-9_-]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// YAML block scalar（|），缩进 indent 空格；空文本退化为空串标量。
function blockScalar(value: string, indent: number): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '""';
  const pad = ' '.repeat(indent);
  return '|' + '\n' + lines.map((l) => pad + l).join('\n');
}

// 把分段/共享提示词序列化为协议 YAML 文本（无第三方依赖，纯手写 emitter）。
export function promptYamlFromSegments(input: {
  project?: string;
  mode?: string;
  prompt?: string;
  segments?: PromptSegment[];
}): string {
  const out: string[] = [];
  out.push('version: ' + PROMPT_YAML_VERSION);
  if (input.project !== undefined && input.project !== '') {
    out.push('project: ' + yamlQuote(input.project));
  }
  if (input.mode !== undefined && input.mode !== '') {
    out.push('mode: ' + yamlQuote(input.mode));
  }
  if (input.prompt !== undefined && input.prompt !== '') {
    out.push('prompt: ' + blockScalar(input.prompt, 2));
  }
  const segs = input.segments;
  if (segs !== undefined && segs.length > 0) {
    out.push('segments:');
    for (const s of segs) {
      const keys: Array<[string, string]> = [];
      if (s.shot !== undefined) keys.push(['shot', String(s.shot)]);
      if (s.title !== undefined && s.title !== '') keys.push(['title', yamlQuote(s.title)]);
      if (s.keyframes !== undefined && s.keyframes.length > 0) {
        keys.push(['keyframes', '[' + s.keyframes.map(yamlQuote).join(', ') + ']']);
      }
      if (s.duration !== undefined) keys.push(['duration', String(s.duration)]);
      keys.push(['prompt', blockScalar(s.prompt, 6)]);
      const first = keys[0];
      if (first) {
        out.push('  - ' + first[0] + ': ' + first[1]);
        for (let i = 1; i < keys.length; i++) {
          const kv = keys[i];
          if (kv) out.push('    ' + kv[0] + ': ' + kv[1]);
        }
      }
    }
  }
  return out.join('\n') + '\n';
}
