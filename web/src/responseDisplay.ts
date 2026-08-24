export function shouldRenderLegacyAssistantContent(
  content: string,
  responseProtocolActive: boolean,
  hasResponseBlocks: boolean,
): boolean {
  return Boolean(content) && !responseProtocolActive && !hasResponseBlocks;
}
