import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar, { type FSWatcher } from 'chokidar';
import { mappedFile } from '../sync/dual-writer.js';
import { loadGraph } from '../graph/graph-store.js';
import { onGraphChanged, applyMutation } from './mutations.js';
import { onTaskChanged } from '../generation/queue.js';

const clients = new Set<WebSocket>();

export interface WsHandle {
  close: () => Promise<void>;
  ready: Promise<void>; // chokidar 初始扫描完成（避免初始化前变更丢失）
  // 切换监视目录（项目热切换）：关闭旧 watcher → 以新目录重建 → 等初始扫描完成
  switchDir: (dir: string) => Promise<void>;
}

// 项目热切换后 watcher 需要跟随新的 projectDir；用 getProjectDir 访问器保持
// 与 mountRoutes 共享的同一可变上下文（单一事实来源），避免两处各自维护副本。
export function registerWs(server: http.Server, getProjectDir: () => string): WsHandle {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  onGraphChanged((graph) => {
    const payload = JSON.stringify({ type: 'graph', graph });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  // 生成任务状态变更 → WS 广播 generation 事件（前端队列面板实时更新）
  onTaskChanged((task) => {
    const payload = JSON.stringify({ type: 'generation', task });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  let projectDir = getProjectDir();
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });

  function buildWatcher(dir: string): FSWatcher {
    // 外部文件变更 → 回填前先比较内容：本进程双写引起的回环（内容一致）跳过一切处理，
    // 避免噪声快照与 version 双增；只有内容确实不同（真正的外部修改）才走
    // applyMutation 回填（保证快照留痕）并广播 file-changed。
    // DIRECTOR_WATCH_POLLING=1 时启用轮询（vitest 等收不到 inotify 事件的环境用）
    const w: FSWatcher = chokidar.watch(dir, {
      ignored: [/[.]director/, /out/, /node_modules/, /[.]git/],
      ignoreInitial: true,
      usePolling: process.env.DIRECTOR_WATCH_POLLING === '1',
    });
    w.on('change', (absPath) => {
      const rel = absPath.slice(dir.length + 1);
      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf8');
      } catch {
        return; // 非文本或读取失败：跳过
      }
      const graph = loadGraph(dir);
      const node = graph.nodes.find((n) => mappedFile(n) === rel);
      if (!node) {
        // 无映射节点：无回填对象，仅广播 file-changed（不产生空快照）
        const payload = JSON.stringify({ type: 'file-changed', path: rel });
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        }
        return;
      }
      // 回环检测：节点内容与文件内容一致（本进程双写落盘）→ 跳过
      if (typeof node.fields.content === 'string' && node.fields.content === fileContent) {
        return;
      }
      applyMutation(dir, 'user', `外部修改 ${rel}`, (g) => {
        const n = g.nodes.find((x) => mappedFile(x) === rel);
        if (n) {
          n.fields.content = fileContent;
          n.version += 1;
        }
      });
      const payload = JSON.stringify({ type: 'file-changed', path: rel });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    });
    return w;
  }

  let watcher = buildWatcher(projectDir);
  watcher.on('ready', () => resolveReady());

  return {
    ready,
    close: async () => {
      await watcher.close();
      wss.close();
    },
    switchDir: async (dir: string) => {
      await watcher.close();
      projectDir = dir;
      const next = buildWatcher(dir);
      watcher = next;
      await new Promise<void>((resolve) => {
        next.on('ready', () => resolve());
      });
    },
  };
}
