import type {
  DirectorEdge, DirectorNode, EdgeKind, GenTask, Graph, NodeType, ProjectInfo, SnapshotMeta,
} from '../types';

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const body = init?.body;
  const headers: Record<string, string> = {};
  // 仅在有 body 时声明 JSON 类型：无 body 的 DELETE/GET 若带上
  // content-type: application/json，Fastify 会因空 body 解析失败返回 500
  if (body !== undefined && body !== null && body !== '') {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((payload as { code?: string }).code ?? 'HTTP_' + res.status,
      (payload as { message?: string }).message ?? res.statusText);
  }
  return payload as T;
}

export const client = {
  async getGraph(): Promise<Graph> {
    const r = await req<{ graph: Graph }>('/api/graph');
    return r.graph;
  },

  async createNode(input: {
    type: NodeType; title: string;
    fields?: Record<string, unknown>; position?: { x: number; y: number };
  }): Promise<DirectorNode> {
    const r = await req<{ node: DirectorNode }>('/api/nodes', {
      method: 'POST', body: JSON.stringify(input),
    });
    return r.node;
  },

  async patchNode(id: string, patch: Record<string, unknown>): Promise<DirectorNode> {
    const r = await req<{ node: DirectorNode }>(`/api/nodes/${id}`, {
      method: 'PATCH', body: JSON.stringify({ patch }),
    });
    return r.node;
  },

  async deleteNode(id: string): Promise<void> {
    await req(`/api/nodes/${id}?confirm=true`, { method: 'DELETE' });
  },

  async moveNode(id: string, position: { x: number; y: number }): Promise<DirectorNode> {
    const r = await req<{ node: DirectorNode }>(`/api/nodes/${id}/move`, {
      method: 'POST', body: JSON.stringify({ position }),
    });
    return r.node;
  },

  async createEdge(input: { kind: EdgeKind; source: string; target: string; label?: string }): Promise<DirectorEdge> {
    const r = await req<{ edge: DirectorEdge }>('/api/edges', {
      method: 'POST', body: JSON.stringify(input),
    });
    return r.edge;
  },

  // 修改边（改类型/标签）；改为 chain 时后端重新校验线性约束
  async updateEdge(id: string, patch: { kind?: EdgeKind; label?: string }): Promise<DirectorEdge> {
    const r = await req<{ edge: DirectorEdge }>(`/api/edges/${id}`, {
      method: 'PATCH', body: JSON.stringify({ patch }),
    });
    return r.edge;
  },

  async deleteEdge(id: string): Promise<void> {
    await req(`/api/edges/${id}?confirm=true`, { method: 'DELETE' });
  },

  async listSnapshots(): Promise<SnapshotMeta[]> {
    const r = await req<{ snapshots: SnapshotMeta[] }>('/api/snapshots');
    return r.snapshots;
  },

  async listWorkspace(): Promise<string[]> {
    const r = await req<{ paths: string[] }>('/api/workspace/list');
    return r.paths;
  },

  async importFile(path: string, type: NodeType, title: string): Promise<DirectorNode> {
    const r = await req<{ node: DirectorNode }>('/api/import', {
      method: 'POST', body: JSON.stringify({ path, type, title }),
    });
    return r.node;
  },

  async submitGeneration(nodeId: string): Promise<GenTask> {
    const r = await req<{ task: GenTask }>('/api/generation/submit', {
      method: 'POST', body: JSON.stringify({ nodeId, confirm: true }),
    });
    return r.task;
  },

  async generationStatus(nodeId: string): Promise<GenTask | null> {
    const res = await fetch(`/api/generation/status?nodeId=${encodeURIComponent(nodeId)}`);
    if (res.status === 404) return null;
    return ((await res.json()) as { task: GenTask }).task;
  },

  async generationQueue(): Promise<GenTask[]> {
    const r = await req<{ tasks: GenTask[] }>('/api/generation/queue');
    return r.tasks;
  },

  async comfyHealth(): Promise<{ healthy: boolean; baseUrl: string }> {
    try {
      const r = await req<{ healthy: boolean; baseUrl: string }>('/api/comfy/health');
      return { healthy: r.healthy, baseUrl: r.baseUrl };
    } catch {
      return { healthy: false, baseUrl: '' };
    }
  },

  // 自定义 ComfyUI 地址（热切换，写入 project 节点）
  async setComfyConfig(baseUrl: string): Promise<{ healthy: boolean; baseUrl: string }> {
    const r = await req<{ ok: boolean; healthy: boolean; baseUrl: string }>('/api/comfy/config', {
      method: 'POST', body: JSON.stringify({ baseUrl }),
    });
    return { healthy: r.healthy, baseUrl: r.baseUrl };
  },

  // 项目列表：手动添加的项目注册表（含分镜/时长统计），默认不自动发现
  async listProjects(): Promise<ProjectInfo[]> {
    const r = await req<{ projects: ProjectInfo[] }>('/api/projects');
    return r.projects;
  },

  // 手动添加项目：校验为剧本项目（mmh3_prompts/prompts）或空目录后才可添加；
  // 成功后持久化注册表，之后自动显示在项目栏
  async addProject(path: string): Promise<ProjectInfo[]> {
    const r = await req<{ projects: ProjectInfo[] }>('/api/projects/add', {
      method: 'POST', body: JSON.stringify({ path }),
    });
    return r.projects;
  },

  // 从项目栏移除（仅移除注册表项，不删除目录）
  async removeProject(path: string): Promise<ProjectInfo[]> {
    const r = await req<{ projects: ProjectInfo[] }>('/api/projects/remove', {
      method: 'POST', body: JSON.stringify({ path }),
    });
    return r.projects;
  },

  // 项目热切换：后端重建图/队列/监视目录，返回新项目图与更新后的项目列表
  async switchProject(path: string): Promise<{ graph: Graph; projects: ProjectInfo[] }> {
    return await req<{ graph: Graph; projects: ProjectInfo[] }>('/api/project/switch', {
      method: 'POST', body: JSON.stringify({ path }),
    });
  },

  async listAssets(): Promise<Array<{ id: string; kind: 'txt' | 'img' | 'vid'; name: string; meta?: string }>> {
    const r = await req<{ assets: Array<{ id: string; kind: 'txt' | 'img' | 'vid'; name: string; meta?: string }> }>('/api/assets');
    return r.assets;
  },

  // 项目聊天历史（按项目持久化在 .director/chat.json，重启/刷新不丢）
  async listChatHistory(): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
    const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>('/api/agent/history');
    return r.messages ?? [];
  },

  // 画布 → MMH3 Prompt YAML 导出（chain 拓扑序 = 剧情顺序；错误抛 YAML_EXPORT_FAILED）
  async exportPromptYaml(): Promise<{ yaml: string; segments: number }> {
    return await req<{ yaml: string; segments: number }>('/api/yaml/export', {
      method: 'POST', body: JSON.stringify({}),
    });
  },

  async cancelGeneration(nodeId: string): Promise<void> {
    await req('/api/generation/cancel', { method: 'POST', body: JSON.stringify({ nodeId, confirm: true }) });
  },

  async rollback(seq: number, reason: string): Promise<void> {
    await req('/api/snapshots/rollback', { method: 'POST', body: JSON.stringify({ seq, reason, confirm: true }) });
  },

  // pi 模型列表（内置面板模型下拉数据源）
  async listAgentModels(): Promise<Array<{ id: string; provider: string; thinking: boolean; images: boolean }>> {
    const r = await req<{ models: Array<{ id: string; provider: string; thinking: boolean; images: boolean }> }>('/api/agent/models');
    return r.models;
  },

  // 文本素材导入：名称 + 内容直接入库
  async importText(name: string, content: string): Promise<void> {
    await req('/api/assets/import-text', { method: 'POST', body: JSON.stringify({ name, content }) });
  },

  // 文件素材上传（multipart）：浏览器侧无服务端路径，走 /api/assets/upload
  async uploadAsset(file: File): Promise<void> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/assets/upload', { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError((body as { code?: string }).code ?? 'HTTP_' + res.status, (body as { message?: string }).message ?? res.statusText);
    }
  },
};
