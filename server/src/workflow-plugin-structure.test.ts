import { describe, expect, it } from 'vitest';
import { validateManifestStructure } from './workflow-plugin-api.js';
import { mergeRedetectedSpec } from './workflow-catalog.js';
import type { WorkflowSpec } from './workflow.js';

function baseSpec(): WorkflowSpec {
  return {
    id: 'demo',
    name: 'Demo',
    inputs: [{ id: 'prompt', kind: 'text', label: '提示词', nodeId: '1', field: 'text', classType: 'CLIPTextEncode' }],
    params: [{ id: 'steps', label: '步数', nodeId: '2', field: 'steps', type: 'INT', default: 20, applyTo: ['3'] }],
    outputs: [{ id: 'image', kind: 'image', label: '图片', nodeId: '4', classType: 'SaveImage' }],
  };
}

describe('workflow manifest structural contract', () => {
  it('允许修改描述元数据和参数值', () => {
    const previous = baseSpec();
    const next = structuredClone(previous);
    next.inputs[0]!.description = '新的用途';
    next.inputs[0]!.required = false;
    next.params[0]!.default = 28;
    expect(validateManifestStructure(previous, next)).toBeNull();
  });

  it('固定输入输出数量但允许 params 增删', () => {
    const previous = baseSpec();
    const addedInput = structuredClone(previous);
    addedInput.inputs.push({ id: 'extra', kind: 'image', label: '额外', nodeId: '5', field: 'image', classType: 'LoadImage' });
    expect(validateManifestStructure(previous, addedInput)).toMatch(/inputs.*数量/);

    const removedOutput = structuredClone(previous);
    removedOutput.outputs = [];
    expect(validateManifestStructure(previous, removedOutput)).toMatch(/outputs.*数量/);

    const removedParam = structuredClone(previous);
    removedParam.params = [];
    expect(validateManifestStructure(previous, removedParam)).toBeNull();

    const addedParam = structuredClone(previous);
    addedParam.params.push({ id: 'cfg', label: 'CFG', nodeId: '5', field: 'cfg', type: 'FLOAT', default: 7 });
    expect(validateManifestStructure(previous, addedParam)).toBeNull();
  });

  it('仍拒绝修改 inputs/outputs 节点结构，但 params 的结构由 graph 校验', () => {
    const previous = baseSpec();
    const changed = structuredClone(previous);
    changed.inputs[0]!.nodeId = '9';
    expect(validateManifestStructure(previous, changed)).toMatch(/inputs.*结构/);

    const changedParam = structuredClone(previous);
    changedParam.params[0]!.applyTo = ['8'];
    expect(validateManifestStructure(previous, changedParam)).toBeNull();
  });

  it('重新识别只更新已有映射，不改变映射数量或结构', () => {
    const previous = baseSpec();
    const detected = structuredClone(previous);
    detected.inputs.push({ id: 'new-input', kind: 'image', label: '新输入', nodeId: '5', field: 'image', classType: 'LoadImage' });
    previous.params[0]!.description = '用户说明';
    previous.params[0]!.default = 28;
    previous.params[0]!.min = 1;
    previous.params[0]!.max = 80;
    detected.params[0]!.default = 42;

    const merged = mergeRedetectedSpec(previous, detected);
    expect(merged.inputs).toHaveLength(previous.inputs.length);
    expect(merged.params).toHaveLength(previous.params.length);
    expect(merged.inputs[0]).toMatchObject({ id: 'prompt', nodeId: '1', field: 'text' });
    expect(merged.params[0]).toMatchObject({ id: 'steps', nodeId: '2', field: 'steps', default: 28, min: 1, max: 80, description: '用户说明' });
  });
});
