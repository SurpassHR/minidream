import './App.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasView from './canvas/CanvasView';
import type { ProjectInfo, AppSettings, ThemeMode } from './types';
import { SettingsModal } from './panels/SettingsModal';
import { AssetLibrary, type AssetItem } from './panels/AssetLibrary';
import { ProjectSwitcher } from './panels/ProjectSwitcher';
import { AddProjectDialog } from './panels/AddProjectDialog';
import { ImportDialog } from './panels/ImportDialog';
import { AgentPanel, type ChatMsg } from './panels/AgentPanel';
import { ConfirmDialog } from './panels/ConfirmDialog';
import { client, setOverwriteConfirmHandler } from './api/client';
import { Timeline } from './panels/Timeline';
import { VersionsList } from './panels/VersionsList';
import { GenQueue } from './panels/GenQueue';
import { Icon } from './icons';
import { useGraphStore } from './store/graph';
import { agentChat } from './api/agent';
import { connectWs } from './api/ws';
import { useHashRoute } from './router';
import { StoryTellerView } from './views/StoryTellerView';
import { ObjectDesignerView } from './views/ObjectDesignerView';

// 五区布局骨架：各面板在后续任务替换为真实组件
export default function App() {
  const route = useHashRoute();
  const tasks = useGraphStore((s) => s.tasks);
  const graph = useGraphStore((s) => s.graph);
  const chips = useGraphStore((s) => s.chips);
  const removeChip = useGraphStore((s) => s.removeChip);
  // 素材库三态：null=加载中/请求失败（显示空态，不误显 mock）；[]=真实空库（显示空态）；非空=真实数据
  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  // 破坏性操作确认对话框状态：null=关闭；onCancel 可选（覆盖快照确认需回传结果）
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void; onCancel?: () => void } | null>(null);
  // 项目导入对话框开关
  const [importOpen, setImportOpen] = useState(false);
  // 项目栏添加对话框开关
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  // 内置 agent 模型：空字符串 = pi 默认模型；列表来自 /api/agent/models
  const [agentModels, setAgentModels] = useState<Array<{ id: string; provider: string; thinking: boolean }>>([]);
  // agent 默认模型（全局设置 settings.json；AgentPanel 内可临时切换不回写）
  const [agentModel, setAgentModel] = useState('');
  // 思考强度（pi --thinking）：空字符串 = pi 默认；默认值来自全局设置
  const [thinkingLevel, setThinkingLevel] = useState('');
  // 全局设置（~/.director/settings.json）：comfyUrl / agentModel / agentThinking；设置弹窗读写
  const [settings, setSettings] = useState<AppSettings>({ comfyUrl: '', agentModel: '', agentThinking: '' });
  const [theme, setTheme] = useState<ThemeMode>('light');
  // 设置弹窗开关（顶栏 COMFYUI 徽章点击打开）
  const [settingsOpen, setSettingsOpen] = useState(false);
  // agent 活动回传（MCP 工具调用 → WS agent-activity）：显示在 AGENT 面板顶部
  const [agentActivity, setAgentActivity] = useState<{ text: string; at: number } | null>(null);

  // —— 面板尺寸：分割条拖拽调整，localStorage 持久化；双击分割条恢复默认 ——
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  const stored = (key: string, def: number, min: number, max: number) => {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? clamp(v, min, max) : def;
  };
  const PANEL_DEFAULTS = { left: 270, right: 300, footer: 148 } as const;
  const [leftW, setLeftW] = useState(() => stored('dw:leftW', 270, 200, 480));
  const [rightW, setRightW] = useState(() => stored('dw:rightW', 300, 240, 520));
  const [footerH, setFooterH] = useState(() => stored('dw:footerH', 148, 120, 360));
  const [dragging, setDragging] = useState<'left' | 'right' | 'footer' | null>(null);
  const dragRef = useRef<{ kind: 'left' | 'right' | 'footer'; start: number; val: number } | null>(null);

  const onSplitterDown = (kind: 'left' | 'right' | 'footer') => (e: React.MouseEvent) => {
    e.preventDefault();
    const val = kind === 'left' ? leftW : kind === 'right' ? rightW : footerH;
    dragRef.current = { kind, start: kind === 'footer' ? e.clientY : e.clientX, val };
    setDragging(kind);
  };

  // 拖拽期间在 window 上监听移动/抬起：分割条只负责触发，避免鼠标移出元素后丢失
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = (d.kind === 'footer' ? e.clientY : e.clientX) - d.start;
      if (d.kind === 'left') setLeftW(clamp(d.val + delta, 200, 480));
      else if (d.kind === 'right') setRightW(clamp(d.val - delta, 240, 520));
      else setFooterH(clamp(d.val - delta, 120, 360));
    };
    const up = () => {
      const d = dragRef.current;
      if (d) {
        const v = d.kind === 'left' ? leftW : d.kind === 'right' ? rightW : footerH;
        localStorage.setItem(`dw:${d.kind}W`, String(v));
      }
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [leftW, rightW, footerH]);

  const onSplitterReset = (kind: 'left' | 'right' | 'footer') => () => {
    const def = PANEL_DEFAULTS[kind];
    if (kind === 'left') setLeftW(def);
    else if (kind === 'right') setRightW(def);
    else setFooterH(def);
    localStorage.removeItem(`dw:${kind}W`);
  };

  // 拉取 pi 可用模型列表 + 全局设置（设置弹窗数据源；settings 应用为默认模型/思考强度）
  useEffect(() => {
    void client.listAgentModels().then(setAgentModels).catch(() => setAgentModels([]));
    void client.getSettings().then((s) => {
      setSettings(s);
      setTheme(s.theme ?? 'light');
      if (s.agentModel) setAgentModel(s.agentModel);
      if (s.agentThinking) setThinkingLevel(s.agentThinking);
    }).catch(() => {});
  }, []);

  // —— 全局接线：启动时拉取图 + WS 事件同步（后端为唯一事实来源） ——
  const applyGraph = useGraphStore((s) => s.applyGraph);
  const setConnected = useGraphStore((s) => s.setConnected);
  const upsertTask = useGraphStore((s) => s.upsertTask);
  // ComfyUI 连接状态三态：null=检测中、true=已连接、false=未连接
  const [comfyHealthy, setComfyHealthy] = useState<boolean | null>(null);
  // 当前 ComfyUI 地址（来自健康检查/设置）
  const [comfyUrl, setComfyUrl] = useState('');

  // 保存设置回调：ComfyUI 地址已由后端热切换，这里同步健康状态
  const handleSettingsSaved = (s: AppSettings) => {
    setSettings(s);
    setTheme(s.theme ?? 'light');
    if (s.comfyUrl) {
      setComfyUrl(s.comfyUrl);
      void client.comfyHealth().then((r) => setComfyHealthy(r.healthy));
    }
  };

  const handleSettingsError = (msg: string) => {
    console.error('保存设置失败', msg);
  };

  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    void client.saveSettings({ theme: next }).then((s) => {
      setSettings(s);
      setTheme(s.theme ?? next);
    }).catch((err) => {
      setTheme(theme);
      handleSettingsError(err instanceof Error ? err.message : '保存主题失败');
    });
  };

  useEffect(() => {
    void client.getGraph().then(applyGraph).catch(() => {});
    const disconnect = connectWs((ev) => {
      if (ev.type === 'graph') { applyGraph(ev.graph); setConnected(true); }
      else if (ev.type === 'generation') { upsertTask(ev.task); }
      else if (ev.type === 'agent-activity') { setAgentActivity({ text: ev.text, at: ev.at }); }
      // file-changed：图已由后端回填，等下一个 graph 事件即可
    }, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    return disconnect;
  }, [applyGraph, setConnected, upsertTask]);

  // ComfyUI 健康检查：挂载时立即拉取 + 每 15 秒轮询刷新
  useEffect(() => {
    let disposed = false;
    const poll = () => {
      void client.comfyHealth().then((r) => {
        if (!disposed) {
          setComfyHealthy(r.healthy);
          if (r.baseUrl) setComfyUrl(r.baseUrl);
        }
      });
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  // 素材库真实数据源：成功 → 真实列表（空数组即空态）；失败 → null（显示空态，不误显 mock 数据）
  const refreshAssets = useCallback(() => {
    void client.listAssets().then((list) => setAssets(list.map((a) => ({
      kind: a.kind, name: a.name, meta: a.meta,
    })))).catch(() => setAssets(null));
  }, []);

  useEffect(() => { refreshAssets(); }, [refreshAssets]);

  // 项目列表（真实数据源 /api/projects：当前项目 + 同根项目发现）
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  const refreshProjects = useCallback(() => {
    void client.listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  useEffect(() => { refreshProjects(); }, [refreshProjects]);

  // 点击项目 → 后端热切换（重建图/生成队列/文件监视），前端应用新图并刷新素材。
  // 列表保持原有顺序（仅更新 current 高亮），不把当前项目挪到最上方；
  // 后端返回的新发现项目追加到末尾。
  const handleProjectSelect = useCallback(async (path: string) => {
    try {
      const r = await client.switchProject(path);
      applyGraph(r.graph);
      setProjects((prev) => {
        const merged = prev.map((p) => ({ ...p, current: p.path === path }));
        for (const p of r.projects) {
          if (!merged.some((m) => m.path === p.path)) {
            merged.push({ ...p, current: p.path === path });
          }
        }
        return merged;
      });
      refreshAssets();
    } catch (err) {
      console.error('切换项目失败', err);
    }
  }, [applyGraph, refreshAssets]);

  // 手动添加项目：后端校验（剧本项目或空目录）→ 持久化注册表 → 用返回的新列表替换
  const handleAddProject = useCallback((projects: ProjectInfo[]) => {
    setProjects(projects);
  }, []);

  // 从项目栏移除（仅移除注册表项，不删除目录内容）：走确认门
  const askRemoveProject = useCallback((path: string, name: string) => {
    setConfirm({
      title: '移除项目',
      body: `将「${name}」从项目栏移除？仅移除列表项，不会删除目录内容。`,
      action: () => { void client.removeProject(path).then(setProjects).catch(() => {}); },
    });
  }, []);

  // 真实 agent 流式发送：chips 是显示名（@xxx），发送时从画布查找节点内容注入上下文
  const handleAgentSend = (text: string, _chipRefs: string[], _sessionId?: string | null): ChatMsg[] => [
    { who: 'user', text },
    { who: 'agent', text: '（正在请求 pi…）' },
  ];

  const handleAgentStream = useCallback((text: string, chipRefs: string[], push: (chunk: string) => void, sessionId?: string | null) => {
    const payload = chipRefs.map((name) => {
      const node = useGraphStore.getState().graph?.nodes.find((n) => n.title === name.slice(2));
      return { name, content: JSON.stringify(node?.fields ?? {}) };
    });
    // 返回 Promise：AgentPanel 据此进入/退出流式锁（期间禁止会话切换）
    return agentChat(text, payload, push, agentModel || undefined, thinkingLevel || undefined, sessionId)
      .catch(() => push('\n（agent 连接失败）'));
  }, [agentModel, thinkingLevel]);

  // 点击快照直接回滚（免确认）：重置图为目标快照状态并切换 HEAD，不追加新快照
  const handleRollback = useCallback((seq: number) => {
    void client.rollback(seq);
  }, []);

  // 撤销/重做快捷键：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        void client.undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        void client.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 覆盖未来（灰色）快照的确认钩子：写操作被后端拒绝（SNAPSHOT_FUTURE_EXISTS）时，
  // 弹确认对话框；确认后批准覆盖并自动重放原操作
  useEffect(() => {
    setOverwriteConfirmHandler((message: string) => new Promise<boolean>((resolve) => {
      setConfirm({
        title: '覆盖未来快照',
        body: `${message}。确认后其后的快照将被丢弃，且无法撤销。`,
        action: () => resolve(true),
        onCancel: () => resolve(false),
      });
    }));
    return () => setOverwriteConfirmHandler(null);
  }, []);

  // 生成提交确认门：generation 节点“▶ 提交生成”按钮 → 确认后提交到 ComfyUI
  // useCallback 保持引用稳定，避免 CanvasView 的 WS 订阅因 prop 变化反复重建
  const askSubmitGeneration = useCallback((nodeId: string) => {
    setConfirm({
      title: '提交生成',
      body: '将该段提交到 ComfyUI 生成？提交后生成队列将开始处理。',
      action: () => void client.submitGeneration(nodeId),
    });
  }, []);

  // 右键菜单删除节点确认门：删除写入快照，可回滚
  const askDeleteNode = useCallback((nodeId: string, title: string) => {
    setConfirm({
      title: '删除节点',
      body: '删除节点「' + title + '」？其连边将一并移除，改动会写入新快照。',
      action: () => void client.deleteNode(nodeId),
    });
  }, []);

  // 素材拖到画布 → 创建 asset 节点（计划 4 换素材库 API）
  const handleDropToCanvas = (item: AssetItem, position: { x: number; y: number }) => {
    void client.createNode({
      type: 'asset', title: `素材 ${item.name}`,
      fields: { assetKind: item.kind, assetName: item.name },
      position,
    });
  };

  // AgentPanel 删除 chip 时传剩余数组：diff 出被移除项并同步 store
  const handleChipsChange = useCallback((next: string[]) => {
    const current = useGraphStore.getState().chips;
    for (const c of current) {
      if (!next.includes(c)) removeChip(c);
    }
  }, [removeChip]);

  return (
    <div className="app" data-theme={theme}>
      <header className="topbar">
        <div className="logo">
          <div className="slate" />
          <div>
            <div className="logo-name">导演工作台</div>
            <div className="logo-sub">DIRECTOR WORKBENCH</div>
          </div>
        </div>
        <nav className="role-tabs" data-testid="role-tabs">
          <a href="#/story-teller" className={`role-tab${route === 'story-teller' ? ' active' : ''}`} data-testid="tab-story-teller">故事向导</a>
          <a href="#/object-designer" className={`role-tab${route === 'object-designer' ? ' active' : ''}`} data-testid="tab-object-designer">物体设计</a>
          <a href="#/canvas" className={`role-tab${route === 'canvas' ? ' active' : ''}`} data-testid="tab-canvas">画布</a>
        </nav>
        <div className="header-div" />
        <ProjectSwitcher
          projects={projects}
          activePath={projects.find((p) => p.current)?.path ?? ''}
          fallbackName={graph?.projectName ?? ''}
          onSelect={handleProjectSelect}
          onAdd={() => setAddProjectOpen(true)}
          onRemove={askRemoveProject}
        />
        {comfyHealthy === null ? (
          <div className="badge clickable" title="打开设置" onClick={() => setSettingsOpen(true)}><span className="dot" style={{ background: 'var(--text-faint)' }} />COMFYUI&nbsp;检测中</div>
        ) : comfyHealthy ? (
          <div className="badge clickable" title="打开设置" onClick={() => setSettingsOpen(true)}><span className="dot ok" />COMFYUI&nbsp;已连接</div>
        ) : (
          <div className="badge clickable" title="打开设置" onClick={() => setSettingsOpen(true)}><span className="dot" style={{ background: 'var(--rec)', boxShadow: '0 0 6px var(--rec)' }} />COMFYUI&nbsp;未连接</div>
        )}
        <div className="spacer" />
        <button
          className="btn-ghost theme-toggle"
          data-testid="theme-toggle"
          aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
          title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
          onClick={toggleTheme}
        ><Icon name={theme === 'dark' ? 'sun' : 'moon'} /><span>{theme === 'dark' ? '浅色' : '深色'}</span></button>
        <button
          className="btn-ghost settings-btn"
          data-testid="settings-open"
          title="设置：ComfyUI 地址 / 默认模型 / 思考强度"
          onClick={() => setSettingsOpen(true)}
        ><Icon name="gear" />设置</button>
        <button className="btn-ghost" onClick={() => setImportOpen(true)}>＋ 导入</button>
        <button className="run-btn"><span className="tri">▶</span>运行流水线</button>
      </header>
      {route === 'canvas' ? (
        <>
          <main className="main">
            <aside className="left" style={{ flexBasis: leftW }} data-testid="left-panel">
              <div className="panel-title">素材库 <span className="mini">全局 · 跨项目</span></div>
              <AssetLibrary items={assets ?? []} onDropToCanvas={handleDropToCanvas} onAssetsChanged={refreshAssets} />
            </aside>
            <div
              className={`splitter splitter-v ${dragging === 'left' ? 'active' : ''}`}
              data-testid="splitter-left"
              title="拖拽调整宽度 · 双击恢复默认"
              onMouseDown={onSplitterDown('left')}
              onDoubleClick={onSplitterReset('left')}
            />
            <section
              className="canvas" data-testid="canvas"
              onDragOver={(e) => e.preventDefault()}
            >
              {/* 素材拖放位置换算在 CanvasView 内完成（screenToFlowPosition，
                  节点出现在松手时光标处）；onAssetDrop 收到画布坐标 */}
              <CanvasView onNodeSubmit={askSubmitGeneration} onDeleteNode={askDeleteNode} onAssetDrop={handleDropToCanvas} />
            </section>
            <div
              className={`splitter splitter-v ${dragging === 'right' ? 'active' : ''}`}
              data-testid="splitter-right"
              title="拖拽调整宽度 · 双击恢复默认"
              onMouseDown={onSplitterDown('right')}
              onDoubleClick={onSplitterReset('right')}
            />
            <aside className="right" style={{ flexBasis: rightW }} data-testid="agent-panel">
              <div className="panel-title">AGENT · pi <span className="mini">mmh3 skills</span></div>
              <AgentPanel chips={chips} onChipsChange={handleChipsChange} onSend={handleAgentSend} onStream={handleAgentStream} models={agentModels} selectedModel={agentModel} onModelChange={setAgentModel} thinkingLevel={thinkingLevel} onThinkingLevelChange={setThinkingLevel} historyKey={graph?.projectName ?? 'none'} activity={agentActivity} />
            </aside>
          </main>
          <div
            className={`splitter splitter-h ${dragging === 'footer' ? 'active' : ''}`}
            data-testid="splitter-footer"
            title="拖拽调整高度 · 双击恢复默认"
            onMouseDown={onSplitterDown('footer')}
            onDoubleClick={onSplitterReset('footer')}
          />
          <footer className="footer" style={{ height: footerH }}>
            <div className="timeline-wrap" data-testid="timeline"><Timeline /></div>
            <div className="versions-wrap" data-testid="versions"><VersionsList onRollback={handleRollback} /></div>
            <div className="queue-wrap" data-testid="queue"><GenQueue tasks={[...tasks.values()]} /></div>
          </footer>
        </>
      ) : route === 'story-teller' ? (
        <StoryTellerView
          projectName={graph?.projectName ?? ''}
          prompts={settings.prompts}
          armorBreak={settings.armorBreak}
          armorBreakEnabled={settings.armorBreakEnabled}
          agentModel={settings.agentModel}
          thinkingLevel={settings.agentThinking}
        />
      ) : (
        <ObjectDesignerView
          projectName={graph?.projectName ?? ''}
          prompts={settings.prompts}
          armorBreak={settings.armorBreak}
          armorBreakEnabled={settings.armorBreakEnabled}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        onCancel={() => { confirm?.onCancel?.(); setConfirm(null); }}
        onConfirm={() => { confirm?.action(); setConfirm(null); }}
        confirmLabel={confirm?.title === '提交生成' ? '确认提交' : confirm?.title === '回滚快照' ? '确认回滚' : '确认删除'}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <AddProjectDialog
        open={addProjectOpen}
        onClose={() => setAddProjectOpen(false)}
        onAdded={handleAddProject}
      />
      {/* 全局设置弹窗（ComfyUI / 默认模型 / 思考强度 → settings.json） */}
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        models={agentModels}
        onClose={() => setSettingsOpen(false)}
        onSaved={handleSettingsSaved}
        onError={handleSettingsError}
      />
    </div>
  );
}