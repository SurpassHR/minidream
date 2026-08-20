import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { loadGraph } from '../graph/graph-store.js';
import { listSnapshots } from '../snapshots/snapshot-store.js';

let dir: string;
let a: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => {
  // vitest 环境收不到 inotify 事件，启用 chokidar 轮询以测试外部文件变更回填
  process.env.DIRECTOR_WATCH_POLLING = '1';
  dir = mkdtempSync(join(tmpdir(), 'director-api-'));
  mkdirSync(join(dir, 'mmh3'), { recursive: true });
  writeFileSync(join(dir, 'mmh3', 'shot_01.md'), '# SHOT 01\n牵绳慢步', 'utf8');
  a = buildApp({ projectDir: dir, comfyBaseUrl: 'http://127.0.0.1:59999', taskQueueFilePath: join(dir, '.director', 'tasks.json') });
});
afterEach(async () => {
  delete process.env.DIRECTOR_WATCH_POLLING;
  await a.close(); // 关闭 watcher/wss，避免测试挂起
  rmSync(dir, { recursive: true, force: true });
});

describe('API 节点', () => {
  it('POST /api/nodes 创建节点并落盘+快照', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'shot', title: 'SHOT 01', position: { x: 10, y: 20 } },
    });
    expect(res.statusCode).toBe(201);
    const node = res.json().node;
    expect(node.version).toBe(1);
    expect(loadGraph(dir).nodes).toHaveLength(1);
    expect(listSnapshots(dir)).toHaveLength(1);
  });

  it('PATCH 更新节点并双写映射文件', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'shot', title: 'SHOT 01', fields: { filename: 'shot_01.md', content: 'v1' } },
    });
    const id = created.json().node.id;
    const res = await a.inject({
      method: 'PATCH', url: `/api/nodes/${id}`,
      payload: { patch: { fields: { content: 'v2 新版' } } },
    });
    expect(res.json().node.version).toBe(2);
    expect(res.json().node.fields.content).toBe('v2 新版');
  });

  it('DELETE 无 confirm 返回 400', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'shot', title: 'S' },
    });
    const id = created.json().node.id;
    const res = await a.inject({ method: 'DELETE', url: `/api/nodes/${id}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFIRM_REQUIRED');
  });

  it('DELETE 带 confirm 删除并连带删边', async () => {
    const n1 = (await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } })).json().node;
    const n2 = (await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } })).json().node;
    await a.inject({ method: 'POST', url: '/api/edges', payload: { kind: 'ref', source: n1.id, target: n2.id } });
    const res = await a.inject({ method: 'DELETE', url: `/api/nodes/${n1.id}?confirm=true` });
    expect(res.statusCode).toBe(200);
    const g = loadGraph(dir);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});

describe('API 导入与快照', () => {
  it('POST /api/import 从文件创建节点', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/import',
      payload: { path: 'mmh3/shot_01.md', type: 'shot', title: 'SHOT 01' },
    });
    expect(res.statusCode).toBe(201);
    const node = res.json().node;
    expect(node.fields.filename).toBe('mmh3/shot_01.md');
    expect(node.fields.content).toContain('牵绳慢步');
  });

  it('POST /api/import 拒绝路径穿越', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/import',
      payload: { path: '../outside.md', type: 'shot', title: 'X' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FILE_CONFLICT');
  });

  it('POST /api/snapshots/rollback 免确认直接回滚，且不追加新快照', async () => {
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } });
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } });
    expect(listSnapshots(dir)).toHaveLength(2);
    const ok = await a.inject({
      method: 'POST', url: '/api/snapshots/rollback',
      payload: { seq: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(loadGraph(dir).nodes).toHaveLength(1);
    // 回滚不追加新快照（直接回到该快照）；未来快照保留
    expect(listSnapshots(dir)).toHaveLength(2);
    expect(ok.json().graph.nodes).toHaveLength(1);
  });

  it('POST /api/snapshots/undo 与 redo 切换 HEAD', async () => {
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } });
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } });
    const undo = await a.inject({ method: 'POST', url: '/api/snapshots/undo' });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().graph.nodes.map((n: { title: string }) => n.title)).toEqual(['A']);
    const redo = await a.inject({ method: 'POST', url: '/api/snapshots/redo' });
    expect(redo.statusCode).toBe(200);
    expect(redo.json().graph.nodes.map((n: { title: string }) => n.title)).toEqual(['A', 'B']);
    // 已到最新：redo 拒绝；已到最早：undo 拒绝
    const redoAgain = await a.inject({ method: 'POST', url: '/api/snapshots/redo' });
    expect(redoAgain.statusCode).toBe(400);
    await a.inject({ method: 'POST', url: '/api/snapshots/undo' });
    await a.inject({ method: 'POST', url: '/api/snapshots/undo' });
    const undoAgain = await a.inject({ method: 'POST', url: '/api/snapshots/undo' });
    expect(undoAgain.statusCode).toBe(400);
  });

  it('回滚后写操作覆盖未来快照需批准（409），批准后成功', async () => {
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } });
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } });
    await a.inject({ method: 'POST', url: '/api/snapshots/rollback', payload: { seq: 1 } });
    // 未批准：写操作被拒（409），图不变
    const denied = await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'C' } });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().code).toBe('SNAPSHOT_FUTURE_EXISTS');
    expect(loadGraph(dir).nodes.map((n) => n.title)).toEqual(['A']);
    // 批准后：覆盖成功
    await a.inject({ method: 'POST', url: '/api/snapshots/approve-overwrite' });
    const ok = await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'C' } });
    expect(ok.statusCode).toBe(201);
    expect(loadGraph(dir).nodes.map((n) => n.title)).toEqual(['A', 'C']);
    expect(listSnapshots(dir)).toHaveLength(2); // 覆盖 seq2，未来快照被清
  });

  it('GET /api/snapshots 返回 headSeq（回滚后变小）', async () => {
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } });
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } });
    const before = await a.inject({ method: 'GET', url: '/api/snapshots' });
    expect(before.json().headSeq).toBe(2);
    await a.inject({ method: 'POST', url: '/api/snapshots/rollback', payload: { seq: 1 } });
    const after = await a.inject({ method: 'GET', url: '/api/snapshots' });
    expect(after.json().headSeq).toBe(1);
    expect(after.json().snapshots).toHaveLength(2);
  });
});

describe('API 工作区', () => {
  it('GET /api/workspace/list 与 read', async () => {
    const list = await a.inject({ method: 'GET', url: '/api/workspace/list' });
    expect(list.statusCode).toBe(200);
    expect(list.json().paths).toContain('mmh3/');
    const read = await a.inject({ method: 'GET', url: '/api/workspace/read?path=mmh3%2Fshot_01.md' });
    expect(read.json().content).toContain('牵绳慢步');
  });

  it('GET /api/workspace/search 内容检索', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/workspace/search?q=' + encodeURIComponent('牵绳') });
    expect(res.json().hits[0].path).toBe('mmh3/shot_01.md');
  });
});

describe('API 变更管线（回环与回滚）', () => {
  it('PATCH 双写不触发回环：快照与 version 恰好 +1', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'shot', title: 'SHOT 01', fields: { filename: 'mmh3/shot_01.md', content: 'v1' } },
    });
    const id = created.json().node.id;
    // POST 创建 = 1 条快照；文件 mmh3/shot_01.md 已存在（beforeEach 建）→ 不落盘
    expect(listSnapshots(dir)).toHaveLength(1);
    const res = await a.inject({
      method: 'PATCH', url: `/api/nodes/${id}`,
      payload: { patch: { fields: { content: 'v2 新版' } } },
    });
    expect(res.json().node.version).toBe(2);
    // 等待 chokidar 异步事件处理：若回环存在，version 会变 3、快照 +2
    await new Promise((r) => setTimeout(r, 800));
    expect(listSnapshots(dir)).toHaveLength(2);
    expect(loadGraph(dir).nodes.find((n) => n.id === id)?.version).toBe(2);
  });

  it('外部修改映射文件触发回填（内容不同才回填）', async () => {
    await (a as unknown as { __wsReady: Promise<void> }).__wsReady; // 等 watcher 初始化完成
    const created = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'shot', title: 'SHOT 01', fields: { filename: 'mmh3/shot_01.md', content: 'v1' } },
    });
    const id = created.json().node.id;
    // 模拟外部工具（vim/pi 技能）修改文件
    writeFileSync(join(dir, 'mmh3/shot_01.md'), '外部修改的内容', 'utf8');
    // 轮询等待 chokidar 回填（最多 2s）
    let node;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      node = loadGraph(dir).nodes.find((n) => n.id === id);
      if (node?.fields.content === '外部修改的内容') break;
    }
    expect(node?.fields.content).toBe('外部修改的内容');
    expect(node?.version).toBe(2);
    expect(listSnapshots(dir)).toHaveLength(2); // 创建 + 外部修改回填
  });

  it('rollback 走 HEAD 切换：不追加新快照，未来快照保留', async () => {
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'A' } });
    await a.inject({ method: 'POST', url: '/api/nodes', payload: { type: 'shot', title: 'B' } });
    const ok = await a.inject({
      method: 'POST', url: '/api/snapshots/rollback',
      payload: { seq: 1 },
    });
    expect(ok.statusCode).toBe(200);
    expect(loadGraph(dir).nodes).toHaveLength(1);
    // 回滚不追加快照（直接回到该快照）；未来快照保留待覆盖/重做
    const snaps = listSnapshots(dir);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.seq)).toEqual([1, 2]);
  });
});

describe('API 生成', () => {
  it('GET /api/comfy/health 返回连接状态', async () => {
    const res = await a.inject({ method: 'GET', url: '/api/comfy/health' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().healthy).toBe('boolean');
  });

  it('POST /api/generation/submit 无 confirm 返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/generation/submit',
      payload: { nodeId: 'missing' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CONFIRM_REQUIRED');
  });

  it('POST /api/generation/submit 对不存在节点返回 404', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/generation/submit',
      payload: { nodeId: 'missing', confirm: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/generation/submit 建图后返回 queued 任务', async () => {
    // 建 params + generation 节点
    const p = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: {
        type: 'params', title: '参数',
        fields: {
          template: 'keyframe-video',
          params: { keyframes: 'KF0,KF1', width: 768, height: 1344, steps: 8, ref_seconds: 4, seam: 'Hard cut', seed: 0, run_id: 't', chain_previous_last: false },
        },
      },
    });
    const gen = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'generation', title: '生成 SEG-01', fields: { paramsNodeId: p.json().node.id } },
    });
    const res = await a.inject({
      method: 'POST', url: '/api/generation/submit',
      payload: { nodeId: gen.json().node.id, confirm: true },
    });
    expect(res.statusCode).toBe(202);
    // 队列微任务延迟启动 drain：inject 往返后任务可能已进入 running（ComfyUI 不可达时随后 failed）
    expect(['queued', 'running', 'failed']).toContain(res.json().task.status);
    // 等队列处理完（真实 ComfyUI 不可达会 failed，但任务状态机必须可查）
    const st = await a.inject({
      method: 'GET', url: `/api/generation/status?nodeId=${gen.json().node.id}`,
    });
    expect(st.statusCode).toBe(200);
    expect(['queued', 'running', 'success', 'failed']).toContain(st.json().task.status);
  });

  it('GET /api/tasks 返回统一 generation 任务并保留业务 payload', async () => {
    const p = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: {
        type: 'params', title: '参数',
        fields: { template: 'keyframe-video', params: { keyframes: 'KF0,KF1', width: 768, height: 1344, steps: 8, ref_seconds: 4, seam: 'Hard cut', seed: 0, run_id: 'tasks', chain_previous_last: false } },
      },
    });
    const gen = await a.inject({
      method: 'POST', url: '/api/nodes',
      payload: { type: 'generation', title: '任务测试', fields: { paramsNodeId: p.json().node.id } },
    });
    await a.inject({ method: 'POST', url: '/api/generation/submit', payload: { nodeId: gen.json().node.id, confirm: true } });
    const list = await a.inject({ method: 'GET', url: '/api/tasks' });
    expect(list.statusCode).toBe(200);
    expect(list.json().tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'comfy-generation', payload: expect.objectContaining({ nodeId: gen.json().node.id }) }),
    ]));
  });

  it('POST /api/generation/cancel 无 confirm 返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/generation/cancel',
      payload: { nodeId: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('API 素材上传', () => {
  // 隔离 HOME：assets-store 用 homedir() 函数式求值，不 stub 会污染真实 ~/.director
  let fakeHome: string;
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'director-home-api-'));
    vi.stubEnv('HOME', fakeHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('POST /api/assets/upload 上传 png 入库', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'KF0.png');
    // Node 18+ 原生 FormData/Blob；fastify inject 对 FormData 的兼容性依赖 light-my-request 版本
    const res = await a.inject({
      method: 'POST', url: '/api/assets/upload',
      payload: form,
      headers: { 'content-type': 'multipart/form-data' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().asset.kind).toBe('img');
    expect(res.json().asset.name).toBe('KF0.png');
  });

  it('POST /api/assets/upload 缺少 file 字段返回 400', async () => {
    // 非 multipart 请求：req.file() 返回 undefined → 400 INVALID_PATCH
    const res = await a.inject({ method: 'POST', url: '/api/assets/upload', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });



  it('素材 CRUD：编辑文本、替换文件、确认删除', async () => {
    const created = await a.inject({
      method: 'POST', url: '/api/assets/import-text',
      payload: { name: 'old.md', content: 'old content' },
    });
    const id = created.json().asset.id as string;
    const updated = await a.inject({
      method: 'PATCH', url: `/api/assets/${id}`,
      payload: { name: 'new.md', content: 'new content' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().asset.name).toBe('new.md');
    expect((await a.inject({ method: 'GET', url: `/api/assets/${id}/content` })).json().content).toBe('new content');

    const imageForm = new FormData();
    imageForm.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'old.png');
    const image = await a.inject({ method: 'POST', url: '/api/assets/upload', payload: imageForm, headers: { 'content-type': 'multipart/form-data' } });
    const imageId = image.json().asset.id as string;
    const replaceForm = new FormData();
    replaceForm.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), 'new.webp');
    const replaced = await a.inject({ method: 'POST', url: `/api/assets/${imageId}/replace`, payload: replaceForm, headers: { 'content-type': 'multipart/form-data' } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().asset.name).toBe('new.webp');

    const denied = await a.inject({ method: 'DELETE', url: `/api/assets/${id}` });
    expect(denied.statusCode).toBe(400);
    const removed = await a.inject({ method: 'DELETE', url: `/api/assets/${id}?confirm=true` });
    expect(removed.statusCode).toBe(200);
  });
});

describe('API agent 模型', () => {
  it('GET /api/agent/models 解析 pi --list-models 表格', async () => {
    vi.stubEnv('DIRECTOR_PI_LIST_CMD', `node ${join(process.cwd(), 'src/agent/mock-list-models.mjs')}`);
    const res = await a.inject({ method: 'GET', url: '/api/agent/models' });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<{ id: string; provider: string; thinking: boolean; images: boolean }>;
    expect(models).toHaveLength(3);
    expect(models[0]?.id).toBe('deepseek/deepseek-v4-flash');
    expect(models[1]?.thinking).toBe(true);
    expect(models[2]?.images).toBe(true);
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat 透传 model 到 pi 命令', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_MODEL', '1');
    const res = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: 'hi', model: 'mustore/grok-4.5' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('mustore/grok-4.5|none'); // model 透传、未传 thinking
    expect(res.payload).toContain('[DONE]');
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat 注入 @ 素材上下文', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'director-home-agent-asset-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_STDIN', '1');
    try {
      const created = await a.inject({
        method: 'POST', url: '/api/assets/import-text',
        payload: { name: '世界观.md', content: '精灵王国位于北境，冬季漫长。' },
      });
      const assetId = created.json().asset.id as string;
      const res = await a.inject({
        method: 'POST', url: '/api/agent/chat',
        payload: {
          message: '结合这个素材分析',
          assetRefs: [{ id: assetId, name: '世界观.md', kind: 'txt' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('世界观.md');
      expect(res.payload).toContain('精灵王国位于北境');
    } finally {
      vi.unstubAllEnvs();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('POST /api/agent/chat 的图像素材引用作为 pi 图像文件参数传入', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'director-home-agent-image-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_ARGS', '1');
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), '角色.png');
      const created = await a.inject({
        method: 'POST', url: '/api/assets/upload', payload: form,
        headers: { 'content-type': 'multipart/form-data' },
      });
      const assetId = created.json().asset.id as string;
      const res = await a.inject({
        method: 'POST', url: '/api/agent/chat',
        payload: { message: '参考这张图', assetRefs: [{ id: assetId, name: '角色.png', kind: 'img' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('@');
      expect(res.payload).toContain('.png');
    } finally {
      vi.unstubAllEnvs();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('POST /api/agent/chat 透传 thinking 到 pi 命令；非法级别忽略', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_MODEL', '1');
    const ok = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: 'hi', model: 'mustore/grok-4.5', thinking: 'high' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.payload).toContain('mustore/grok-4.5|high');
    // 非法级别不拼进命令（回显应为 none）
    const bad = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: 'hi', thinking: 'extreme' },
    });
    expect(bad.statusCode).toBe(200);
    expect(bad.payload).toContain('none|none');
    vi.unstubAllEnvs();
  });

  it('GET /api/agent/history：初始为空，chat 结束后写入 user + agent 消息', async () => {
    // 初始空
    const empty = await a.inject({ method: 'GET', url: '/api/agent/history' });
    expect(empty.json().messages).toEqual([]);
    // chat 一次（mock 回显 model|thinking）
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_MODEL', '1');
    const chat = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: '历史测试', model: 'mustore/grok-4.5' },
    });
    expect(chat.statusCode).toBe(200);
    // 历史含 user 原文 + agent 完整输出
    const res = await a.inject({ method: 'GET', url: '/api/agent/history' });
    const messages = res.json().messages as Array<{ who: string; text: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ who: 'user', text: '历史测试' });
    expect(messages[1]).toMatchObject({ who: 'agent', text: 'mustore/grok-4.5|none' });
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat：agent 挂起时空闲超时兜底，[DONE] 与历史照常落盘', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_HANG', '1');
    vi.stubEnv('DIRECTOR_AGENT_IDLE_MS', '300');
    const res = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: '挂起测试' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('partial reply');
    expect(res.payload).toContain('[DONE]');
    // 用户消息在请求开始时已落盘；agent 部分文本在超时后落盘
    const hist = await a.inject({ method: 'GET', url: '/api/agent/history' });
    const messages = hist.json().messages as Array<{ who: string; text: string }>;
    expect(messages.some((m) => m.who === 'user' && m.text === '挂起测试')).toBe(true);
    expect(messages.some((m) => m.who === 'agent' && m.text.includes('partial reply'))).toBe(true);
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat 注入项目上下文环境变量（kanban KANBAN_TASK_ID 语义）', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_ECHO_ENV', '1');
    const res = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: 'env 测试' },
    });
    expect(res.statusCode).toBe(200);
    // mock 回显 DIRECTOR_PROJECT_NAME；项目目录是测试临时目录，projectName = 目录 basename
    expect(res.payload).toMatch(/data: \{"chunk":".+"\}/);
    expect(res.payload).toContain('[DONE]');
    const projectName = res.payload.match(/chunk":"([^"]+)"/)?.[1];
    expect(projectName).toBeTruthy();
    expect(projectName).not.toBe('no-env'); // 确认注入生效而非缺省
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat 解析 pi --mode json 的 text_delta 流式增量', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_JSON_EVENTS', '1');
    const res = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: 'json 流式' },
    });
    expect(res.statusCode).toBe(200);
    // 三个 delta 拼接成完整文本；事件行本身不转发
    expect(res.payload).toContain('第一段流式输出');
    expect(res.payload).toContain('[DONE]');
    // 历史落盘为拼接后的完整文本
    const hist = await a.inject({ method: 'GET', url: '/api/agent/history' });
    const messages = hist.json().messages as Array<{ who: string; text: string }>;
    expect(messages.some((m) => m.who === 'agent' && m.text === '第一段流式输出')).toBe(true);
    vi.unstubAllEnvs();
  });

  it('POST /api/agent/chat：模型报错且无输出时提示具体错误（非笼统空输出）', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent-error.mjs')}`);
    const res = await a.inject({
      method: 'POST', url: '/api/agent/chat',
      payload: { message: '模型错误测试' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('（模型调用失败：403 Your request was blocked.）');
    expect(res.payload).not.toContain('（输出为空）');
    expect(res.payload).toContain('[DONE]');
    vi.unstubAllEnvs();
  });
});

describe('API agent 会话', () => {
  it('sessions CRUD：新建/重命名/删除/回退 activeId', async () => {
    const r1 = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    expect(r1.statusCode).toBe(200);
    const id1 = r1.json().activeId;
    const r2 = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    const id2 = r2.json().activeId;
    expect(id1).not.toBe(id2);
    // 重命名 id1
    const r3 = await a.inject({ method: 'PATCH', url: `/api/agent/sessions/${id1}`, payload: { title: '会话甲' } });
    expect(r3.json().sessions.find((s: { id: string }) => s.id === id1).title).toBe('会话甲');
    // 删除当前（id2）→ 回退 id1
    const r4 = await a.inject({ method: 'DELETE', url: `/api/agent/sessions/${id2}`, payload: {} });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().activeId).toBe(id1);
    // 删除不存在 → 404
    const r5 = await a.inject({ method: 'DELETE', url: '/api/agent/sessions/nope', payload: {} });
    expect(r5.statusCode).toBe(404);
    expect(r5.json().code).toBe('SESSION_NOT_FOUND');
  });

  it('chat 落盘到指定会话；history?sessionId 读回', async () => {
    vi.stubEnv('DIRECTOR_PI_CMD', `node ${join(process.cwd(), 'src/agent/mock-agent.mjs')}`);
    vi.stubEnv('MOCK_REPLY', '回显');
    const r = await a.inject({ method: 'POST', url: '/api/agent/sessions', payload: {} });
    const sid = r.json().activeId as string;
    await a.inject({ method: 'POST', url: '/api/agent/chat', payload: { message: '你好', sessionId: sid } });
    const h = await a.inject({ method: 'GET', url: `/api/agent/history?sessionId=${sid}` });
    expect(h.statusCode).toBe(200);
    const messages = h.json().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('你好');
    // 不带 sessionId 也返回当前 active 会话（向后兼容）
    const h2 = await a.inject({ method: 'GET', url: '/api/agent/history' });
    expect(h2.json().messages).toHaveLength(2);
    vi.unstubAllEnvs();
  });
});

describe('API ComfyUI 配置', () => {
  it('POST /api/comfy/config 写 project 节点并热切换地址', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/comfy/config',
      payload: { baseUrl: 'http://127.0.0.1:59999' },
    });
    expect(res.statusCode).toBe(200);
    const graph = loadGraph(dir);
    const proj = graph.nodes.find((n) => n.type === 'project');
    expect(proj?.fields.comfyuiUrl).toBe('http://127.0.0.1:59999');
  });

  it('POST /api/comfy/config 非法地址返回 400', async () => {
    const res = await a.inject({
      method: 'POST', url: '/api/comfy/config',
      payload: { baseUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PATCH');
  });
});
