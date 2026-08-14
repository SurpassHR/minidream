import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow, Background, type Connection, type Edge, type Node,
  addEdge, useEdgesState, useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../store/graph';
import { client } from '../api/client';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { NodeEditor, type EditorNode } from './NodeEditor';
import type { DirectorEdge, DirectorNode } from '../types';

function toFlowNode(
  n: DirectorNode,
  opts: { onSubmit?: (nodeId: string) => void; addChip?: (name: string) => void } = {},
): Node {
  const data: Record<string, unknown> = { title: n.title, fields: n.fields };
  // 生成节点注入提交回调：按钮点击 → App 弹确认门
  if (n.type === 'generation' && opts.onSubmit) {
    data.onSubmit = () => opts.onSubmit?.(n.id);
  }
  // 所有节点注入“加入对话”回调：chips 显示名 @ 标题
  if (opts.addChip) {
    data.addChip = () => opts.addChip?.(`@ ${n.title}`);
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

export default function CanvasView({ onNodeSubmit }: { onNodeSubmit?: (nodeId: string) => void }) {
  const graph = useGraphStore((s) => s.graph);
  const addChip = useGraphStore((s) => s.addChip);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<EditorNode | null>(null);

  // WS 回推图时同步（后端为唯一事实来源）；订阅放 useEffect 避免重复注册
  useEffect(() => {
    return useGraphStore.subscribe((s) => {
      if (s.graph) {
        setNodes(s.graph.nodes.map((n) => toFlowNode(n, { onSubmit: onNodeSubmit, addChip })));
        setEdges(s.graph.edges.map(toFlowEdge));
      }
    });
  }, [setNodes, setEdges, onNodeSubmit, addChip]);

  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    void client.moveNode(node.id, node.position);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    void client.createEdge({ kind: 'ref', source: c.source, target: c.target });
    setEdges((eds) => addEdge({ ...c, type: 'ref' }, eds));
  }, [setEdges]);

  // 点击节点 → 右上浮动编辑面板；点击空白 → 关闭
  const onNodeClick = useCallback((_e: unknown, n: Node) => {
    setSelected({
      id: n.id,
      title: String(n.data.title ?? ''),
      fields: (n.data.fields ?? {}) as Record<string, unknown>,
    });
  }, []);

  const onPaneClick = useCallback(() => setSelected(null), []);

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
        onConnect={onConnect}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} color="#141B27" />
      </ReactFlow>
      {/* 签名元素 ①：取景器四角 L 角标 */}
      <div className="vf tl" /><div className="vf tr" />
      <div className="vf bl" /><div className="vf br" />
      {!graph?.nodes.length && (
        <div className="canvas-empty">
          空画布——在左侧素材库拖入素材，或让 agent 生成分镜
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
