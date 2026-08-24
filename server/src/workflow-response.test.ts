import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowSpec } from './workflow.js';
import {
  defaultPluginResponseProtocol,
  legacyPolicyToResponseProtocol,
  renderResponseBlocks,
  responseProtocolAllowsPrompt,
  renderResponseTemplate,
  validatePluginResponseProtocol,
  type PluginResponseContext,
  type PluginResponseProtocol,
  ensurePluginResponseProtocol,
  readPluginResponseProtocol,
  writePluginResponseProtocol,
} from './workflow-response.js';
import { DEFAULT_PLUGIN_RESPONSE_POLICY } from './workflow-skill.js';

const spec: WorkflowSpec = {
  id: 'demo',
  name: 'Demo 工作流',
  description: '用于测试',
  inputs: [
    { id: 'positive', kind: 'text', label: '正面提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode', primary: true },
    { id: 'hidden-input', kind: 'text', label: '内部输入', nodeId: '2', field: 'text', classType: 'Text', hidden: true },
  ],
  params: [
    { id: 'negative', label: '反面提示词', nodeId: '3', field: 'text', type: 'STRING', default: '', description: '不要出现的内容' },
    { id: 'width', label: '宽度', nodeId: '4', field: 'width', type: 'INT', default: 1024, llm: true },
    { id: 'internal', label: '内部参数', nodeId: '4', field: 'cfg', type: 'FLOAT', default: 7, llm: false },
  ],
  outputs: [{ id: 'image', kind: 'image', label: '图片', nodeId: '5', classType: 'SaveImage' }],
};

const context: PluginResponseContext = {
  plugin: { name: 'Demo 工作流', description: '用于测试' },
  input: { positive: '一只猫' },
  param: { negative: '模糊', width: 1536 },
  generation: {
    prompt: '一只猫，高清，电影感',
    negativePrompt: '模糊',
    workflowName: 'Demo 工作流',
    intent: 'text_to_image',
  },
  route: {
    requestedWorkflow: 'demo',
    finalWorkflow: 'demo',
    reason: 'Agent 选择',
  },
  result: { count: 1, types: 'image', status: 'completed' },
  assistant: { reply: '已完成。' },
};

describe('workflow response protocol', () => {
  it('默认协议保留兼容展示，并支持独立容器与内容格式', () => {
    const protocol = defaultPluginResponseProtocol();
    expect(protocol.version).toBe(1);
    expect(protocol.thinking).toMatchObject({ enabled: true, container: 'collapsible', format: 'plain' });
    expect(protocol.blocks.some(block => block.source === 'generation.prompt')).toBe(true);
    expect(protocol.result).toEqual({ display: 'outside-bubble' });
  });

  it('允许可折叠代码块，但拒绝隐藏或 llm:false widget 占位符', () => {
    const valid: PluginResponseProtocol = {
      version: 1,
      thinking: { enabled: false, container: 'collapsible', format: 'plain', defaultOpen: false },
      blocks: [{
        id: 'negative',
        type: 'field',
        source: 'param.negative',
        label: '反面提示词',
        container: 'collapsible',
        format: 'code',
        language: 'text',
        timing: 'submit',
      }],
      result: { display: 'outside-bubble' },
    };
    expect(validatePluginResponseProtocol(valid, spec)).toEqual([]);

    const invalid: PluginResponseProtocol = {
      ...valid,
      blocks: [
        { ...valid.blocks[0]!, id: 'hidden', source: 'input.hidden-input' },
        { ...valid.blocks[0]!, id: 'internal', source: 'param.internal' },
        { ...valid.blocks[0]!, id: 'unknown', source: 'param.missing' },
      ],
    };
    expect(validatePluginResponseProtocol(invalid, spec)).toEqual(expect.arrayContaining([
      expect.stringMatching(/hidden-input/),
      expect.stringMatching(/internal/),
      expect.stringMatching(/missing/),
    ]));
  });

  it('自定义协议没有引用提示词时不允许任务元数据展示提示词', () => {
    const hidden = defaultPluginResponseProtocol();
    hidden.blocks = hidden.blocks.filter(block => block.source !== 'generation.prompt');
    expect(responseProtocolAllowsPrompt(hidden, spec)).toBe(false);
    const visible = defaultPluginResponseProtocol();
    expect(responseProtocolAllowsPrompt(visible, spec)).toBe(true);
  });

  it('模板和块类型不能绕过占位符来源白名单', () => {
    const templateProtocol: PluginResponseProtocol = {
      ...defaultPluginResponseProtocol(),
      blocks: [{ id: 'template', type: 'template', template: '{{tool.result}}', container: 'text', format: 'plain', timing: 'always' }],
    };
    expect(validatePluginResponseProtocol(templateProtocol, spec)).toContain('blocks[0].template 占位符无效：tool.result');

    const wrongAssistantProtocol: PluginResponseProtocol = {
      ...defaultPluginResponseProtocol(),
      blocks: [{ id: 'assistant', type: 'assistant-reply', source: 'generation.prompt', container: 'text', format: 'plain', timing: 'always' }],
    };
    expect(validatePluginResponseProtocol(wrongAssistantProtocol, spec)).toContain('blocks[0].source 必须为 assistant.reply');
  });

  it('只替换白名单占位符，并支持 default 过滤器', () => {
    expect(renderResponseTemplate(
      '正面：{{input.positive}}\n反面：{{param.negative | default:"未设置"}}\n内部：{{param.internal}}',
      context,
    )).toBe('正面：一只猫\n反面：模糊\n内部：');
    expect(renderResponseTemplate('{{param.missing | default:"未设置"}}', context)).toBe('未设置');
    expect(renderResponseTemplate('{{tool.result}} {{__proto__.polluted}}', context)).toBe(' ');
  });

  it('按时机渲染结构化回复块，并保留协议顺序', () => {
    const protocol: PluginResponseProtocol = {
      version: 1,
      thinking: { enabled: true, container: 'collapsible', format: 'plain', defaultOpen: false },
      blocks: [
        { id: 'submit', type: 'field', source: 'param.width', label: '宽度', container: 'text', format: 'plain', timing: 'submit' },
        { id: 'complete', type: 'template', template: '结果：{{result.count}}', container: 'collapsible', format: 'code', language: 'text', defaultOpen: true, timing: 'complete' },
        { id: 'always', type: 'assistant-reply', source: 'assistant.reply', container: 'text', format: 'markdown', timing: 'always' },
      ],
      result: { display: 'outside-bubble' },
    };
    expect(renderResponseBlocks(protocol, context, 'submit')).toEqual([        expect.objectContaining({ id: 'submit', order: 0, content: '1536', container: 'text', format: 'plain' }),
      expect.objectContaining({ id: 'always', content: '已完成。', format: 'markdown' }),
    ]);
    expect(renderResponseBlocks(protocol, context, 'complete')).toEqual([
      expect.objectContaining({ id: 'complete', order: 1, content: '结果：1', container: 'collapsible', format: 'code', defaultOpen: true }),
      expect.objectContaining({ id: 'always', order: 2, content: '已完成。' }),
    ]);
  });

  it('缺失 response.json 时按 Skill 旧策略补齐协议且不覆盖有效自定义协议', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'response-protocol-'));
    try {
      const skillRoot = path.join(root, 'skills');
      fs.mkdirSync(path.join(skillRoot, 'demo'), { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'demo', 'SKILL.md'), '---\nresponse:\n  prompt: hidden\n  route: visible\n---\n', 'utf8');
      const first = ensurePluginResponseProtocol('demo', spec, skillRoot);
      expect(first.blocks.some(block => block.source === 'generation.prompt')).toBe(false);
      expect(readPluginResponseProtocol('demo', skillRoot)).toEqual(first);
      const custom = { ...first, blocks: first.blocks.slice(0, 1) };
      writePluginResponseProtocol('demo', custom, skillRoot);
      expect(ensurePluginResponseProtocol('demo', spec, skillRoot)).toEqual(custom);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('旧版 response policy 转换为兼容协议', () => {
    const protocol = legacyPolicyToResponseProtocol({ ...DEFAULT_PLUGIN_RESPONSE_POLICY, prompt: 'hidden', route: 'visible' });
    expect(protocol.thinking).toMatchObject({ enabled: true, container: 'collapsible', defaultOpen: false });
    expect(protocol.blocks.some(block => block.source === 'generation.prompt')).toBe(false);
    expect(protocol.blocks.some(block => block.source === 'route.finalWorkflow')).toBe(true);
  });
});
