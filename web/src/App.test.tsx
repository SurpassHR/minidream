import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  // mock fetch：/api/graph 返回空图；/api/snapshots 返回空；/api/comfy/health 返回已连接
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/snapshots')) {
      return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
    }
    if (String(url).includes('/api/comfy/health')) {
      return new Response(JSON.stringify({ healthy: true }), { status: 200 });
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
  it('渲染五区布局', () => {
    render(<App />);
    expect(screen.getByTestId('left-panel')).toBeInTheDocument();
    expect(screen.getByTestId('canvas')).toBeInTheDocument();
    expect(screen.getByTestId('agent-panel')).toBeInTheDocument();
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.getByTestId('queue')).toBeInTheDocument();
    expect(screen.getByTestId('project-name')).toHaveTextContent('elf_and_goblin');
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
