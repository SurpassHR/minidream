import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  // 面板尺寸持久化隔离：拖拽测试不污染其他用例
  localStorage.clear();
  // mock fetch：/api/graph 返回空图；/api/snapshots 返回空；/api/comfy/health 返回已连接
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/snapshots')) {
      return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
    }
    if (String(url).includes('/api/comfy/health')) {
      return new Response(JSON.stringify({ healthy: true }), { status: 200 });
    }
    if (String(url).includes('/api/project/switch')) {
      return new Response(JSON.stringify({
        graph: { projectName: 'b', nodes: [], edges: [] },
        // 后端已不按 current 重排：固定名称顺序 t → b，current 只标记高亮
        projects: [
          { path: '/p/t', name: 't', current: false, shots: 2, duration: 7.5, mode: 'KEYFRAME' },
          { path: '/p/b', name: 'b', current: true, shots: 1, duration: 3.75, mode: '' },
        ],
      }), { status: 200 });
    }
    if (String(url).includes('/api/projects')) {
      return new Response(JSON.stringify({ projects: [
        { path: '/p/t', name: 't', current: true, shots: 2, duration: 7.5, mode: 'KEYFRAME' },
        { path: '/p/b', name: 'b', current: false, shots: 1, duration: 3.75, mode: '' },
      ] }), { status: 200 });
    }
    if (String(url).includes('/api/agent/models')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (String(url).includes('/api/assets')) {
      return new Response(JSON.stringify({ assets: [] }), { status: 200 });
    }
    if (String(url).includes('/api/story')) {
      return new Response(JSON.stringify({ story: { step: 0, answers: {}, completedAt: null } }), { status: 200 });
    }
    if (String(url).includes('/api/designs')) {
      return new Response(JSON.stringify({ designs: [] }), { status: 200 });
    }
    if (String(url).includes('/api/workflows')) {
      return new Response(JSON.stringify({ workflows: ['test-t2i'] }), { status: 200 });
    }
    if (String(url).includes('/api/settings')) {
      return new Response(JSON.stringify({ settings: { comfyUrl: '', agentModel: '', agentThinking: '' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ graph: { projectName: 't', nodes: [], edges: [] } }), { status: 200 });
  }));
  // mock WebSocket：App 挂载会发起 WS 连接
  vi.stubGlobal('WebSocket', class {
    onmessage: ((e: unknown) => {}) | null = null;
    onopen: (() => {}) | null = null;
    onclose: (() => {}) | null = null;
    onerror: (() => {}) | null = null;
    close() {}
    send() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App 布局骨架', () => {
  it('渲染五区布局（项目名与项目栏来自真实接口）', async () => {
    render(<App />);
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.getByTestId('versions')).toBeInTheDocument();
    expect(screen.getByTestId('queue')).toBeInTheDocument();
    // 图/项目列表异步到达后：头部项目名 + 展开下拉后项目列表渲染真实数据（当前项目 + 统计）
    await waitFor(() => expect(screen.getByTestId('project-name')).toHaveTextContent('t'));
    fireEvent.click(screen.getByTestId('project-name'));
    await waitFor(() => expect(screen.getByTestId('project-t')).toBeInTheDocument());
    expect(screen.getByText('2 分镜 · 7.5s')).toBeInTheDocument();
  });

  it('顶栏包含运行流水线按钮', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /运行流水线/ })).toBeInTheDocument();
  });

  it('ComfyUI 健康检查后显示已连接徽章', async () => {
    render(<App />);
    expect(await screen.findByText(/COMFYUI/)).toBeInTheDocument();
    expect(await screen.findByText(/已连接/)).toBeInTheDocument();
  });
});

describe('顶栏项目切换器高亮', () => {
  it('点击项目只切换高亮，不调整列表顺序', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('project-name')).toHaveTextContent('t'));
    // 展开下拉
    fireEvent.click(screen.getByTestId('project-name'));
    await waitFor(() => expect(screen.getByTestId('project-dropdown')).toBeInTheDocument());
    const items = () => Array.from(document.querySelectorAll('.ps-item'));
    expect(items()).toHaveLength(2);
    expect(items()[0]!.classList.contains('active')).toBe(true); // t 首位高亮
    // 点击 b：只移动高亮，t 仍在首位
    fireEvent.click(screen.getByTestId('project-b'));
    await waitFor(() => expect(screen.getByTestId('project-name')).toHaveTextContent('b'));
    // 重新展开查看高亮顺序
    fireEvent.click(screen.getByTestId('project-name'));
    await waitFor(() => expect(screen.getByTestId('project-dropdown')).toBeInTheDocument());
    expect(items()[0]!.querySelector('.pname')?.textContent).toBe('t');
    expect(items()[0]!.classList.contains('active')).toBe(false);
    expect(items()[1]!.querySelector('.pname')?.textContent).toBe('b');
    expect(items()[1]!.classList.contains('active')).toBe(true);
  });
});

describe('App 面板分割条', () => {
  it('拖拽左分割条改变左栏宽度并持久化', async () => {
    render(<App />);
    const left = screen.getByTestId('left-panel');
    expect(left.style.flexBasis).toBe('270px');
    // 模拟拖拽：按下 → window 移动 +100px → 抬起
    fireEvent.mouseDown(screen.getByTestId('splitter-left'), { clientX: 300, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 400, clientY: 100 });
    fireEvent.mouseUp(window);
    expect(left.style.flexBasis).toBe('370px');
    expect(localStorage.getItem('dw:leftW')).toBe('370');
  });

  it('拖拽下分割条改变底部高度，双击恢复默认', async () => {
    render(<App />);
    const footer = screen.getByTestId('timeline').closest('.footer') as HTMLElement;
    expect(footer.style.height).toBe('148px');
    fireEvent.mouseDown(screen.getByTestId('splitter-footer'), { clientX: 100, clientY: 400 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 300 }); // 上移 100 → 高度 +100
    fireEvent.mouseUp(window);
    expect(footer.style.height).toBe('248px');
    // 双击恢复默认并清除持久化
    fireEvent.doubleClick(screen.getByTestId('splitter-footer'));
    expect(footer.style.height).toBe('148px');
    expect(localStorage.getItem('dw:footerW')).toBeNull();
  });

  it('面板尺寸有上下限（不会拖没）', () => {
    render(<App />);
    const left = screen.getByTestId('left-panel');
    fireEvent.mouseDown(screen.getByTestId('splitter-left'), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: -5000, clientY: 100 });
    fireEvent.mouseUp(window);
    expect(left.style.flexBasis).toBe('200px'); // 最小 200
  });
});

describe('角色路由 tab', () => {
  it('顶栏渲染三个角色 tab，默认高亮画布', async () => {
    render(<App />);
    expect(screen.getByTestId('tab-story-teller')).toBeInTheDocument();
    expect(screen.getByTestId('tab-object-designer')).toBeInTheDocument();
    expect(screen.getByTestId('tab-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('tab-canvas').className).toContain('active');
    // 默认路由渲染画布
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
  });

  it('点击故事向导 tab 切换到向导视图（URL hash 同步）', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('tab-story-teller'));
    await waitFor(() => expect(screen.getByTestId('story-teller-view')).toBeInTheDocument());
    expect(screen.getByTestId('tab-story-teller').className).toContain('active');
    // 画布隐藏
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    // hash 已更新
    expect(window.location.hash).toBe('#/story-teller');
  });

  it('hash 初始化直接进入对应视图', async () => {
    window.location.hash = '#/object-designer';
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('object-designer-view')).toBeInTheDocument());
    window.location.hash = '';
  });
});