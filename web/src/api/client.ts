import type {
  DirectorEdge, DirectorNode, EdgeKind, GenTask, Graph, NodeType, ProjectInfo, SnapshotMeta,
  StoryProgress, AssetRecord, DesignKind, DesignObject, AppSettings, SessionMeta,
} from '../types';

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// 覆盖未来快照的确认钩子：写操作被后端拒绝（SNAPSHOT_FUTURE_EXISTS）时调用，
// 返回 true 则批准覆盖并自动重放原请求（由 App 注册为确认对话框）
let overwriteConfirmHandler: ((message: string) => Promise<boolean>) | null = null;
export function setOverwriteConfirmHandler(fn: ((message: string) => Promise<boolean>) | null): void {
  overwriteConfirmHandler = fn;
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
    const code = (payload as { code?: string }).code ?? 'HTTP_' + res.status;
    // 覆盖未来（灰色）快照需确认：弹确认 → 批准 → 重放原请求
    if (code === 'SNAPSHOT_FUTURE_EXISTS' && overwriteConfirmHandler) {
      const approved = await overwriteConfirmHandler((payload as { message?: string }).message ?? '将覆盖未来快照');
      if (approved) {
        await req('/api/snapshots/approve-overwrite', { method: 'POST' });
        return req<T>(url, init);
      }
      throw new ApiError('SNAPSHOT_OVERWRITE_CANCELLED', '已取消：未来快照未被覆盖');
    }
    throw new ApiError(code, (payload as { message?: string }).message ?? res.statusText);
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

  async createEdge(input: {
    kind: EdgeKind; source: string; target: string; label?: string; targetHandle?: string;
    replaceEdgeId?: string;
  }): Promise<DirectorEdge> {
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

  async listSnapshots(): Promise<{ snapshots: SnapshotMeta[]; headSeq: number }> {
    const r = await req<{ snapshots: SnapshotMeta[]; headSeq: number }>('/api/snapshots');
    return r;
  },

  // 点击快照直接回滚（免确认）：重置图为目标快照状态并切换 HEAD，不追加新快照
  async rollback(seq: number): Promise<Graph> {
    const r = await req<{ graph: Graph }>('/api/snapshots/rollback', {
      method: 'POST', body: JSON.stringify({ seq }),
    });
    return r.graph;
  },

  // 撤销（Ctrl+Z）：HEAD 后退到前一个快照
  async undo(): Promise<Graph> {
    const r = await req<{ graph: Graph }>('/api/snapshots/undo', { method: 'POST' });
    return r.graph;
  },

  // 重做（Ctrl+Y / Ctrl+Shift+Z）：HEAD 前进到下一个（未来）快照
  async redo(): Promise<Graph> {
    const r = await req<{ graph: Graph }>('/api/snapshots/redo', { method: 'POST' });
    return r.graph;
  },

  // 批准覆盖未来快照（req 捕获 SNAPSHOT_FUTURE_EXISTS 时自动调用）
  async approveOverwrite(): Promise<void> {
    await req('/api/snapshots/approve-overwrite', { method: 'POST' });
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

  // —— 全局设置（~/.director/settings.json）——
  // ComfyUI 地址 / agent 默认模型 / 思考强度（默认值，AgentPanel 可临时改）
  async getSettings(): Promise<AppSettings> {
    const r = await req<{ settings: AppSettings }>('/api/settings');
    return r.settings;
  },

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const r = await req<{ settings: AppSettings }>('/api/settings', {
      method: 'PUT', body: JSON.stringify(patch),
    });
    return r.settings;
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

  // —— AGENT 会话（多会话 CRUD；全部返回列表 + activeId）——
  async listAgentSessions(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/agent/sessions');
    return r;
  },
  async createAgentSession(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/agent/sessions', {
      method: 'POST', body: JSON.stringify({}),
    });
    return r;
  },
  async renameAgentSession(id: string, title: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/agent/sessions/${id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
    return r;
  },
  async deleteAgentSession(id: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/agent/sessions/${id}`, {
      method: 'DELETE', body: JSON.stringify({}),
    });
    return r;
  },

  // 项目聊天历史（按会话作用域：sessionId 缺省时后端回退到当前会话）
  async listChatHistory(sessionId?: string | null): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>(`/api/agent/history${q}`);
    return r.messages;
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

  // —— story-teller 向导 ——
  // 响应携带 md（剧本全文）：GET 仅已完成时非 null；complete 恒为字符串（后端单一来源）
  async getStory(): Promise<{ story: StoryProgress; md: string | null }> {
    const r = await req<{ story: StoryProgress; md: string | null }>('/api/story');
    return r;
  },

  async saveStory(patch: { step?: number; answers?: Record<string, string> }): Promise<StoryProgress> {
    const r = await req<{ story: StoryProgress }>('/api/story', {
      method: 'PUT', body: JSON.stringify(patch),
    });
    return r.story;
  },

  async completeStory(): Promise<{ asset: AssetRecord; story: StoryProgress; md: string }> {
    return await req<{ asset: AssetRecord; story: StoryProgress; md: string }>('/api/story/complete', {
      method: 'POST', body: JSON.stringify({}),
    });
  },

  // 重新生成故事：清空进度与完成标记（spec 4.3 重新生成入口）
  async resetStory(): Promise<StoryProgress> {
    const r = await req<{ story: StoryProgress }>('/api/story/reset', {
      method: 'POST', body: JSON.stringify({}),
    });
    return r.story;
  },

  // —— object-designer 设计器 ——
  async listDesigns(): Promise<DesignObject[]> {
    const r = await req<{ designs: DesignObject[] }>('/api/designs');
    return r.designs;
  },

  async createDesign(input: { kind: DesignKind; name: string }): Promise<DesignObject> {
    const r = await req<{ design: DesignObject }>('/api/designs', {
      method: 'POST', body: JSON.stringify(input),
    });
    return r.design;
  },

  async updateDesign(id: string, patch: Partial<Pick<DesignObject, 'name' | 'description' | 'style' | 'template'>>): Promise<DesignObject> {
    const r = await req<{ design: DesignObject }>(`/api/designs/${id}`, {
      method: 'PUT', body: JSON.stringify({ patch }),
    });
    return r.design;
  },

  async deleteDesign(id: string): Promise<void> {
    await req(`/api/designs/${id}?confirm=true`, { method: 'DELETE' });
  },

  async generateDesign(id: string): Promise<DesignObject> {
    const r = await req<{ design: DesignObject }>(`/api/designs/${id}/generate`, {
      method: 'POST', body: JSON.stringify({}),
    });
    return r.design;
  },

  async listWorkflows(): Promise<string[]> {
    const r = await req<{ workflows: string[] }>('/api/workflows');
    return r.workflows;
  },

  // —— 故事向导对话式 ——
  // 对话历史（独立 story-chat.json，与 AGENT 面板 chat.json 隔离）
  async getStoryChatHistory(sessionId?: string | null): Promise<Array<{ who: 'user' | 'agent'; text: string; at: number }>> {
    const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const r = await req<{ messages: Array<{ who: 'user' | 'agent'; text: string; at: number }> }>(`/api/story/chat/history${q}`);
    return r.messages ?? [];
  },

  // —— 故事对话式会话（多会话 CRUD；全部返回列表 + activeId）——
  async listStorySessions(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/story/chat/sessions');
    return r;
  },
  async createStorySession(): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>('/api/story/chat/sessions', {
      method: 'POST', body: JSON.stringify({}),
    });
    return r;
  },
  async renameStorySession(id: string, title: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/story/chat/sessions/${id}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
    return r;
  },
  async deleteStorySession(id: string): Promise<{ sessions: SessionMeta[]; activeId: string | null }> {
    const r = await req<{ sessions: SessionMeta[]; activeId: string | null }>(`/api/story/chat/sessions/${id}`, {
      method: 'DELETE', body: JSON.stringify({}),
    });
    return r;
  },

  // SSE 流式对话（协议同 /api/agent/chat，端点独立）；
  // persistAs：系统动作（总结成稿/回填向导）的落盘标记，避免长指令污染对话历史
  async storyChat(
    message: string,
    onChunk: (text: string) => void,
    model?: string,
    thinking?: string,
    persistAs?: string,
    sessionId?: string | null,
  ): Promise<void> {
    const res = await fetch('/api/story/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, model, thinking, persistAs, sessionId: sessionId ?? undefined }),
    });
    if (!res.ok || !res.body) throw new Error(`story chat 请求失败: ${res.status}`);
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
  },
};
