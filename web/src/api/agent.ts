// agent 流式对话：POST /api/agent/chat（SSE），分块回调渲染
export interface AgentChip {
  name: string;
  content: string;
}

// 读取 text/event-stream，逐帧解析 `data: {...}`，`data: [DONE]` 结束
// model 可选：透传给 pi --model（如 "mustore/grok-4.5"）；thinking 可选：透传给 pi --thinking
// （off/minimal/low/medium/high/xhigh/max）
export async function agentChat(
  message: string,
  chips: AgentChip[],
  onChunk: (text: string) => void,
  model?: string,
  thinking?: string,
): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, chips, model, thinking }),
  });
  if (!res.ok || !res.body) throw new Error(`agent 请求失败: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!frame.startsWith('data: ')) continue;
      const payload = frame.slice(6);
      if (payload === '[DONE]') return;
      try {
        onChunk((JSON.parse(payload) as { chunk: string }).chunk);
      } catch {
        // 忽略坏帧
      }
    }
  }
}
