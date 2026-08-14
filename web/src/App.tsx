import './App.css';
import { useCallback, useEffect, useState } from 'react';
import CanvasView from './canvas/CanvasView';
import { ProjectList, type ProjectInfo } from './panels/ProjectList';
import { AssetLibrary, type AssetItem } from './panels/AssetLibrary';
import { ImportDialog } from './panels/ImportDialog';
import { AgentPanel, type ChatMsg } from './panels/AgentPanel';
import { ConfirmDialog } from './panels/ConfirmDialog';
import { Timeline } from './panels/Timeline';
import { GenQueue } from './panels/GenQueue';
import { useGraphStore } from './store/graph';
import { client } from './api/client';
import { agentChat } from './api/agent';
import { connectWs } from './api/ws';

// 项目列表（计划 4 换真实数据源）
const MOCK_PROJECTS: ProjectInfo[] = [
  { id: 'p1', name: 'elf_and_goblin', meta: '3 分镜 · 11.25s', mode: 'KEYFRAME' },
  { id: 'p2', name: 'cat-vs-bunny', meta: '3 分镜 · 9.12s', mode: 'KEYFRAME' },
  { id: 'p3', name: 'pose-transfer', meta: '参考视频编辑', mode: 'REF2V' },
];

// 五区布局骨架：各面板在后续任务替换为真实组件
export default function App() {
  const tasks = useGraphStore((s) => s.tasks);
  const graph = useGraphStore((s) => s.graph);
  const chips = useGraphStore((s) => s.chips);
  const removeChip = useGraphStore((s) => s.removeChip);
  // 素材库三态：null=加载中/请求失败（显示空态，不误显 mock）；[]=真实空库（显示空态）；非空=真实数据
  const [assets, setAssets] = useState<AssetItem[] | null>(null);
  // 破坏性操作确认对话框状态：null=关闭
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void } | null>(null);
  // 项目导入对话框开关
  const [importOpen, setImportOpen] = useState(false);
  // 内置 agent 模型：空字符串 = pi 默认模型；列表来自 /api/agent/models
  const [agentModels, setAgentModels] = useState<Array<{ id: string; provider: string; thinking: boolean }>>([]);
  const [agentModel, setAgentModel] = useState('');

  // 拉取 pi 可用模型列表（内置面板模型下拉数据源）
  useEffect(() => {
    void client.listAgentModels().then(setAgentModels).catch(() => setAgentModels([]));
  }, []);

  // —— 全局接线：启动时拉取图 + WS 事件同步（后端为唯一事实来源） ——
  const applyGraph = useGraphStore((s) => s.applyGraph);
  const setConnected = useGraphStore((s) => s.setConnected);
  const upsertTask = useGraphStore((s) => s.upsertTask);
  // ComfyUI 连接状态三态：null=检测中、true=已连接、false=未连接
  const [comfyHealthy, setComfyHealthy] = useState<boolean | null>(null);
  // 当前 ComfyUI 地址（点击徽章可自定义）
  const [comfyUrl, setComfyUrl] = useState('');
  const [comfyEditOpen, setComfyEditOpen] = useState(false);
  const [comfyEditValue, setComfyEditValue] = useState('');

  // 保存自定义 ComfyUI 地址：热切换 + 立即刷新连接状态
  const saveComfyConfig = () => {
    void client.setComfyConfig(comfyEditValue.trim()).then((r) => {
      setComfyUrl(r.baseUrl);
      setComfyHealthy(r.healthy);
      setComfyEditOpen(false);
    }).catch(() => {
      setComfyEditOpen(false);
    });
  };

  useEffect(() => {
    void client.getGraph().then(applyGraph).catch(() => {});
    const disconnect = connectWs((ev) => {
      if (ev.type === 'graph') { applyGraph(ev.graph); setConnected(true); }
      else if (ev.type === 'generation') { upsertTask(ev.task); }
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

  // 真实 agent 流式发送：chips 是显示名（@xxx），发送时从画布查找节点内容注入上下文
  const handleAgentSend = (text: string, _chipRefs: string[]): ChatMsg[] => [
    { who: 'user', text },
    { who: 'agent', text: '（正在请求 pi…）' },
  ];

  const handleAgentStream = useCallback((text: string, chipRefs: string[], push: (chunk: string) => void) => {
    const payload = chipRefs.map((name) => {
      const node = useGraphStore.getState().graph?.nodes.find((n) => n.title === name.slice(2));
      return { name, content: JSON.stringify(node?.fields ?? {}) };
    });
    void agentChat(text, payload, push, agentModel || undefined).catch(() => push('\n（agent 连接失败）'));
  }, [agentModel]);

  // 破坏性操作走确认对话框（示例：时间线回滚）
  const askRollback = (seq: number) => setConfirm({
    title: '回滚快照',
    body: `回滚到 SN-${String(seq).padStart(3, '0')}？当前改动将保存为新快照。`,
    action: () => void client.rollback(seq, '前端回滚'),
  });

  // 生成提交确认门：generation 节点“▶ 提交生成”按钮 → 确认后提交到 ComfyUI
  // useCallback 保持引用稳定，避免 CanvasView 的 WS 订阅因 prop 变化反复重建
  const askSubmitGeneration = useCallback((nodeId: string) => {
    setConfirm({
      title: '提交生成',
      body: '将该段提交到 ComfyUI 生成？提交后生成队列将开始处理。',
      action: () => void client.submitGeneration(nodeId),
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
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <div className="slate" />
          <div>
            <div className="logo-name">导演工作台</div>
            <div className="logo-sub">DIRECTOR WORKBENCH</div>
          </div>
        </div>
        <div className="header-div" />
        <div className="project-name" data-testid="project-name">elf_and_goblin</div>
        {comfyHealthy === null ? (
          <div className="badge"><span className="dot" style={{ background: 'var(--text-faint)' }} />COMFYUI&nbsp;检测中</div>
        ) : comfyHealthy ? (
          <div className="badge clickable" title="点击自定义地址" onClick={() => { setComfyEditValue(comfyUrl); setComfyEditOpen(true); }}><span className="dot ok" />COMFYUI&nbsp;已连接</div>
        ) : (
          <div className="badge clickable" title="点击自定义地址" onClick={() => { setComfyEditValue(comfyUrl); setComfyEditOpen(true); }}><span className="dot" style={{ background: 'var(--rec)', boxShadow: '0 0 6px var(--rec)' }} />COMFYUI&nbsp;未连接</div>
        )}
        <div className="spacer" />
        <button className="btn-ghost" onClick={() => setImportOpen(true)}>＋ 导入</button>
        <button className="run-btn"><span className="tri">▶</span>运行流水线</button>
      </header>
      <main className="main">
        <aside className="left" data-testid="left-panel">
          <div className="panel-title">项目 <span className="mini">工作区</span></div>
          <ProjectList projects={MOCK_PROJECTS} activeId="p1" onSelect={() => {}} />
          <div className="panel-title">素材库 <span className="mini">全局 · 跨项目</span></div>
          <AssetLibrary items={assets ?? []} onDropToCanvas={handleDropToCanvas} onAssetsChanged={refreshAssets} />
        </aside>
        <section
          className="canvas" data-testid="canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const raw = e.dataTransfer.getData('application/x-asset');
            if (!raw) return;
            const item = JSON.parse(raw) as AssetItem;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            handleDropToCanvas(item, { x: e.clientX - rect.left, y: e.clientY - rect.top });
          }}
        >
          <CanvasView onNodeSubmit={askSubmitGeneration} />
        </section>
        <aside className="right" data-testid="agent-panel">
          <div className="panel-title">AGENT · pi <span className="mini">mmh3 skills</span></div>
          <AgentPanel chips={chips} onChipsChange={handleChipsChange} onSend={handleAgentSend} onStream={handleAgentStream} models={agentModels} selectedModel={agentModel} onModelChange={setAgentModel} />
        </aside>
      </main>
      <footer className="footer">
        <div className="timeline-wrap" data-testid="timeline"><Timeline onRollback={askRollback} /></div>
        <div className="queue-wrap" data-testid="queue"><GenQueue tasks={[...tasks.values()]} /></div>
      </footer>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { confirm?.action(); setConfirm(null); }}
        confirmLabel={confirm?.title === '提交生成' ? '确认提交' : confirm?.title === '回滚快照' ? '确认回滚' : '确认删除'}
      />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      {/* ComfyUI 地址自定义弹层 */}
      {comfyEditOpen && (
        <div className="dialog-mask" onClick={() => setComfyEditOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">ComfyUI 地址</div>
            <div className="dialog-body">
              <input
                className="ne-input"
                placeholder="http://127.0.0.1:8188"
                value={comfyEditValue}
                onChange={(e) => setComfyEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveComfyConfig(); }}
              />
              <div className="tl-sub" style={{ marginTop: 6 }}>本机或远程 GPU 地址，保存后立即生效（写入 project 节点 comfyuiUrl）</div>
            </div>
            <div className="dialog-actions">
              <button className="btn-ghost" onClick={() => setComfyEditOpen(false)}>取消</button>
              <button className="btn-primary" onClick={saveComfyConfig}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
