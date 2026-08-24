import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowGraph, WorkflowGraphField, WorkflowGraphNode } from '../api';
import { dragTargetForMouse, moveWorkflowNode, positionsFromGraph, type WorkflowNodePositions } from './workflowNodeLayout';
import FilterSelect from './FilterSelect';
import MultiFilterSelect, { type MultiSelectItem } from './MultiFilterSelect';
import './WorkflowNodeGraph.css';

interface Props {
  graph: WorkflowGraph | null;
  loading?: boolean;
  error?: string | null;
  onToggleParam: (field: WorkflowGraphField) => void;
  onChangeParamDefault: (field: WorkflowGraphField, value: unknown) => void;
  onRemoveParam?: (field: WorkflowGraphField) => void;
  onRetry?: () => void;
  onFullscreen?: () => void;
  fullscreen?: boolean;
}

const NODE_WIDTH = 300;
const NODE_HEADER = 58;
const FIELD_HEIGHT = 34;

function asMultiItems(value: unknown): MultiSelectItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [{ name: item, strength: 1 }];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (typeof record.name === 'string' && record.name.trim()) {
        return [{ name: record.name, strength: typeof record.strength === 'number' ? record.strength : 1 }];
      }
    }
    return [];
  });
}

function displayValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value.length > 26 ? `${value.slice(0, 26)}…` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 26 ? `${text.slice(0, 26)}…` : text;
  } catch {
    return String(value);
  }
}

function nodeHeight(node: WorkflowGraphNode): number {
  return NODE_HEADER + Math.max(1, node.fields.length) * FIELD_HEIGHT + 22;
}

function fieldKey(nodeId: string, field: string): string {
  return `${nodeId}:${field}`;
}

export default function WorkflowNodeGraph({ graph, loading, error, onToggleParam, onChangeParamDefault, onRemoveParam, onRetry, onFullscreen, fullscreen }: Props) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(0.72);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [positions, setPositions] = useState<WorkflowNodePositions>({});
  const dragRef = useRef<{
    target: 'canvas' | 'node';
    nodeId?: string;
    x: number;
    y: number;
    panX: number;
    panY: number;
    positions: WorkflowNodePositions;
  } | null>(null);

  const layoutKey = useMemo(
    () => graph?.nodes.map(node => `${node.nodeId}:${node.x}:${node.y}`).join('|') ?? '',
    [graph],
  );

  useEffect(() => {
    if (!graph) return;
    setPositions(positionsFromGraph(graph));
  }, [layoutKey]);

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map(node => [node.nodeId, node])), [graph]);
  const positionOf = (node: WorkflowGraphNode) => positions[node.nodeId] ?? { x: node.x, y: node.y };
  const bounds = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const maxX = Math.max(900, ...nodes.map(node => positionOf(node).x + NODE_WIDTH + 80));
    const maxY = Math.max(600, ...nodes.map(node => positionOf(node).y + nodeHeight(node) + 80));
    return { width: maxX, height: maxY };
  }, [graph, positions]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const nodeElement = target.closest<HTMLElement>('.workflow-graph-node');
    const control = Boolean(target.closest('input,button,select,textarea,a'));
    const dragTarget = dragTargetForMouse(event.button, Boolean(nodeElement), control);
    if (dragTarget === 'none') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (dragTarget === 'node' && nodeElement?.dataset.nodeId) {
      const nodeId = nodeElement.dataset.nodeId;
      const current = positions[nodeId] ?? positionOf(nodeById.get(nodeId)!);
      setPositions(previous => previous[nodeId] ? previous : { ...previous, [nodeId]: current });
      dragRef.current = { target: 'node', nodeId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, positions: { ...positions, [nodeId]: current } };
      return;
    }
    dragRef.current = { target: 'canvas', x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, positions };
  };

  const moveCanvas = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaX = clientX - drag.x;
    const deltaY = clientY - drag.y;
    if (drag.target === 'node' && drag.nodeId) {
      setPositions(moveWorkflowNode(drag.positions, drag.nodeId, deltaX / scale, deltaY / scale));
      return;
    }
    setPan({ x: drag.panX + deltaX, y: drag.panY + deltaY });
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    moveCanvas(event.clientX, event.clientY);
  };

  const moveMouse = (event: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      event.preventDefault();
      moveCanvas(event.clientX, event.clientY);
    }
  };

  const endPointer = () => {
    dragRef.current = null;
  };

  const zoom = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setScale(value => Math.max(0.45, Math.min(1.3, value * (event.deltaY < 0 ? 1.08 : 0.92))));
  };

  if (loading) {
    return <div className="workflow-graph-state"><span className="workflow-graph-spinner" />{t('nodeGraph.loading')}</div>;
  }
  if (error) {
    return (
      <div className="workflow-graph-state workflow-graph-state-error">
        <strong>{t('nodeGraph.loadError')}</strong>
        <span>{error}</span>
        {onRetry && <button className="settings-btn" onClick={onRetry}>{t('common.retry')}</button>}
      </div>
    );
  }
  if (!graph || graph.nodes.length === 0) {
    return <div className="workflow-graph-state">{t('nodeGraph.empty')}</div>;
  }

  const pointFor = (nodeId: string, field: string, side: 'source' | 'target') => {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    const position = positionOf(node);
    const index = Math.max(0, node.fields.findIndex(item => item.field === field));
    return {
      x: position.x + (side === 'source' ? NODE_WIDTH : 0),
      y: position.y + NODE_HEADER + index * FIELD_HEIGHT + FIELD_HEIGHT / 2 + 10,
    };
  };

  return (
    <div className="workflow-graph-shell">
      <div className="workflow-graph-toolbar">
        <span>{t('nodeGraph.toolbarHint')}</span>
        <div className="workflow-graph-toolbar-actions">
          <span className="workflow-graph-zoom">{Math.round(scale * 100)}%</span>
          {onFullscreen && <button className="workflow-graph-action" onClick={onFullscreen}>{fullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}</button>}
        </div>
      </div>
      <div
        className="workflow-graph-viewport"
        style={{
          backgroundPosition: `${pan.x}px ${pan.y}px`,
          backgroundSize: `${24 * scale}px ${24 * scale}px`,
        }}
        onPointerDown={beginDrag}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onMouseMove={moveMouse}
        onMouseUp={endPointer}
        onContextMenu={event => event.preventDefault()}
        onAuxClick={event => { if (event.button === 1) event.preventDefault(); }}
        onWheel={zoom}
      >
        <div className="workflow-graph-world" style={{ width: bounds.width, height: bounds.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
          <svg className="workflow-graph-edges" width={bounds.width} height={bounds.height} aria-hidden="true">
            {graph.edges.map(edge => {
              const source = pointFor(edge.sourceNode, edge.sourceField, 'source');
              const target = pointFor(edge.targetNode, edge.targetField, 'target');
              if (!source || !target) return null;
              const distance = Math.max(50, Math.abs(target.x - source.x) * 0.45);
              return (
                <path
                  key={`${edge.sourceNode}:${edge.sourceField}->${edge.targetNode}:${edge.targetField}`}
                  className="workflow-graph-edge"
                  d={`M ${source.x} ${source.y} C ${source.x + distance} ${source.y}, ${target.x - distance} ${target.y}, ${target.x} ${target.y}`}
                />
              );
            })}
          </svg>
          <div className="workflow-graph-nodes">
            {graph.nodes.map(node => {
              const position = positionOf(node);
              return (
                <article key={node.nodeId} data-node-id={node.nodeId} className="workflow-graph-node" style={{ left: position.x, top: position.y, width: NODE_WIDTH }}>
                  <header className="workflow-graph-node-head" onContextMenu={event => event.preventDefault()} title={t('nodeGraph.dragHint')}>
                    <strong>{node.title || node.classType}</strong>
                    <span>#{node.nodeId}</span>
                    <small>{node.classType}</small>
                  </header>
                  <div className="workflow-graph-node-fields">
                    {node.fields.map(field => {
                      const key = fieldKey(node.nodeId, field.field);
                      const linkedTo = field.connection ? `← ${field.connection.sourceNode}.${field.connection.sourceField}` : '';
                      return (
                        <div key={key} className={`workflow-graph-field${field.selected ? ' selected' : ''}${field.connected ? ' connected' : ''}`}>
                          <span className={`workflow-graph-port ${field.connected ? 'linked' : ''}`} />
                          {field.selectable ? (
                            <input
                              type="checkbox"
                              checked={field.selected}
                              onChange={() => onToggleParam(field)}
                              onPointerDown={event => event.stopPropagation()}
                              aria-label={t('nodeGraph.toggleAria', { node: node.nodeId, field: field.field })}
                              title={t('nodeGraph.toggleTitle')}
                            />
                          ) : <span className="workflow-graph-lock" aria-label={t('nodeGraph.lockedAria')}>↔</span>}
                          <span className="workflow-graph-field-name">{field.field}</span>
                          <span className="workflow-graph-field-type">{field.type}</span>
                          <span className="workflow-graph-field-value" title={linkedTo || displayValue(field.value)}>{linkedTo || displayValue(field.value)}</span>
                          {field.selectable && field.type === 'COMBO' && field.options?.length && (
                            <div className="workflow-graph-combo-control" onPointerDown={event => event.stopPropagation()}>
                              {field.multiple ? (
                                <MultiFilterSelect
                                  className="workflow-graph-combo-select"
                                  value={asMultiItems(field.value)}
                                  onChange={items => onChangeParamDefault(field, items)}
                                  options={field.options}
                                  ariaLabel={`${node.nodeId}.${field.field}`}
                                  searchPlaceholder={t('nodeGraph.filterPlaceholder', { field: field.field })}
                                  defaultStrength={1}
                                  strengthMin={field.strengthable ? (field.min ?? -10) : -10}
                                  strengthMax={field.strengthable ? (field.max ?? 10) : 10}
                                  strengthStep={field.strengthable ? (field.step ?? 0.05) : 0.05}
                                />
                              ) : (
                                <FilterSelect
                                  className="workflow-graph-combo-select"
                                  value={typeof field.value === 'string' ? field.value : ''}
                                  onChange={value => onChangeParamDefault(field, value)}
                                  options={field.options}
                                  ariaLabel={`${node.nodeId}.${field.field}`}
                                  searchPlaceholder={t('nodeGraph.filterPlaceholder', { field: field.field })}
                                />
                              )}
                              {field.paramId && !field.selected && (
                                <button
                                  type="button"
                                  className="workflow-graph-combo-reset"
                                  title={t('nodeGraph.resetTitle')}
                                  aria-label={t('nodeGraph.resetAria', { node: node.nodeId, field: field.field })}
                                  onClick={() => onRemoveParam?.(field)}
                                >×</button>
                              )}
                            </div>
                          )}
                          {field.paramId && <span className={`workflow-graph-param-mark${field.selected ? '' : ' pinned'}`}>{field.selected ? (field.paramId || t('nodeGraph.param')) : t('nodeGraph.pinned')}</span>}
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
