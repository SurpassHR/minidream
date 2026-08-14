import type { WsEvent } from '../types';

export interface ConnectWsHooks {
  onOpen?: () => void;
  onClose?: () => void;
}

// 连接 WS；断线 3 秒自动重连（指数退避：3s→6s→12s→上限 30s）；返回断开函数
export function connectWs(onEvent: (ev: WsEvent) => void, hooks: ConnectWsHooks = {}): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 3000;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retryMs = 3000; // 连接成功重置退避
      hooks.onOpen?.();
    };
    ws.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data as string) as WsEvent); } catch { /* 忽略坏消息 */ }
    };
    ws.onclose = () => {
      hooks.onClose?.();
      if (!closed) {
        timer = setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000); // 指数退避，上限 30s
      }
    };
    ws.onerror = () => { ws?.close(); };
  };
  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
