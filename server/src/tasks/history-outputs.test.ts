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
});
