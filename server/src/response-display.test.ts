import { describe, expect, it } from 'vitest';
import { shouldRenderLegacyAssistantContent } from '../../web/src/responseDisplay.js';

describe('shouldRenderLegacyAssistantContent', () => {
  it('hides raw Agent content whenever a response protocol is active', () => {
    expect(shouldRenderLegacyAssistantContent('Agent 原始正文', true, true)).toBe(false);
    expect(shouldRenderLegacyAssistantContent('Agent 原始正文', true, false)).toBe(false);
  });

  it('hides raw Agent content when custom response blocks exist', () => {
    expect(shouldRenderLegacyAssistantContent('Agent 原始正文', false, true)).toBe(false);
  });

  it('keeps legacy content when no response protocol is active', () => {
    expect(shouldRenderLegacyAssistantContent('Agent 原始正文', false, false)).toBe(true);
    expect(shouldRenderLegacyAssistantContent('', false, false)).toBe(false);
  });
});
