import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import CanvasView from './CanvasView';
import { useGraphStore } from '../store/graph';
import type { Graph } from '../types';

// CanvasView 依赖真实 fetch 客户端（client.ts）；stub 后端写接口
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/nodes') && init?.method === 'POST') {
      return new Response(JSON.stringify({ node: { id: 'n-new', version: 1 } }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
}

const shotGraph: Graph = {
  projectName: 'demo',
  nodes: [{
    id: 'n1', type: 'shot', title: 'SHOT 01',
    fields: { duration: '3.75s' }, position: { x: 100, y: 100 }, version: 1,
  }],
  edges: [],
};

// 挂载后节点列表是空的，需再派发一次 store 变更（applyGraph）让订阅同步出节点
function syncNodes() {
  act(() => { useGraphStore.getState().applyGraph(shotGraph); });
}

beforeEach(() => {
  useGraphStore.setState({ graph: null, tasks: new Map(), chips: [] });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  useGraphStore.setState({ graph: null, tasks: new Map(), chips: [] });
});

describe('画布右键菜单', () => {
  it('右键空白画布弹出菜单，可新建分镜节点（POST /api/nodes，光标处坐标）', async () => {
    render(<CanvasView />);
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.contextMenu(pane!, { clientX: 260, clientY: 140 });
    expect(screen.getByText('＋ 新建分镜节点')).toBeInTheDocument();
    expect(screen.getByText('＋ 新建参数节点')).toBeInTheDocument();
    expect(screen.getByText('＋ 新建提示词节点')).toBeInTheDocument();
    expect(screen.getByText('⤢ 适应视图')).toBeInTheDocument();
    fireEvent.click(screen.getByText('＋ 新建分镜节点'));
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((c) => String(c[0]).includes('/api/nodes') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
    });
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find((c) => String(c[0]).includes('/api/nodes') && (c[1] as RequestInit)?.method === 'POST')!;
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.type).toBe('shot');
    expect(body.title).toBe('SHOT 01'); // 无分镜节点 → 编号 01
    expect(typeof body.position?.x).toBe('number');
  });

  it('右键菜单在 Esc 或点击菜单外时关闭', async () => {
    render(<CanvasView />);
    const pane = document.querySelector('.react-flow__pane');
    fireEvent.contextMenu(pane!, { clientX: 260, clientY: 140 });
    expect(screen.getByText('⤢ 适应视图')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('⤢ 适应视图')).not.toBeInTheDocument();
    // 再次打开后点击菜单外关闭
    fireEvent.contextMenu(pane!, { clientX: 260, clientY: 140 });
    expect(screen.getByText('⤢ 适应视图')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('⤢ 适应视图')).not.toBeInTheDocument();
  });
});

describe('节点右键菜单', () => {
  it('右键节点弹出编辑/加入对话/删除，删除回调携带节点信息', async () => {
    const onDelete = vi.fn();
    render(<CanvasView onDeleteNode={onDelete} />);
    syncNodes();
    const nodeEl = await waitFor(() => document.querySelector('.react-flow__node'));
    expect(nodeEl).not.toBeNull();
    fireEvent.contextMenu(nodeEl!, { clientX: 150, clientY: 150 });
    const menu = document.querySelector('.ctx-menu')!;
    expect(menu).not.toBeNull();
    // 作用域限定菜单内：'⇢ 加入对话' 也出现在节点底栏按钮中
    expect(within(menu as HTMLElement).getByText('✎ 编辑节点…')).toBeInTheDocument();
    expect(within(menu as HTMLElement).getByText('⇢ 加入对话')).toBeInTheDocument();
    expect(within(menu as HTMLElement).getByText('🗑 删除节点…')).toBeInTheDocument();
    fireEvent.click(within(menu as HTMLElement).getByText('🗑 删除节点…'));
    expect(onDelete).toHaveBeenCalledWith('n1', 'SHOT 01');
  });

  it('右键节点 → 编辑节点打开浮动编辑面板', async () => {
    render(<CanvasView />);
    syncNodes();
    const nodeEl = await waitFor(() => document.querySelector('.react-flow__node'));
    expect(nodeEl).not.toBeNull();
    fireEvent.contextMenu(nodeEl!, { clientX: 150, clientY: 150 });
    fireEvent.click(screen.getByText('✎ 编辑节点…'));
    expect(screen.getByText('编辑节点')).toBeInTheDocument();
    expect(screen.getByDisplayValue('SHOT 01')).toBeInTheDocument();
  });
});

describe('分镜多接口圆点', () => {
  it('带 targetHandle 的入边占用对应圆点，自动追加新圆点', async () => {
    render(<CanvasView />);
    act(() => {
      useGraphStore.getState().applyGraph({
        ...shotGraph,
        edges: [{ id: 'e1', kind: 'ref', source: 'n9', target: 'n1', targetHandle: 'text-0' }],
      });
    });
    const nodeEl = await waitFor(() => document.querySelector('.react-flow__node'));
    // text-0 被占用 → text-1 自动出现：chain + text×2 + video + image = 5 个输入圆点
    expect(nodeEl!.querySelectorAll('.react-flow__handle.target')).toHaveLength(5);
    expect(screen.getAllByText('剧情')).toHaveLength(1);
    expect(screen.getAllByText('文字')).toHaveLength(2);
    expect(screen.getAllByText('视频')).toHaveLength(1);
    expect(screen.getAllByText('图像')).toHaveLength(1);
  });

  it('旧边（无 targetHandle）连分镜时按源类型补齐渲染', async () => {
    render(<CanvasView />);
    act(() => {
      useGraphStore.getState().applyGraph({
        ...shotGraph,
        // chain 旧边 → 剧情接口；ref 旧边（prompt 源）→ 文字接口
        edges: [
          { id: 'e1', kind: 'ref', source: 'n9', target: 'n1' },
          { id: 'e2', kind: 'chain', source: 'n2', target: 'n1' },
        ],
      });
    });
    const nodeEl = await waitFor(() => document.querySelector('.react-flow__node'));
    // chain-0 占用（fixed 不追加）+ text-0 占用 → text-1：共 5 个
    expect(nodeEl!.querySelectorAll('.react-flow__handle.target')).toHaveLength(5);
    expect(nodeEl!.querySelector('.react-flow__handle.target[data-handleid="chain-0"]')).not.toBeNull();
  });
});

describe('Delete 键删除节点', () => {
  it('选中节点后按 Delete 同步后端删除', async () => {
    render(<CanvasView />);
    syncNodes();
    const nodeEl = await waitFor(() => document.querySelector('.react-flow__node'));
    expect(nodeEl).not.toBeNull();
    // 点击选中节点 → 按 Delete → ReactFlow 触发 onNodesDelete → 后端 DELETE
    fireEvent.click(nodeEl!);
    await waitFor(() => expect(nodeEl!.className).toContain('selected'));
    // React Flow 的键盘监听绑定在 document（useKeyPress 默认 target）
    fireEvent.keyDown(document, { key: 'Delete' });
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find((c) => String(c[0]).includes('/api/nodes/') && (c[1] as RequestInit)?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
    const del = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes('/api/nodes/') && (c[1] as RequestInit)?.method === 'DELETE')!;
    expect(String(del[0])).toContain('/api/nodes/n1?confirm=true');
  });
});

describe('素材拖到画布', () => {
  it('onDrop 解析素材数据并回调画布坐标（screenToFlowPosition）', async () => {
    const onAssetDrop = vi.fn();
    render(<CanvasView onAssetDrop={onAssetDrop} />);
    const rf = document.querySelector('.react-flow');
    expect(rf).not.toBeNull();
    const dt = new DataTransfer();
    dt.setData('application/x-asset', JSON.stringify({ id: 'a1', kind: 'img', name: 'x.png' }));
    fireEvent.drop(rf!, { dataTransfer: dt, clientX: 300, clientY: 200 });
    await waitFor(() => expect(onAssetDrop).toHaveBeenCalled());
    const [item, pos] = onAssetDrop.mock.calls[0];
    expect(item).toEqual({ id: 'a1', kind: 'img', name: 'x.png' });
    expect(typeof pos.x).toBe('number');
    expect(typeof pos.y).toBe('number');
  });
});

