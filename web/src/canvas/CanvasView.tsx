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
import { edgeTypes } from './edges';
import { NodeEditor, type EditorNode } from './NodeEditor';
import type { DirectorEdge, DirectorNode, NodeType } from '../types';

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

function toFlowEdge(e: DirectorEdge): Edge {
  return { id: e.id, type: e.kind, source: e.source, target: e.target, label: e.label };
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
}

function CanvasInner({ onNodeSubmit, onDeleteNode }: CanvasProps) {
  const graph = useGraphStore((s) => s.graph);
  const addChip = useGraphStore((s) => s.addChip);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<EditorNode | null>(null);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // WS 回推图时同步（后端为唯一事实来源）；订阅放 useEffect 避免重复注册
  useEffect(() => {
    return useGraphStore.subscribe((s) => {
      if (s.graph) {
        setNodes(s.graph.nodes.map((n) => toFlowNode(n, { onSubmit: onNodeSubmit, addChip })));
        setEdges(s.graph.edges.map(toFlowEdge));
      }
    });
  }, [setNodes, setEdges, onNodeSubmit, addChip]);

  const onNodeDragStop = useCallback((_e: unknown, node: FlowNode) => {
    void client.moveNode(node.id, node.position);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    void client.createEdge({ kind: 'ref', source: c.source, target: c.target });
    setEdges((eds) => addEdge({ ...c, type: 'ref' }, eds));
  }, [setEdges]);

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
        onConnect={onConnect}
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
              <button className="ctx-item" onClick={() => { void fitView({ padding: 0.15 }); closeMenu(); }}>⤢ 适应视图</button>
            </>
          ) : (
            <>
              <button className="ctx-item" onClick={() => openEditor(menu.node!)}>✎ 编辑节点…</button>
              <button className="ctx-item" onClick={() => { addChip(`@ ${menu.node!.title}`); closeMenu(); }}>⇢ 加入对话</button>
              <div className="ctx-sep" />
              <button
                className="ctx-item danger"
                onClick={() => { onDeleteNode?.(menu.node!.id, menu.node!.title); closeMenu(); }}
              >🗑 删除节点…</button>
            </>
          )}
        </div>
      )}
      {selected && (
        <div className="ne-float">
          {/* key=selected.id：切换选中节点时强制重挂载，重置面板内部 state，避免显示旧节点内容但保存到新节点 */}
          <NodeEditor key={selected.id} node={selected} onClose={() => setSelected(null)} />
        </div>
      )}
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

