import { describe, expect, it } from 'vitest';
import { DirectorError } from './types.js';

describe('DirectorError', () => {
  it('携带错误码与消息', () => {
    const err = new DirectorError('NODE_NOT_FOUND', '节点不存在: n1');
    expect(err.code).toBe('NODE_NOT_FOUND');
    expect(err.name).toBe('DirectorError');
    expect(err.message).toContain('n1');
  });
});
