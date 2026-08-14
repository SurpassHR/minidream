import { BaseEdge, type EdgeProps, getBezierPath } from '@xyflow/react';

function makeEdge(color: string, dash?: string) {
  return function Edge(props: EdgeProps) {
    const [path, labelX, labelY] = getBezierPath({
      sourceX: props.sourceX, sourceY: props.sourceY,
      targetX: props.targetX, targetY: props.targetY,
    });
    return (
      <>
        <BaseEdge id={props.id} path={path} style={{ stroke: color, strokeWidth: 1.5, strokeDasharray: dash }} />
        {props.label && (
          <text x={labelX} y={labelY - 8} textAnchor="middle" className="elabel" style={{ fill: 'var(--amber-soft)' }}>
            {String(props.label)}
          </text>
        )}
      </>
    );
  };
}

export const edgeTypes = {
  ref: makeEdge('#3A4356', '4 3'),   // 灰虚线=创作引用
  chain: makeEdge('var(--amber)'),  // 琥珀实线=链式参考
  exec: makeEdge('var(--blue)'),    // 蓝实线=执行流
};
