import type { WorkflowGraph } from '../api';

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export type WorkflowNodePositions = Record<string, WorkflowNodePosition>;

export function positionsFromGraph(graph: WorkflowGraph): WorkflowNodePositions {
  return Object.fromEntries(graph.nodes.map(node => [node.nodeId, { x: node.x, y: node.y }]));
}

export type WorkflowDragTarget = 'canvas' | 'node' | 'none';

export function dragTargetForMouse(button: number, onNode: boolean, onControl: boolean): WorkflowDragTarget {
  if (onControl) return 'none';
  if (button === 1) return 'canvas';
  if (button === 0 && onNode) return 'node';
  if (button === 0) return 'canvas';
  return 'none';
}

export function moveWorkflowNode(
  positions: WorkflowNodePositions,
  nodeId: string,
  deltaX: number,
  deltaY: number,
): WorkflowNodePositions {
  const current = positions[nodeId];
  if (!current) return { ...positions };
  return {
    ...positions,
    [nodeId]: { x: current.x + deltaX, y: current.y + deltaY },
  };
}
