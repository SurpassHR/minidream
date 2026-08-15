import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryTellerView } from './StoryTellerView';

const STORY_API = { story: { step: 0, answers: {}, completedAt: null } };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/story/complete')) {
      return new Response(JSON.stringify({
        asset: { id: 'a1', kind: 'txt', name: 'story_demo.md', ext: '.md', size: 1, importedAt: 1 },
        story: { ...STORY_API.story, completedAt: '2026-08-15T00:00:00.000Z' },
      }), { status: 201 });
    }
    if (u.includes('/api/story')) {
      // PUT 合并更新共享 mock 数据（step / answers），返回更新后进度——模拟真实后端合并写
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { step?: number; answers?: Record<string, string> };
        STORY_API.story = {
          ...STORY_API.story,
          ...(body.step !== undefined ? { step: body.step } : {}),
          answers: { ...STORY_API.story.answers, ...(body.answers ?? {}) },
        };
      }
      return new Response(JSON.stringify(STORY_API), { status: 200 });
    }
    if (u.includes('/api/agent/chat')) {
      // 流式 agent：直接返回一个 SSE 帧 + DONE
      return new Response(
        'data: {"chunk":"建议文本"}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('StoryTellerView', () => {
  beforeEach(() => {
    // 重置共享 mock 数据（用例之间隔离）
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
  });

  it('渲染第一步问题与进度', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    expect(screen.getByText(/第 1\/6 步/)).toBeInTheDocument();
  });

  it('下一步校验必填：空输入阻止前进', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('下一步 →'));
    // 仍在第一步
    expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument();
    expect(screen.getByText('请填写后再继续')).toBeInTheDocument();
  });

  it('填写后下一步进入第二步（自动保存调用 PUT）', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '精灵与哥布林' } });
    fireEvent.click(screen.getByText('下一步 →'));
    await waitFor(() => expect(screen.getByText(/主角是谁/)).toBeInTheDocument());
    // PUT 已调用（保存主题答案）
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('AI 建议按钮流式追加建议到文本框', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
  });

  it('完成后显示完成状态', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: null };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/结局如何/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '圆满结局' } });
    fireEvent.click(screen.getByText('完成故事'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
  });

  it('输入停止 500ms 后自动 PUT 保存草稿（防抖）', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '精灵与哥布林' } });
    // 等待防抖窗口（500ms）结束，timer 应触发 PUT
    await new Promise((r) => setTimeout(r, 650));
    const putCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story') && (c[1] as RequestInit)?.method === 'PUT',
    );
    expect(putCalls.length).toBeGreaterThan(0);
    const last = putCalls[putCalls.length - 1]![1] as RequestInit;
    expect(JSON.parse(String(last.body))).toEqual({ answers: { theme: '精灵与哥布林' } });
  });

  it('complete 清防抖 timer：快速完成后 banner 不被 PUT 响应回退', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: null };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/结局如何/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '圆满结局' } });
    // 输入后立即完成：防抖 timer（500ms）尚未触发，complete 必须清掉它
    fireEvent.click(screen.getByText('完成故事'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    // 等待超过防抖窗口：若 timer 未清，其 PUT 响应（completedAt 为 null）会把 banner 覆盖掉
    await new Promise((r) => setTimeout(r, 650));
    expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument();
  });
});
