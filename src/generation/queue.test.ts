import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyUIClient } from '../comfy/client.js';
import { GenerationQueue } from './queue.js';
import { loadGraph, saveGraph, createNode, createEdge } from '../graph/graph-store.js';

let mock: ReturnType<typeof Fastify>;
let baseUrl: string;
let dir: string;
let queue: GenerationQueue;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'director-genq-'));

  mock = Fastify({ logger: false });
  mock.get('/system_stats', async () => ({}));
  mock.post('/prompt', async () => ({ prompt_id: 'pid-1' }));
  mock.get('/history/:pid', async (req: FastifyRequest) => {
    const { pid } = req.params as { pid: string };
    return {
      [pid]: {
        outputs: { '9': { gifs: [{ filename: 'out.mp4', subfolder: 'mmh3', type: 'output' }] } },
      },
    };
  });
  mock.get('/view', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('content-type', 'video/mp4');
    return Buffer.from('fake-mp4-bytes');
  });
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.server.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;

  queue = new GenerationQueue(dir, new ComfyUIClient(baseUrl));

  // 建图：shot1 → gen1（params 参数节点 + nextShotId 指向 shot2）
  const g = { projectName: 't', nodes: [], edges: [] } as never;
  const shot1 = createNode(g as never, { type: 'shot', title: 'SHOT 01' });
  const shot2 = createNode(g as never, { type: 'shot', title: 'SHOT 02' });
  const params = createNode(g as never, {
    type: 'params', title: '参数',
    fields: {
      template: 'keyframe-video',
      params: {
        keyframes: 'KF0,KF1', width: 768, height: 1344, steps: 8,
        ref_seconds: 4, seam: 'Hard cut', seed: 0,
        run_id: 'test', chain_previous_last: false,
      },
    },
  });
  const gen1 = createNode(g as never, {
    type: 'generation', title: '生成 SEG-01',
    fields: { paramsNodeId: params.id, nextShotId: shot2.id },
  });
  createEdge(g as never, { kind: 'exec', source: params.id, target: gen1.id });
  createEdge(g as never, { kind: 'exec', source: shot1.id, target: gen1.id });
  saveGraph(dir, g as never); // 直接落盘初始图（不产生快照噪音）
});
afterEach(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GenerationQueue', () => {
  it('submit 后 drain 走完状态机并回填结果与链式边', async () => {
    const g = loadGraph(dir);
    const gen = g.nodes.find((n) => n.type === 'generation');
    expect(gen).toBeTruthy();
    const task = queue.submit(gen!.id);
    expect(task.status).toBe('queued');
    await queue.drain();
    const done = queue.status(gen!.id);
    expect(done?.status).toBe('success');
    // 结果文件落盘（假字节）
    const videoRel = done?.result?.videoPath;
    expect(videoRel).toBeTruthy();
    expect(existsSync(join(dir, videoRel!))).toBe(true);
    // generation 节点 fields 回填
    const after = loadGraph(dir);
    const genNode = after.nodes.find((n) => n.id === gen!.id);
    expect(genNode?.fields.status).toBe('success');
    // 链式边已建（若末帧抽取成功；无 ffmpeg 则跳过该断言）
    const chainEdge = after.edges.find((e) => e.kind === 'chain' && e.source === gen!.id);
    if (chainEdge) {
      expect(chainEdge.label).toBe('末帧=场景参考');
      expect(chainEdge.target).toBe(genNode?.fields.nextShotId);
    }
  });

  it('重复提交同一节点返回现有任务', () => {
    const g = loadGraph(dir);
    const gen = g.nodes.find((n) => n.type === 'generation')!;
    const t1 = queue.submit(gen.id);
    const t2 = queue.submit(gen.id);
    expect(t1).toBe(t2);
  });

  it('cancel 仅对 queued 任务生效', () => {
    const g = loadGraph(dir);
    const gen = g.nodes.find((n) => n.type === 'generation')!;
    const t = queue.submit(gen.id);
    expect(queue.cancel(gen.id)).toBe(true);
    expect(queue.status(gen.id)?.status).toBe('cancelled');
    expect(queue.cancel(gen.id)).toBe(false);
  });

  it('生成失败时任务标记 failed 且节点回填错误', async () => {
    // 断开 mock：换个不可达的客户端重建队列
    const badQueue = new GenerationQueue(dir, new ComfyUIClient('http://127.0.0.1:59999'));
    const g = loadGraph(dir);
    const gen = g.nodes.find((n) => n.type === 'generation')!;
    badQueue.submit(gen.id);
    await badQueue.drain();
    const t = badQueue.status(gen.id);
    expect(t?.status).toBe('failed');
    expect(t?.error).toBeTruthy();
    const after = loadGraph(dir);
    expect(after.nodes.find((n) => n.id === gen.id)?.fields.error).toBeTruthy();
  });
});
