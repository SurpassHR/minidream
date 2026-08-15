import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { BaseEdge, Position, type EdgeProps, getBezierPath, useReactFlow } from '@xyflow/react';
import { useGraphStore } from '../store/graph';
import { client } from '../api/client';

// 贝塞尔连线：控制点跟随 handle 实际位置（左右进出），曲率 0.35 更舒展；
// 带方向箭头（markerEnd）表达语义方向（chain 顺序、ref 指向）。
// target 端自带拖拽点（HTML overlay，屏幕坐标定位）：拖到空白释放 = 断开删除；
// 拖到另一节点释放 = 重连（类型按新端点推断）。
// 拖拽中贝塞尔终点实时跟随光标（曲线跟着走），释放时按命中结果断开/重连。
// 坐标说明：ReactFlow 的 svg 用户单位与节点 DOM 的映射存在约半个 handle 宽的偏差，
// 拖拽点用 HTML 层 + 屏幕坐标（与 handle 圆点像素级对齐），曲线仍用 ReactFlow 原生坐标。
// 说明：不使用 ReactFlow 的 onReconnect/onReconnectEnd——两者同时存在时
// （或引用稳定时）存在导致边不渲染的边缘 bug，自绘拖拽点完全可控。
function makeEdge(color: string, dash?: string) {
  return function Edge(props: EdgeProps) {
    const { deleteElements, getZoom, getNodes } = useReactFlow();
    // 拖拽中光标位置（屏幕坐标）；非拖拽时拖拽点锚定在 target handle 圆点上
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
    // 渲染时实时测量 target handle 圆点的屏幕中心（节点移动/缩放时自动更新）
    const tgtEl = document.querySelector(`.react-flow__node[data-id="${props.target}"]`)
      ?.querySelector('.react-flow__handle.target')
      ?? document.querySelector(`.react-flow__node[data-id="${props.target}"]`)?.querySelector('.react-flow__handle');
    let anchor: { x: number; y: number } | null = null;
    if (tgtEl) {
      const r = tgtEl.getBoundingClientRect();
      anchor = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const dragScreen = dragPos ?? anchor ?? { x: 0, y: 0 };

    // 曲线终点（拖拽中）：用节点权威坐标 + DOM 实测计算 viewport 映射，
    // 完全避开 ReactFlow 内部映射偏差（screenToFlowPosition 与 svg 渲染有 ~5.8px 往返差）：
    // 1) 由 source 节点算出 屏幕↔画布 的 offset（节点 position 是权威画布坐标）
    // 2) target 圆点画布 = (圆点屏幕 - offset) / zoom
    // 3) 拖拽终点 = 圆点画布 + (光标 - 圆点屏幕) / zoom —— 光标处精确落点
    const zoom = getZoom();
    const srcFlowNode = getNodes().find((n) => n.id === props.source);
    const srcNodeEl = document.querySelector(`.react-flow__node[data-id="${props.source}"]`);
    const srcNodeRect = srcNodeEl?.getBoundingClientRect();
    const viewportOffset = srcFlowNode && srcNodeRect
      ? { x: srcNodeRect.x - srcFlowNode.position.x * zoom, y: srcNodeRect.y - srcFlowNode.position.y * zoom }
      : null;
    const anchorFlow = viewportOffset && anchor
      ? { x: (anchor.x - viewportOffset.x) / zoom, y: (anchor.y - viewportOffset.y) / zoom }
      : null;
    const targetFlow = dragPos && anchorFlow && anchor
      ? { x: anchorFlow.x + (dragPos.x - anchor.x) / zoom, y: anchorFlow.y + (dragPos.y - anchor.y) / zoom }
      : null;
    const targetX = targetFlow?.x ?? props.targetX;
    const targetY = targetFlow?.y ?? props.targetY;
    // 拖拽中保持原始 handle 方向进出（不随光标切换 Left/Right）：
    // 方向翻转会让曲线从新方向绕进终点、箭头跟着转向（“跑到右侧又拐回来”），
    // 保持原方向曲线像橡皮筋自然拉伸，箭头方向稳定
    const targetPos = props.targetPosition;
    const [path, labelX, labelY] = getBezierPath({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition,
      targetX,
      targetY,
      targetPosition: targetPos,
      curvature: 0.35,
    });
    const markerId = `director-arrow-${props.id}`;

    // 释放：命中原 target 圆点 → 取消拖拽（边保持原样）；命中其他节点 → 重连；
    // 空白 → 断开删除。
    // 用 deleteElements 本地立即移除（无闪回：不会先回到原始位置再消失），
    // 后端删除由 CanvasView 的 onEdgesDelete 回调同步（deleteElements 触发）
    const onTargetPointerUp = useCallback((e: React.PointerEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      let hit: string | null = null;
      for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          hit = el.dataset.id ?? null;
          if (hit) break;
        }
      }
      if (hit === props.target) {
        // 放回原 target 圆点：取消拖拽，边保持原样（不删不建，id 不变）
        setDragPos(null);
        return;
      }
      if (hit && hit !== props.source) {
        // 重连：本地移除旧边 + 删后端旧边 + 建新边（类型按新端点推断）。
        // 注意：不在此处 setDragPos(null)——deleteElements 内部有 await（异步），
        // 提前重置会让曲线先闪回原始位置再消失；保持拖拽位置直到边移除（组件卸载）
        const typeOf = (id: string) => useGraphStore.getState().graph?.nodes.find((n) => n.id === id)?.type;
        const st = typeOf(props.source);
        const tt = typeOf(hit);
        const kind = st === 'shot' && tt === 'shot' ? 'chain'
          : st === 'generation' || tt === 'generation' ? 'exec'
          : 'ref';
        void deleteElements({ edges: [{ id: props.id }] });
        void client.createEdge({ kind, source: props.source, target: hit });
      } else if (!hit) {
        // 空白释放：断开连接（本地移除 + onEdgesDelete 同步后端）；同上不重置 dragPos
        void deleteElements({ edges: [{ id: props.id }] });
      } else {
        // 拖回源节点自身：忽略（不变），重置拖拽位置
        setDragPos(null);
      }
    }, [props.id, props.source, props.target, deleteElements]);

    const onTargetPointerMove = useCallback((e: React.PointerEvent) => {
      if (!dragPos) return;
      setDragPos({ x: e.clientX, y: e.clientY });
    }, [dragPos]);

    const dragHandle = (
      <div
        className="edge-drag-handle"
        style={{ left: dragScreen.x, top: dragScreen.y }}
        onPointerDown={(e) => {
          e.stopPropagation();
          setDragPos({ x: e.clientX, y: e.clientY });
          try {
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
          } catch {
            /* 忽略 */
          }
        }}
        onPointerMove={onTargetPointerMove}
        onPointerUp={onTargetPointerUp}
      />
    );

    return (
      <>
        <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          </defs>
        </svg>
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={`url(#${markerId})`}
          style={{ stroke: color, strokeWidth: 1.5, strokeDasharray: dash }}
        />
        {props.label && (
          <text x={labelX} y={labelY - 8} textAnchor="middle" className="elabel" style={{ fill: 'var(--amber-soft)' }}>
            {String(props.label)}
          </text>
        )}
        {/* 拖拽点：HTML overlay（屏幕坐标），与 handle 圆点像素级对齐 */}
        {createPortal(dragHandle, document.querySelector('.canvas-wrap') ?? document.body)}
      </>
    );
  };
}

export const edgeTypes = {
  ref: makeEdge('#3A4356', '4 3'),   // 灰虚线=创作引用
  chain: makeEdge('var(--amber)'),  // 琥珀实线=链式参考
  exec: makeEdge('var(--blue)'),    // 蓝实线=执行流
};
