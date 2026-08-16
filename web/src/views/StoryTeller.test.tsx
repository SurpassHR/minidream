import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryTellerView } from './StoryTellerView';

const STORY_API: { story: { step: number; answers: Record<string, string>; completedAt: string | null } } = { story: { step: 0, answers: {}, completedAt: null } };
// GET /api/story 失败开关：置 true 后 GET 分支返回 500（模拟切项目后加载失败）
let GET_STORY_FAIL = false;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/story/reset')) {
      STORY_API.story = { step: 0, answers: {}, completedAt: null };
      return new Response(JSON.stringify(STORY_API), { status: 200 });
    }
    if (u.includes('/api/story/complete')) {
      return new Response(JSON.stringify({
        asset: { id: 'a1', kind: 'txt', name: 'story_demo.md', ext: '.md', size: 1, importedAt: 1 },
        story: { ...STORY_API.story, completedAt: '2026-08-15T00:00:00.000Z' },
        md: '# demo · 故事设定\n\n## 主题\n战争与和解',
      }), { status: 201 });
    }
    if (u.includes('/api/story/chat/sessions')) {
      // GET 空库 → StoryChat 自动 POST 新建（返回 s1 并置 active）
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ sessions: [], activeId: null }), { status: 200 });
    }
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      if (init?.method === 'POST') {
        return new Response(
          'data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
    if (u.includes('/api/story')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { answers?: Record<string, string> };
        STORY_API.story = { ...STORY_API.story, answers: { ...STORY_API.story.answers, ...(body.answers ?? {}) } };
      }
      // GET 失败开关：模拟切项目后加载失败（不得残留上一项目已完成的 md）
      if (GET_STORY_FAIL) return new Response(JSON.stringify({}), { status: 500 });
      return new Response(JSON.stringify({ ...STORY_API, md: STORY_API.story.completedAt ? '# demo · 故事设定' : null }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('StoryTellerView 对话式', () => {
  beforeEach(() => {
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
    GET_STORY_FAIL = false;
  });

  it('仅对话式：无模式 tab 与向导元素，显示聊天区', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.queryByText('⬡ 向导式')).not.toBeInTheDocument();
    expect(screen.queryByTestId('story-answer')).not.toBeInTheDocument();
    expect(screen.queryByText(/第 \d+\/6 步/)).not.toBeInTheDocument();
    // chat-mode 布局常驻
    expect(screen.getByTestId('story-teller-view').className).toContain('chat-mode');
  });

  it('未完成时右侧剧本栏占位', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
  });

  it('总结成稿后显示完成横幅 + 右侧剧本 md', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    // ScriptViewer 接线回归防护：md 内容（来自 complete 响应）渲染到剧本栏
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
  });

  it('重新生成：清空完成态与剧本栏', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('重新生成'));
    await waitFor(() => expect(screen.queryByText(/已完成 · 已生成故事文档/)).not.toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    vi.restoreAllMocks();
  });

  it('已完成项目挂载：右侧栏从 GET 恢复剧本', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    // 已完成项目挂载：md 从 GET 响应恢复并渲染到剧本栏
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
  });

  it('GET 失败：右侧栏回占位并显示错误横幅（不残留上一项目剧本）', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't' }, completedAt: '2026-08-15T00:00:00.000Z' };
    const { rerender } = render(<StoryTellerView projectName="demoA" />);
    // 项目 A 已完成：右侧栏展示剧本
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    // 切到项目 B 且 GET 失败：不得残留项目 A 的剧本（md 清空回占位 + 错误横幅）
    GET_STORY_FAIL = true;
    rerender(<StoryTellerView projectName="demoB" />);
    await waitFor(() => expect(screen.getByText('加载故事进度失败')).toBeInTheDocument());
    expect(screen.queryByTestId('script-viewer')).not.toBeInTheDocument();
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
  });
});
