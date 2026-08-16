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
    // reset 分支必须先于 /api/story（否则被 GET 分支吞掉，不执行重置）
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
    // chat 分支必须先于 /api/story（chat URL 含 /api/story 子串，否则被 GET 分支吞掉）
    if (u.includes('/api/story/chat')) {
      // GET history → 空历史；POST chat → SSE 六步答案帧（回填/总结用）
      if (init?.method === 'POST') {
        return new Response(
          'data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
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
      // GET：已完成时携带 md（模拟后端行为）；GET_STORY_FAIL 时模拟加载失败
      if (GET_STORY_FAIL) return new Response(JSON.stringify({}), { status: 500 });
      return new Response(JSON.stringify({
        ...STORY_API,
        md: STORY_API.story.completedAt ? '# demo · 故事设定\n\n## 主题\n战争与和解' : null,
      }), { status: 200 });
    }
    if (u.includes('/api/agent/chat')) {
      // 流式 agent：两帧 chunk（帧间 50ms 延迟模拟流式，期间允许切步）+ DONE
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('data: {"chunk":"建议"}\n\n'));
          await new Promise((r) => setTimeout(r, 50));
          controller.enqueue(encoder.encode('data: {"chunk":"文本"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('StoryTellerView', () => {
  beforeEach(() => {
    // 重置共享 mock 数据（用例之间隔离）
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
    GET_STORY_FAIL = false;
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

  it('AI 建议流式期间切步：chunk 不污染新步骤草稿', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    // 填写必填主题后触发 AI 建议（首帧立即到达，第二帧 50ms 后）
    fireEvent.change(textarea, { target: { value: '精灵与哥布林' } });
    fireEvent.click(screen.getByText('✨ AI 建议'));
    // 流式进行中切到下一步（首帧前点下一步）
    fireEvent.click(screen.getByText('下一步 →'));
    await waitFor(() => expect(screen.getByText(/主角是谁/)).toBeInTheDocument());
    // 等待流式全部到达（第二帧 50ms + DONE）
    await new Promise((r) => setTimeout(r, 300));
    // 新步骤（主角）草稿为空，未被过期 AI chunk 污染
    expect((screen.getByTestId('story-answer') as HTMLTextAreaElement).value).toBe('');
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

  it('完成后显示重新生成按钮，点击后回到第一步', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('重新生成'));
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    // 完成 banner 消失（completedAt 已清空）
    expect(screen.queryByText(/已完成 · 已生成故事文档/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('重新生成取消确认：进度不变', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('重新生成'));
    // 仍在完成态（banner 保留，未调 reset）
    expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/story/reset'),
      expect.objectContaining({ method: 'POST' }),
    );
    vi.restoreAllMocks();
  });

  it('AI 建议使用配置的 storyTeller 提示词', async () => {
    render(<StoryTellerView projectName="demo" prompts={{ storyTeller: '定制建议系统提示词' }} />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ AI 建议'));
    await waitFor(() => expect(screen.getByTestId('story-answer')).toHaveValue('建议文本'));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/agent/chat'),
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string };
    expect(body.message).toContain('定制建议系统提示词');
    expect(body.message).not.toContain('你是导演工作台的故事向导角色');
  });
});

describe('StoryTellerView 模式切换', () => {
  beforeEach(() => {
    // 重置共享 mock 数据（用例之间隔离）
    STORY_API.story = { step: 0, answers: {}, completedAt: null };
    GET_STORY_FAIL = false;
  });

  it('默认向导式，切到对话式后显示聊天区', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    // 默认向导式：头部显示第几步
    expect(screen.getByTestId('story-answer')).toBeInTheDocument();
    expect(screen.getByText(/第 1\/6 步/)).toBeInTheDocument();
    // 向导式无 chat-mode（保持整页滚动）
    expect(screen.getByTestId('story-teller-view').className).not.toContain('chat-mode');
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.queryByTestId('story-answer')).not.toBeInTheDocument();
    // 对话式无步骤概念：不显示「第 X/6 步」
    expect(screen.queryByText(/第 \d+\/6 步/)).not.toBeInTheDocument();
    expect(screen.getByText(/自由对话 · 探索故事方向/)).toBeInTheDocument();
    // 对话式 chat-mode：高度受限布局，仅消息区滚动
    expect(screen.getByTestId('story-teller-view').className).toContain('chat-mode');
  });

  it('对话式回填向导：answers 写入后切回向导式并显示答案', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('↩ 回填向导'));
    // 回填后应切回向导式并显示主题答案（mock SSE 返回 theme: 战争与和解）
    await waitFor(() => expect(screen.getByTestId('story-answer')).toBeInTheDocument());
    expect(screen.getByTestId('story-answer')).toHaveValue('战争与和解');
  });

  it('对话式总结成稿：答案写入并 complete，完成后切回向导式显示已完成', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    // 总结完成后留在对话式
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    // 切回向导式应显示已完成 banner（completeStory mock 返回 completedAt）
    fireEvent.click(screen.getByTestId('mode-wizard'));
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
  });

  it('对话式总结成稿完成后：右侧栏展示剧本 md', async () => {
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/故事主题是什么/)).toBeInTheDocument());
    // 未完成：右侧栏占位
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    fireEvent.click(screen.getByTestId('mode-chat'));
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    fireEvent.click(screen.getByText('✨ 总结成稿'));
    // 总结完成 → 右侧栏代码视图出现剧本
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('## 主题');
  });

  it('已完成项目挂载：右侧栏从 GET 恢复剧本', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
  });

  it('GET 失败不残留陈旧剧本：切项目后右侧栏回占位并显示错误横幅', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    const { rerender } = render(<StoryTellerView projectName="demoA" />);
    // 项目 A 已完成：右侧栏展示剧本
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    // 切到项目 B 且 GET 失败：不得残留项目 A 的剧本
    GET_STORY_FAIL = true;
    rerender(<StoryTellerView projectName="demoB" />);
    await waitFor(() => expect(screen.getByText('加载故事进度失败')).toBeInTheDocument());
    expect(screen.queryByTestId('script-viewer')).not.toBeInTheDocument();
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
  });

  it('完成后向导只读：textarea / ✨ AI 建议 / 完成故事 按钮禁用', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    // 向导式下完成后不可再编辑 answers（防 GET 重建 md 与入库素材漂移）
    expect(screen.getByTestId('story-answer')).toBeDisabled();
    expect(screen.getByText('✨ AI 建议')).toBeDisabled();
    expect(screen.getByText('完成故事')).toBeDisabled();
    // 上一步也禁用：完成后 flushDraft 会 PUT answers（被 409 拒绝，误导报错）
    // （末步无「下一步 →」，其禁用由下一用例覆盖）
    expect(screen.getByText('← 上一步')).toBeDisabled();
  });

  it('完成后非末步：下一步 → 按钮禁用（flushDraft 会 PUT answers）', async () => {
    STORY_API.story = { step: 2, answers: { theme: 't', protagonist: 'p' }, completedAt: '2026-08-15T00:00:00.000Z' };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/已完成 · 已生成故事文档/)).toBeInTheDocument());
    expect(screen.getByText('下一步 →')).toBeDisabled();
    expect(screen.getByText('← 上一步')).toBeDisabled();
  });

  it('向导式完成故事后右侧栏展示剧本，重新生成后回占位', async () => {
    STORY_API.story = { step: 5, answers: { theme: 't', protagonist: 'p', antagonist: 'a', scenes: 's', ending: 'e' }, completedAt: null };
    render(<StoryTellerView projectName="demo" />);
    await waitFor(() => expect(screen.getByText(/结局如何/)).toBeInTheDocument());
    const textarea = screen.getByTestId('story-answer');
    fireEvent.change(textarea, { target: { value: '圆满结局' } });
    fireEvent.click(screen.getByText('完成故事'));
    await waitFor(() => expect(screen.getByTestId('script-viewer')).toBeInTheDocument());
    expect(screen.getByTestId('script-viewer')).toHaveTextContent('# demo · 故事设定');
    // 重新生成 → 占位
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('重新生成'));
    await waitFor(() => expect(screen.queryByTestId('script-viewer')).not.toBeInTheDocument());
    expect(screen.getByTestId('script-sidebar')).toHaveTextContent('剧本将在这里展示');
    vi.restoreAllMocks();
  });
});
