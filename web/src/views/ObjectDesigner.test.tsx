import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ObjectDesignerView } from './ObjectDesignerView';

let designs: Record<string, unknown>[] = [];

beforeEach(() => {
  designs = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/agent/chat')) {
      // AI 优化流式：两帧 chunk（帧间 50ms 延迟模拟流式，期间允许用户切换选中对象）+ DONE
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"chunk":"+A1"}\n\n'));
          await new Promise((r) => setTimeout(r, 50));
          controller.enqueue(encoder.encode('data: {"chunk":"+A2"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (u.includes('/api/workflows')) {
      return new Response(JSON.stringify({ workflows: ['test-t2i', 'anime-img'] }), { status: 200 });
    }
    // 注意：generate 是 POST /api/designs/:id/generate，必须先于 create（POST /api/designs）匹配
    if (u.includes('/api/designs') && method === 'POST' && u.includes('/generate')) {
      const id = u.split('/')[u.split('/').length - 2];
      designs = designs.map((d: Record<string, unknown>) => d.id === id ? { ...d, status: 'done', assetId: 'a1' } : d);
      return new Response(JSON.stringify({ design: designs.find((d: Record<string, unknown>) => d.id === id) }), { status: 200 });
    }
    if (u.includes('/api/designs') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { kind: string; name: string };
      const d = { id: 'd1', kind: body.kind, name: body.name, description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 };
      designs = [...designs, d];
      return new Response(JSON.stringify({ design: d }), { status: 201 });
    }
    if (u.includes('/api/designs') && method === 'PUT') {
      const id = u.split('/').pop();
      const patch = (JSON.parse(String(init?.body)) as { patch: Record<string, unknown> }).patch;
      designs = designs.map((d: Record<string, unknown>) => d.id === id ? { ...d, ...patch } : d);
      return new Response(JSON.stringify({ design: designs.find((d: Record<string, unknown>) => d.id === id) }), { status: 200 });
    }
    if (u.includes('/api/designs')) {
      return new Response(JSON.stringify({ designs }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('ObjectDesignerView', () => {
  it('三类分组 + 空态', async () => {
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('人物')).toBeInTheDocument());
    expect(screen.getByText('场景')).toBeInTheDocument();
    expect(screen.getByText('物品')).toBeInTheDocument();
    // 三个空分组各自显示空态（getAllByText：空态存在性断言，避免单数匹配多元素报错）
    expect(screen.getAllByText(/暂无设计/).length).toBeGreaterThan(0);
  });

  it('新建对象出现在列表并可选中编辑', async () => {
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('人物')).toBeInTheDocument());
    fireEvent.click(screen.getByText('＋ 新建'));
    // 新建弹层
    const input = screen.getByPlaceholderText('对象名称');
    fireEvent.change(input, { target: { value: '精灵骑士' } });
    fireEvent.click(screen.getByText('创建'));
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
  });

  it('选中对象后表单显示并可编辑描述', async () => {
    designs = [{ id: 'd1', kind: 'character', name: '精灵骑士', description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
    fireEvent.click(screen.getByText('精灵骑士'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('精灵骑士'));
    fireEvent.change(screen.getByTestId('design-desc'), { target: { value: '银发绿眸' } });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/designs/d1'),
      expect.objectContaining({ method: 'PUT' }),
    ));
  });

  it('生成参考图：状态流转 done 后显示缩略图', async () => {
    designs = [{ id: 'd1', kind: 'scene', name: '迷雾森林', description: '雾气弥漫', style: '吉卜力风', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('迷雾森林')).toBeInTheDocument());
    fireEvent.click(screen.getByText('迷雾森林'));
    await waitFor(() => expect(screen.getByText('⚙ 生成参考图')).toBeInTheDocument());
    fireEvent.click(screen.getByText('⚙ 生成参考图'));
    await waitFor(() => expect(screen.getByAltText('参考图')).toBeInTheDocument());
    expect((screen.getByAltText('参考图') as HTMLImageElement).src).toContain('/api/assets/a1/file');
  });

  it('连续编辑两个字段：防抖后两个字段都保存（合并 patch，不丢中间修改）', async () => {
    designs = [{ id: 'd1', kind: 'character', name: '精灵骑士', description: '', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 }];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('精灵骑士')).toBeInTheDocument());
    fireEvent.click(screen.getByText('精灵骑士'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('精灵骑士'));
    // 同一防抖窗口内连续修改两个字段：先改 name，再改 description
    fireEvent.change(screen.getByTestId('design-name'), { target: { value: '精灵骑士王' } });
    fireEvent.change(screen.getByTestId('design-desc'), { target: { value: '银发绿眸' } });
    // 等待超过防抖窗口（500ms）+ PUT 执行
    await new Promise((r) => setTimeout(r, 700));
    // 最后一次（唯一一次）PUT 必须同时携带两个字段
    const puts = vi.mocked(globalThis.fetch).mock.calls.filter(
      ([url, init]) => String(url).includes('/api/designs/d1') && init?.method === 'PUT',
    );
    expect(puts.length).toBeGreaterThan(0);
    const lastBody = JSON.parse(String(puts[puts.length - 1]![1]!.body)) as { patch: Record<string, unknown> };
    expect(lastBody.patch.name).toBe('精灵骑士王');
    expect(lastBody.patch.description).toBe('银发绿眸');
  });

  it('AI 优化期间切换到其他对象：描述不被污染', async () => {
    designs = [
      { id: 'a', kind: 'character', name: '角色A', description: 'A描述', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 },
      { id: 'b', kind: 'character', name: '角色B', description: 'B描述', style: '', template: 'test-t2i', status: 'draft', createdAt: 1 },
    ];
    render(<ObjectDesignerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText('角色A')).toBeInTheDocument());
    // 选中 A 并触发 AI 优化（流式分帧：第一帧后切换选中）
    fireEvent.click(screen.getByText('角色A'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('角色A'));
    fireEvent.click(screen.getByText('✨ AI 优化描述'));
    // 立即切换到 B（第一帧到达前）
    fireEvent.click(screen.getByText('角色B'));
    await waitFor(() => expect(screen.getByTestId('design-name')).toHaveValue('角色B'));
    // 等待流式全部到达（两帧 50ms + DONE）
    await new Promise((r) => setTimeout(r, 300));
    // B 的描述保持原样，未被 AI chunk 污染
    expect((screen.getByTestId('design-desc') as HTMLTextAreaElement).value).toBe('B描述');
  });
});
