import {
  useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, useReactFlow,
  type Connection, type Edge, type Node as FlowNode,
  addEdge, useEdgesState, useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graph';
import { client } from '../api/client';
import { nodeTypes } from './nodes';
import { inletGroupOf, INLET_LABELS } from './nodes';
import { edgeTypes } from './edges';
import { NodeEditor, type EditorNode } from './NodeEditor';
import { YamlExportDialog } from './YamlExportDialog';
import { Icon } from '../icons';
import type { DirectorEdge, DirectorNode, NodeType } from '../types';
import type { AssetItem } from '../panels/AssetLibrary';

function toFlowNode(
  n: DirectorNode,
  opts: { onSubmit?: (nodeId: string) => void; addChip?: (name: string) => void } = {},
): FlowNode {
  const data: Record<string, unknown> = { title: n.title, fields: n.fields };
  // 生成节点注入提交回调：按钮点击 → App 弹确认门
  if (n.type === 'generation' && opts.onSubmit) {
    data.onSubmit = () => opts.onSubmit?.(n.id);
  }
  // 所有节点注入“加入对话”回调：chips 显示名 @ 标题
  if (opts.addChip) {
    data.addChip = () => opts.addChip?.("@ " + n.title);
  }
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    data,
  };
}

function toFlowEdge(e: DirectorEdge, nodes: DirectorNode[]): Edge {
  // 分镜节点左侧是多接口圆点：目标为分镜且无 targetHandle 的旧边/重连边，
  // 按边类型补齐——chain 落到剧情接口，ref/exec 按源节点素材类型落到对应组
  const src = nodes.find((n) => n.id === e.source);
  const tgt = nodes.find((n) => n.id === e.target);
  let targetHandle = e.targetHandle;
  if (!targetHandle && tgt?.type === 'shot') {
    targetHandle = e.kind === 'chain' ? 'chain-0' : `${inletGroupOf(src)}-0`;
  }
  return {
    id: e.id,
    type: e.kind,
    source: e.source,
    target: e.target,
    label: e.label,
    targetHandle,
  };
}

// 解析接口圆点 id → 组名：'text-2' → 'text'；无/无法解析 → ''
function inletGroupOfHandle(h: string | undefined): string {
  return /^([a-z]+)-\d+$/.exec(h ?? '')?.[1] ?? '';
}

// 拖线未命中具体圆点（落在分镜节点主体）时，分配指定组最小空闲圆点。
// 与 ShotNode 渲染规则一致：空闲序号必在已渲染圆点范围内（渲染数 = 最大占用 + 2）
function firstFreeInlet(edges: Edge[], target: string, group: string): string {
  const occupied = new Set<number>();
  const re = new RegExp(`^${group}-(\\d+)$`);
  for (const e of edges) {
    if (e.target !== target) continue;
    const m = re.exec(e.targetHandle ?? '');
    if (m) occupied.add(Number(m[1]));
  }
  let i = 0;
  while (occupied.has(i)) i += 1;
  return `${group}-${i}`;
}

/** 右键菜单状态：画布（空白处）或节点 */
interface CtxMenu {
  x: number;
  y: number;
  kind: 'pane' | 'node';
  node?: EditorNode;
}

interface CanvasProps {
  onNodeSubmit?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string, title: string) => void;
  // 素材拖到画布：position 为画布坐标（flow 坐标，已由 screenToFlowPosition 换算）
  onAssetDrop?: (item: AssetItem, position: { x: number; y: number }) => void;
}

function CanvasInner({ onNodeSubmit, onDeleteNode, onAssetDrop }: CanvasProps) {
  const graph = useGraphStore((s) => s.graph);
  const addChip = useGraphStore((s) => s.addChip);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<EditorNode | null>(null);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // YAML 导出结果（成功文本 / 校验错误）
  const [yamlExport, setYamlExport] = useState<{ yaml: string | null; error: string | null } | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // WS 回推图时同步（后端为唯一事实来源）；订阅放 useEffect 避免重复注册
  useEffect(() => {
    return useGraphStore.subscribe((s) => {
      if (s.graph) {
        setNodes(s.graph.nodes.map((n) => toFlowNode(n, { onSubmit: onNodeSubmit, addChip })));
        setEdges(s.graph.edges.map((e) => toFlowEdge(e, s.graph!.nodes)));
      }
    });
  }, [setNodes, setEdges, onNodeSubmit, addChip]);

  // 最新 edges 的 ref：onConnect 分配空闲接口圆点需要读当前边（避免闭包过期）
  const edgesRef = useRef<Edge[]>([]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // 拖线被类型校验拒绝时的提示（自动消失）
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  // 边组件（edges.tsx）重连被类型校验拒绝时经自定义事件提示（边组件无法访问本组件 toast）
  useEffect(() => {
    const onToast = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      if (msg) showToast(msg);
    };
    window.addEventListener('canvas-toast', onToast);
    return () => window.removeEventListener('canvas-toast', onToast);
  }, [showToast]);

  // 边创建核心（onConnect 与“松手在节点主体”手动路径共用）：
  // 推断边类型 → 目标接口圆点类型校验/分配 → 后端创建 + 本地乐观渲染
  const commitEdge = useCallback((c: { source: string; target: string; targetHandle?: string | null }) => {
    if (!c.source || !c.target) return;
    const nodes = useGraphStore.getState().graph?.nodes ?? [];
    const typeOf = (id: string) => nodes.find((n) => n.id === id)?.type;
    const st = typeOf(c.source);
    const tt = typeOf(c.target);
    const kind = st === 'shot' && tt === 'shot' ? 'chain'
      : st === 'generation' || tt === 'generation' ? 'exec'
      : 'ref';
    // 目标端接口圆点类型校验（分镜左侧圆点分组：剧情/文字/视频/图像）
    let targetHandle = c.targetHandle ?? undefined;
    if (tt === 'shot') {
      const srcNode = nodes.find((n) => n.id === c.source);
      const group = inletGroupOfHandle(targetHandle);
      if (kind === 'chain') {
        // 剧情链：无论拖到哪个圆点/主体，一律纠正到剧情接口（chain-0）
        targetHandle = 'chain-0';
      } else {
        const expectGroup = inletGroupOf(srcNode);
        if (group && group !== expectGroup) {
          // 拖到错误类型的素材圆点：拒绝并提示（后端还有兜底校验）
          showToast(`接口类型不匹配：${INLET_LABELS[expectGroup] ?? expectGroup}节点不能连接到${INLET_LABELS[group] ?? group}接口`);
          return;
        }
        // 拖到节点主体（未命中圆点）：自动落到源类型对应组的最小空闲圆点
        if (!targetHandle) targetHandle = firstFreeInlet(edgesRef.current, c.target, expectGroup);
      }
    }
    // 乐观边：先本地显示，HTTP 响应后把临时 id 换成后端 id（WS 回推前/WS 断开时
    // 重连/删除仍按后端 id 同步，避免 pending id 与后端 id 错位导致旧边删不掉）
    const pendingId = `pending-${c.source.slice(0, 8)}-${c.target.slice(0, 8)}-${Date.now()}`;
    setEdges((eds) => [...eds, {
      id: pendingId,
      source: c.source,
      target: c.target,
      type: kind,
      targetHandle: targetHandle ?? null,
    }]);
    void client.createEdge({ kind, source: c.source, target: c.target, targetHandle })
      .then((created) => {
        setEdges((eds) => eds.map((e) => (e.id === pendingId ? { ...e, id: created.id } : e)));
      })
      .catch(() => {
        // 后端拒绝（类型不匹配等）：移除乐观边（本地回滚，WS 回推原图兜底）
        setEdges((eds) => eds.filter((e) => e.id !== pendingId));
      });
  }, [setEdges, showToast]);

  // —— 松手在节点主体（非圆点）的兜底连接 ——
  // xyflow 只在松手命中圆点（connectionRadius 内）时回调 onConnect，
  // 松手在节点其他位置会静默取消。分镜节点变大/圆点上移后用户按旧习惯
  // 松手在节点主体 → 连不上。这里在 onConnectEnd 检测松手命中的节点，
  // 若在节点主体（非圆点）则手动补建边（类型推断/校验与 onConnect 一致）
  const dragFromRef = useRef<{ nodeId: string; handleType: 'source' | 'target' } | null>(null);
  const onConnectStart = useCallback((_e: unknown, p: { nodeId: string | null; handleType: 'source' | 'target' | null }) => {
    if (!p.nodeId || !p.handleType) return;
    dragFromRef.current = { nodeId: p.nodeId, handleType: p.handleType };
  }, []);
  const onConnectEnd = useCallback((e: MouseEvent | TouchEvent, _state: unknown) => {
    const from = dragFromRef.current;
    dragFromRef.current = null;
    if (!from || from.handleType !== 'source') return; // 只兜底 source 拖出的线
    const clientX = 'clientX' in e ? e.clientX : 0;
    const clientY = 'clientY' in e ? e.clientY : 0;
    const el = document.elementFromPoint(clientX, clientY);
    if (el?.closest('.react-flow__handle')) return; // 松手在圆点上：xyflow 已回调 onConnect
    const nodeEl = el?.closest('.react-flow__node');
    const target = nodeEl?.getAttribute('data-id');
    if (!target || target === from.nodeId) return;
    commitEdge({ source: from.nodeId, target });
  }, [commitEdge]);

  const onNodeDragStop = useCallback((_e: unknown, node: FlowNode) => {
    void client.moveNode(node.id, node.position);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    commitEdge({ source: c.source, target: c.target, targetHandle: c.targetHandle });
  }, [commitEdge]);

  // 边被删除（Delete 键）→ 同步后端；onEdgesDelete 是 ReactFlow 标准回调。
  // 注：连线终点拖拽断开/重连由自定义边组件（edges.tsx）的拖拽点实现，
  // 不使用 onReconnect/onReconnectEnd（ReactFlow 存在导致边不渲染的边缘 bug）
  // 删除节点时 ReactFlow 也会连带触发 onEdgesDelete：用 ref 跳过这些连带边
  // （后端 deleteNode 已连带删边，重复 deleteEdge 会 404）
  const deletingNodesRef = useRef<Set<string> | null>(null);
  const onNodesDelete = useCallback((deleted: FlowNode[]) => {
    deletingNodesRef.current = new Set(deleted.map((n) => n.id));
    for (const n of deleted) void client.deleteNode(n.id);
  }, []);
  const onEdgesDelete = useCallback((deleted: Edge[]) => {
    const skip = deletingNodesRef.current;
    for (const e of deleted) {
      if (skip?.has(e.source) || skip?.has(e.target)) continue;
      void client.deleteEdge(e.id);
    }
    deletingNodesRef.current = null;
  }, []);

  // 素材拖到画布：ReactFlow 的 onDrop 在画布坐标系内换算（screenToFlowPosition），
  // 并让节点中心对齐光标（position 语义是左上角，直接换算节点会偏到光标右下方）
  const onDropAsset = useCallback((e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-asset');
    if (!raw) return;
    e.preventDefault();
    const item = JSON.parse(raw) as AssetItem;
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    // 素材节点尺寸与 .node CSS 一致（宽 212，高按素材节点布局估算）
    const NODE_W = 212;
    const NODE_H = 70;
    onAssetDrop?.(item, { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 });
  }, [onAssetDrop, screenToFlowPosition]);
  const onDragOverCanvas = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // 点击节点 → 右上浮动编辑面板；点击空白 → 关闭
  const onNodeClick = useCallback((_e: unknown, n: FlowNode) => {
    setMenu(null);
    setSelected({
      id: n.id,
      title: String(n.data.title ?? ''),
      fields: (n.data.fields ?? {}) as Record<string, unknown>,
    });
  }, []);

  const onPaneClick = useCallback(() => {
    setMenu(null);
    setSelected(null);
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);
  const openEditor = useCallback((n: EditorNode) => {
    setSelected(n);
    setMenu(null);
  }, []);

  // —— 右键菜单：画布（空白处）—— 新建节点 / 适应视图 ——
  const onPaneContextMenu = useCallback((e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault();
    setSelected(null);
    setMenu({ x: e.clientX, y: e.clientY, kind: 'pane' });
  }, []);

  // —— 右键菜单：节点 —— 编辑 / 加入对话 / 删除 ——
  const onNodeContextMenu = useCallback((e: ReactMouseEvent, n: FlowNode) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      kind: 'node',
      node: {
        id: n.id,
        title: String(n.data.title ?? ''),
        fields: (n.data.fields ?? {}) as Record<string, unknown>,
      },
    });
  }, []);

  // 在右键位置新建节点（光标坐标 → 画布坐标）
  const createNodeAt = useCallback((type: NodeType, title: string) => {
    if (!menu || menu.kind !== 'pane') return;
    const pos = screenToFlowPosition({ x: menu.x, y: menu.y });
    const position = Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : { x: 80, y: 80 };
    void client.createNode({ type, title, position });
    closeMenu();
  }, [menu, screenToFlowPosition, closeMenu]);

  // 导出画布 → MMH3 Prompt YAML（chain 拓扑序 = 剧情顺序）；失败展示后端校验错误
  const exportYaml = useCallback(() => {
    closeMenu();
    setYamlExport({ yaml: null, error: null });
    void client.exportPromptYaml()
      .then((r) => setYamlExport({ yaml: r.yaml, error: null }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setYamlExport({ yaml: null, error: msg });
      });
  }, [closeMenu]);

  // 自动编号：SHOT 01 / 02 …（按现有分镜节点数 +1）
  const nextShotNo = useCallback(() => {
    const count = graph?.nodes.filter((n) => n.type === 'shot').length ?? 0;
    return String(count + 1).padStart(2, '0');
  }, [graph]);

  // 菜单打开期间：Esc 关闭；点击菜单外任意处关闭
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const onOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onOutside);
    };
  }, [menu]);


  // —— 右键菜单：边 —— 改类型 / 删除 ——
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; edge: Edge } | null>(null);
  const edgeMenuRef = useRef<HTMLDivElement | null>(null);
  const onEdgeContextMenu = useCallback((e: ReactMouseEvent, ed: Edge) => {
    e.preventDefault();
    setMenu(null);
    setEdgeMenu({ x: e.clientX, y: e.clientY, edge: ed });
  }, []);

  // 边类型切换（chain 改为线性校验由后端执行，失败时 WS 回推纠正）
  const changeEdgeKind = useCallback((kind: 'ref' | 'chain' | 'exec') => {
    if (!edgeMenu) return;
    void client.updateEdge(edgeMenu.edge.id, { kind }).catch(() => {});
    setEdgeMenu(null);
  }, [edgeMenu]);

  // 边菜单：Esc / 点击外部关闭
  useEffect(() => {
    if (!edgeMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEdgeMenu(null); };
    const onOutside = (e: MouseEvent) => {
      if (edgeMenuRef.current && !edgeMenuRef.current.contains(e.target as Node)) setEdgeMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onOutside);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onOutside);
    };
  }, [edgeMenu]);

  // 菜单尺寸估计（用于视口内钳位，避免贴边溢出）
  const menuH = menu?.kind === 'pane' ? 172 : 112;
  const menuX = menu ? Math.min(menu.x, Math.max(8, window.innerWidth - 190)) : 0;
  const menuY = menu ? Math.min(menu.y, Math.max(8, window.innerHeight - menuH)) : 0;

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onDrop={onDropAsset}
        onDragOver={onDragOverCanvas}
        // Delete/Backspace 删除选中元素（节点+边）；框选改为 Ctrl/Cmd 拖拽
        deleteKeyCode={['Backspace', 'Delete']}
        selectionKeyCode={['Control', 'Meta']}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        {/* 点阵网格：颜色明显区别于背景，拖动画布时可见（纯色背景看不出拖动 → 点阵） */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#2E3849" />
      </ReactFlow>
      {/* 签名元素 ①：取景器四角 L 角标 */}
      <div className="vf tl" /><div className="vf tr" />
      <div className="vf bl" /><div className="vf br" />
      {!graph?.nodes.length && (
        <div className="canvas-empty">
          空画布——在左侧素材库拖入素材，或让 agent 生成分镜
        </div>
      )}
      {/* 右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menuX, top: menuY }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === 'pane' ? (
            <>
              <button className="ctx-item" onClick={() => createNodeAt('shot', `SHOT ${nextShotNo()}`)}>＋ 新建分镜节点</button>
              <button className="ctx-item" onClick={() => createNodeAt('params', `PARAMS ${nextShotNo()}`)}>＋ 新建参数节点</button>
              <button className="ctx-item" onClick={() => createNodeAt('prompt', `PROMPT ${nextShotNo()}`)}>＋ 新建提示词节点</button>
              <div className="ctx-sep" />
              <button className="ctx-item" onClick={exportYaml}>⇩ 导出 Prompt YAML</button>
              <button className="ctx-item" onClick={() => { void fitView({ padding: 0.15 }); closeMenu(); }}>⤢ 适应视图</button>
            </>
          ) : (
            <>
              <button className="ctx-item" onClick={() => openEditor(menu.node!)}><Icon name="pencil" />编辑节点…</button>
              <button className="ctx-item" onClick={() => { addChip(`@ ${menu.node!.title}`); closeMenu(); }}>⇢ 加入对话</button>
              <div className="ctx-sep" />
              <button
                className="ctx-item danger"
                onClick={() => { onDeleteNode?.(menu.node!.id, menu.node!.title); closeMenu(); }}
              ><Icon name="trash" />删除节点…</button>
            </>
          )}
        </div>
      )}
      {/* 边右键菜单：改类型 / 删除 */}
      {edgeMenu && (
        <div
          ref={edgeMenuRef}
          className="ctx-menu"
          style={{
            left: Math.min(edgeMenu.x, Math.max(8, window.innerWidth - 190)),
            top: Math.min(edgeMenu.y, Math.max(8, window.innerHeight - 130)),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="ctx-label">边类型（当前：{edgeMenu.edge.type}）</div>
          <button className={`ctx-item ${edgeMenu.edge.type === 'ref' ? 'sel' : ''}`} onClick={() => changeEdgeKind('ref')}>ref · 创作引用（灰虚线）</button>
          <button className={`ctx-item ${edgeMenu.edge.type === 'chain' ? 'sel' : ''}`} onClick={() => changeEdgeKind('chain')}>chain · 链式参考（琥珀实线）</button>
          <button className={`ctx-item ${edgeMenu.edge.type === 'exec' ? 'sel' : ''}`} onClick={() => changeEdgeKind('exec')}>exec · 执行流（蓝实线）</button>
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { void client.deleteEdge(edgeMenu.edge.id); setEdgeMenu(null); }}><Icon name="trash" />删除连线</button>
        </div>
      )}
      {selected && (
        <div className="ne-float">
          {/* key=selected.id：切换选中节点时强制重挂载，重置面板内部 state，避免显示旧节点内容但保存到新节点 */}
          <NodeEditor key={selected.id} node={selected} onClose={() => setSelected(null)} />
        </div>
      )}
      <YamlExportDialog
        open={yamlExport !== null}
        yaml={yamlExport?.yaml ?? null}
        error={yamlExport?.error ?? null}
        onClose={() => setYamlExport(null)}
      />
      {/* 拖线类型校验被拒绝时的提示 */}
      {toast && <div className="canvas-toast">{toast}</div>}
    </div>
  );
}

export default function CanvasView(props: CanvasProps) {
  // ReactFlowProvider：让 CanvasInner 可用 useReactFlow（screenToFlowPosition/fitView）
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
