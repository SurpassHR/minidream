import { describe, expect, it } from 'vitest';
import { buildWorkflow, paramsToVars } from './workflow.js';
import type { DirectorNode } from '../types.js';

describe('buildWorkflow', () => {
  it('替换模板占位符', () => {
    const wf = buildWorkflow('keyframe-video', {
      keyframes: 'KF0,KF1,KF2,KF3', width: 768, height: 1344, steps: 8,
      ref_seconds: 4, seam: 'Hard cut', seed: 0,
      run_id: 'elf_goblin_3shots', chain_previous_last: false,
    });
    const node = (wf as Record<string, { inputs: Record<string, unknown> }>)['1'];
    expect(node?.inputs.keyframes).toBe('KF0,KF1,KF2,KF3');
    expect(node?.inputs.width).toBe(768);
    expect(node?.inputs.chain_previous_last).toBe(false);
  });

  it('缺失变量抛错并列出缺失名', () => {
    expect(() => buildWorkflow('keyframe-video', { width: 768 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_PATCH' }),
    );
  });

  it('prompt-yaml 模板透传 YAML', () => {
    const yaml = 'version: 1\nsegments:\n  - prompt: a\n    duration: 3.04\n';
    const wf = buildWorkflow('prompt-yaml', { prompt_yaml: yaml });
    const node = (wf as Record<string, { class_type: string; inputs: Record<string, unknown> }>)['1'];
    expect(node?.class_type).toBe('MMH3PromptYamlTest');
    expect(node?.inputs.prompt_yaml).toBe(yaml);
  });

  it('未知模板抛 FILE_CONFLICT', () => {
    expect(() => buildWorkflow('no-such-template', {})).toThrowError(
      expect.objectContaining({ code: 'FILE_CONFLICT' }),
    );
  });
});

describe('paramsToVars', () => {
  it('拍平 params 节点字段', () => {
    const node: DirectorNode = {
      id: 'p1', type: 'params', title: '参数', version: 1, position: { x: 0, y: 0 },
      fields: {
        template: 'keyframe-video',
        params: {
          keyframes: 'KF0..KF3', width: 768, steps: 8,
          chain_previous_last: false, ignore_this: { nested: 'object' },
        },
      },
    };
    const vars = paramsToVars(node);
    expect(vars.keyframes).toBe('KF0..KF3');
    expect(vars.width).toBe(768);
    expect(vars.chain_previous_last).toBe(false);
    expect(vars.ignore_this).toBeUndefined(); // 嵌套对象被过滤
  });
});
