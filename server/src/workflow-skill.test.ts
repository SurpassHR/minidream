import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowSpec } from './workflow.js';
import {
  PLUGIN_SKILLS_DIR,
  deletePluginSkill,
  ensurePluginSkills,
  generatePluginSkill,
  pluginSkillPath,
  readPluginSkill,
  writePluginSkill,
} from './workflow-skill.js';

const baseSpec = (over: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
  id: 'test_plugin',
  name: '测试插件',
  description: '用于测试的插件',
  inputs: [
    { id: 'text-1', kind: 'text', label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode', primary: true },
    { id: 'image-2', kind: 'image', label: '参考图', nodeId: '2', field: 'image', classType: 'LoadImage', required: true },
    { id: 'hidden-text', kind: 'text', label: '内部文本', nodeId: '9', field: 'text', classType: 'CLIPTextEncode', hidden: true },
  ],
  params: [
    { id: 'steps-3', label: '采样步数', nodeId: '3', field: 'steps', type: 'INT', default: 20, min: 1, max: 150, step: 1, description: '越大细节越多' },
    { id: 'sampler-4', label: '采样器', nodeId: '4', field: 'sampler_name', type: 'combo', default: 'euler', options: ['euler', 'dpmpp_2m'], description: '采样器选择' },
    { id: 'lora-5', label: 'LoRA（多选）', nodeId: '5', field: 'lora', type: 'combo', default: [], multiple: true, strengthable: true, min: -2, max: 2, step: 0.1, applyTo: ['6', '7'] },
    { id: 'internal-cfg', label: '内部 CFG', nodeId: '4', field: 'cfg', type: 'FLOAT', default: 7, llm: false },
    { id: 'hidden-param', label: '隐藏参数', nodeId: '3', field: 'seed', type: 'SEED', default: 42, hidden: true },
  ],
  outputs: [
    { id: 'images-8', kind: 'image', label: '最终图片', nodeId: '8', classType: 'SaveImage' },
    { id: 'hidden-out', kind: 'text', label: '内部输出', nodeId: '9', classType: 'PreviewAny', hidden: true },
  ],
  ...over,
});

describe('generatePluginSkill', () => {
  it('包含 frontmatter 与自动生成标记', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/^---\nname: test_plugin/);
    expect(md).toContain('自动生成');
  });

  it('只暴露未隐藏且 llm !== false 的输入/参数/输出', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toContain('steps-3');
    expect(md).toContain('sampler-4');
    expect(md).toContain('lora-5');
    expect(md).not.toContain('internal-cfg');
    expect(md).not.toContain('hidden-param');
    expect(md).not.toContain('hidden-text');
    expect(md).not.toContain('hidden-out');
    expect(md).not.toContain('内部文本');
  });

  it('参数标注类型/默认值/范围/选项/applyTo 联动', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/steps-3.*整数/);
    expect(md).toMatch(/默认 20/);
    expect(md).toMatch(/1 ~ 150，步长 1/);
    expect(md).toMatch(/euler、dpmpp_2m/);
    expect(md).toMatch(/多选（每项可调强度）/);
    expect(md).toMatch(/同时作用于节点 6、7/);
    expect(md).toMatch(/越大细节越多/);
  });

  it('文本输入标注 primary，必传参考图生成使用规则', () => {
    const md = generatePluginSkill(baseSpec());
    expect(md).toMatch(/提示词/);
    expect(md).toMatch(/primary/);
    expect(md).toMatch(/必须按顺序传入 1 张参考图/);
  });

  it('无文本输入时推导"不接受提示词"规则', () => {
    const md = generatePluginSkill(baseSpec({ inputs: baseSpec().inputs.filter(i => i.kind !== 'text') }));
    expect(md).toMatch(/不接受提示词/);
  });

  it('combo 选项超过 8 个时截断展示', () => {
    const md = generatePluginSkill(baseSpec({
      params: [{ id: 'combo-1', label: '模型', nodeId: '1', field: 'model', type: 'combo', default: 'a', options: Array.from({ length: 12 }, (_, i) => `model${i}.safetensors`) }],
    }));
    expect(md).toMatch(/model0\.safetensors/);
    expect(md).toMatch(/…/);
    expect(md).not.toContain('model11.safetensors');
  });
});

describe('skill 文件读写', () => {
  it('writePluginSkill 原子写入并返回内容；readPluginSkill 读回', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      const spec = baseSpec();
      const content = writePluginSkill(spec, root);
      expect(readPluginSkill(spec.id, root)).toBe(content);
      expect(fs.existsSync(path.join(root, spec.id, 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletePluginSkill 删除文件，缺失时静默', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      writePluginSkill(baseSpec(), root);
      deletePluginSkill('test_plugin', root);
      expect(fs.existsSync(path.join(root, 'test_plugin', 'SKILL.md'))).toBe(false);
      expect(() => deletePluginSkill('test_plugin', root)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensurePluginSkills 只补齐缺失文件，不覆盖已有内容', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      const a = baseSpec();
      const b = baseSpec({ id: 'plugin_b' });
      writePluginSkill(a, root);
      const edited = '手工内容';
      fs.writeFileSync(pluginSkillPath(a.id, root), edited, 'utf8');
      ensurePluginSkills([a, b], root);
      expect(fs.readFileSync(pluginSkillPath(a.id, root), 'utf8')).toBe(edited);
      expect(fs.existsSync(pluginSkillPath(b.id, root))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法插件 ID 拒绝写入', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
    try {
      expect(() => writePluginSkill(baseSpec({ id: '../evil' }), root)).toThrow(/非法工作流插件 ID/);
      expect(() => pluginSkillPath('a b', root)).toThrow(/非法工作流插件 ID/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it('PLUGIN_SKILLS_DIR 指向仓库 .pi/skills', () => {
  expect(PLUGIN_SKILLS_DIR).toMatch(/\.pi\/skills$/);
});
