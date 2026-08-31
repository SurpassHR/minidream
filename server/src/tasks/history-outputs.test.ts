import { describe, expect, it } from 'vitest';
import { extractHistoryOutputs } from './history-outputs.js';

describe('history output extraction', () => {
  it('提取声明节点的文本输出并忽略内部节点', () => {
    const outputs = extractHistoryOutputs(
      {
        '9': { text: ['最终文本'] },
        '10': { text: ['内部文本'] },
      },
      [{ id: 'text-9', kind: 'text', label: '结果', nodeId: '9', classType: 'ShowText' }],
    );
    expect(outputs).toEqual([expect.objectContaining({ kind: 'text', text: '最终文本', filename: '9-1.txt' })]);
  });

  it('按输出映射类型识别被 ComfyUI 放在 images 键中的视频文件', () => {
    const outputs = extractHistoryOutputs(
      { '4': { images: [{ filename: 'generated.mp4', subfolder: 'video', type: 'output' }] } },
      [{ id: 'videos-4', kind: 'video', label: '视频', nodeId: '4', classType: 'SaveVideo' }],
    );

    expect(outputs).toEqual([expect.objectContaining({ kind: 'video', filename: 'generated.mp4' })]);
  });

  it('按输出端口提取数字和布尔结果，不生成媒体草稿', () => {
    const outputs = extractHistoryOutputs(
      {
        '7': { values: [12.5, true], types: ['FLOAT', 'BOOLEAN'] },
      },
      [
        { id: 'number-7-0', kind: 'number', label: '数值', nodeId: '7', classType: 'MathNode', slot: 0, type: 'FLOAT' },
        { id: 'boolean-7-1', kind: 'boolean', label: '开关', nodeId: '7', classType: 'MathNode', slot: 1, type: 'BOOLEAN' },
      ],
    );

    expect(outputs).toEqual([
      expect.objectContaining({ kind: 'number', value: 12.5, text: '12.5', filename: '7-1.number' }),
      expect.objectContaining({ kind: 'boolean', value: true, text: 'true', filename: '7-2.boolean' }),
    ]);
    expect(outputs.every(output => output.data === undefined)).toBe(true);
  });
});
