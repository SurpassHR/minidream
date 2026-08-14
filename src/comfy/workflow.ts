import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DirectorError, type DirectorNode } from '../types.js';

const TEMPLATE_DIR = join(process.cwd(), 'workflows');

function replaceVars(value: unknown, vars: Record<string, string | number | boolean>, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    // 整个字符串是单个占位符（如 "${width}"）时保留原始类型（number/boolean），
    // 混合文本（如 "a${b}c"）按文本替换为字符串
    const single = /^\$\{([^}]+)\}$/.exec(value);
    if (single) {
      const name = single[1]!;
      if (!(name in vars)) {
        missing.add(name);
        return '';
      }
      return vars[name];
    }
    return value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
      if (!(name in vars)) {
        missing.add(name);
        return '';
      }
      return String(vars[name]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => replaceVars(v, vars, missing));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceVars(v, vars, missing);
    }
    return out;
  }
  return value;
}

export function buildWorkflow(
  templateName: string,
  vars: Record<string, string | number | boolean>,
): Record<string, unknown> {
  const p = join(TEMPLATE_DIR, `${templateName}.template.json`);
  let template: unknown;
  try {
    template = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new DirectorError('FILE_CONFLICT', `模板不存在: ${templateName}`);
  }
  const missing = new Set<string>();
  const wf = replaceVars(template, vars, missing) as Record<string, unknown>;
  if (missing.size > 0) {
    throw new DirectorError('INVALID_PATCH', `模板变量缺失: ${[...missing].join(', ')}`);
  }
  return wf;
}

export function paramsToVars(node: DirectorNode): Record<string, string | number | boolean> {
  const params = node.fields.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}
