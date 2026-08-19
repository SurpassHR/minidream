import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoryChat, parseStoryAnswers } from './StoryChat';

// —— URL 感知 mock（Task 4 多会话）：sessions/history 返回 JSON，story/chat POST 返回 SSE ——
let SESSIONS: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = [];
let ACTIVE: string | null = null;
let HISTORY: Array<{ who: string; text: string; at: number }> = [];
let CHAT_BODIES: Array<{ message: string; sessionId?: string; persistAs?: string; systemPrompt?: string; images?: unknown[]; assetRefs?: Array<{ id: string; name: string; kind: string }> }> = [];

// 既有用例预置：会话列表 + 激活会话 + 历史。
// 注：仅预置 HISTORY 不够——「无会话自动新建」分支（POST sessions）会把 HISTORY 清空，
// 故同时预置 SESSIONS/ACTIVE 使加载走「已有会话 → 直接读历史」路径。
const LEGACY_HISTORY: Array<{ who: string; text: string; at: number }> = [
  { who: 'user', text: '我想做精灵与哥布林的故事', at: 1 },
  { who: 'agent', text: '好设定！', at: 2 },
];
function presetLegacySession() {
  SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
  ACTIVE = 's1';
  HISTORY = LEGACY_HISTORY;
}
function presetChoiceSession() {
  SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
  ACTIVE = 's1';
  HISTORY = [{
    who: 'agent',
    text: '请选择故事方向。\n\n```choice\n{"question":"选一个方向？","options":[{"id":"a","label":"冒险"},{"id":"b","label":"悬疑"}]}\n```',
    at: 2,
  }];
}

beforeEach(() => {
  SESSIONS = []; ACTIVE = null; HISTORY = []; CHAT_BODIES = [];
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    // URL 匹配顺序：/api/story/chat/sessions 必须先于 /api/story/chat/history 与 /api/story/chat
    if (u.includes('/api/story/chat/sessions')) {
      if (method === 'POST') {
        const id = `s${SESSIONS.length + 1}`;
        SESSIONS = [...SESSIONS, { id, title: '新会话', createdAt: 1, updatedAt: 1 }];
        ACTIVE = id; HISTORY = [];
      } else if (method === 'PATCH') {
        const id = u.split('/').pop();
        const body = JSON.parse(String(init?.body)) as { title: string };
        SESSIONS = SESSIONS.map((s) => (s.id === id ? { ...s, title: body.title } : s));
      } else if (method === 'DELETE') {
        const id = u.split('/').pop();
        SESSIONS = SESSIONS.filter((s) => s.id !== id);
        ACTIVE = SESSIONS[0]?.id ?? null; HISTORY = [];
      }
      return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
    }
    if (u.includes('/api/story/chat/history')) {
      return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
    }
    if (u === '/api/assets') {
      return new Response(JSON.stringify({ assets: [
        { id: 'txt-1', kind: 'txt', name: '世界观.md' },
        { id: 'img-1', kind: 'img', name: '角色.png' },
        { id: 'vid-1', kind: 'vid', name: '参考视频.mp4' },
      ] }), { status: 200 });
    }
    if (u.includes('/api/assets/') && u.endsWith('/file')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 });
    }
    if (u.includes('/api/story/chat')) {
      if (method === 'POST') {
        CHAT_BODIES = [...CHAT_BODIES, JSON.parse(String(init?.body)) as { message: string; sessionId?: string }];
        return new Response(
          'data: {"chunk":"精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('parseStoryAnswers', () => {
  it('解析六步约定格式，忽略非法行', () => {
    const text = [
      'theme: 战争与和解',
      'protagonist: 精灵骑士',
      '随便说说',
      'scenes: 迷雾森林',
      'ending:',
    ].join('\n');
    expect(parseStoryAnswers(text)).toEqual({
      theme: '战争与和解', protagonist: '精灵骑士', scenes: '迷雾森林',
    });
  });

  it('空文本返回空对象', () => {
    expect(parseStoryAnswers('')).toEqual({});
    expect(parseStoryAnswers('没有格式的文本')).toEqual({});
  });
});

describe('StoryChat', () => {
  it('历史中的合法 choice 渲染选项并隐藏机器块', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    expect(screen.getByText('请选择故事方向。')).toBeInTheDocument();
    expect(screen.getByText('选一个方向？')).toBeInTheDocument();
    expect(screen.queryByText(/```choice/)).not.toBeInTheDocument();
    const inputRow = screen.getByTestId('chat-composer').querySelector('.chat-input-row');
    expect(inputRow).toContainElement(screen.getByTestId('chat-attach-btn'));
    expect(inputRow).toContainElement(screen.getByRole('button', { name: '发送' }));
  });

  it('代码块显示复制按钮并只复制代码正文', async () => {
    SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's1';
    HISTORY = [{
      who: 'agent',
      text: '这是示例：`inline`\n\n```ts\nconst answer = 42;\n```',
      at: 2,
    }];
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      render(<StoryChat projectName="demo" onSummarized={() => {}} />);
      await waitFor(() => expect(screen.getByRole('button', { name: '复制代码' })).toBeInTheDocument());
      expect(screen.getByText('ts')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '复制行内代码' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42;'));
      expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard });
    }
  });

  it('点击 choice 发送 label，且不带其他输入区的附件或素材引用', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /冒险/ }));
    await waitFor(() => expect(CHAT_BODIES.at(-1)?.message).toBe('冒险'));
    expect(CHAT_BODIES.at(-1)?.images).toBeUndefined();
    expect(CHAT_BODIES.at(-1)?.assetRefs).toBeUndefined();
  });

  it('流式结束后从完整 agent 原文派生下一轮 choice', async () => {
    SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's1';
    HISTORY = LEGACY_HISTORY;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
      }
      if (u.includes('/api/story/chat') && method === 'POST') {
        const reply = ['下一步？', '', '```choice', '{"question":"继续吗？","options":[{"label":"继续"},{"label":"停下"}]}', '```'].join('\n');
        return new Response(`data: ${JSON.stringify({ chunk: reply })}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '继续推进' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /继续/ })).toBeInTheDocument());
    expect(screen.getByText('下一步？')).toBeInTheDocument();
    expect(screen.queryByText(/```choice/)).not.toBeInTheDocument();
  });

  it('没有合法 choice 时保持自由输入，不渲染选项按钮', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /冒险/ })).not.toBeInTheDocument();
  });

  it('choice 支持数字快捷键', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(CHAT_BODIES.at(-1)?.message).toBe('悬疑'));
  });

  it('其他输入框内的数字不触发选项快捷键', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    input.focus();
    fireEvent.keyDown(input, { key: '1' });
    expect(CHAT_BODIES.at(-1)?.message).not.toBe('冒险');
  });

  it('choice 的“其他”仍可发送自定义文本', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '我想自己描述' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(CHAT_BODIES.at(-1)?.message).toBe('我想自己描述'));
  });

  it('点击预设选项不带走待发送附件，附件仍留在“其他”输入区', async () => {
    presetChoiceSession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /冒险/ })).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    const file = new File([new Uint8Array([1, 2, 3])], 'pending.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], types: ['Files'] },
    } as unknown as ClipboardEvent);
    await waitFor(() => expect(screen.getByText('pending.png')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /冒险/ }));
    await waitFor(() => expect(CHAT_BODIES.at(-1)?.message).toBe('冒险'));
    expect(CHAT_BODIES.at(-1)?.images).toBeUndefined();
    expect(screen.getByText('pending.png')).toBeInTheDocument();
  });

  it('空会话自动 kickoff，系统标记不显示为用户气泡', async () => {
    SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's1';
    HISTORY = [];
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(CHAT_BODIES.some((body) => body.persistAs === '（开始访谈）')).toBe(true));
    expect(screen.queryByText('（开始访谈）')).not.toBeInTheDocument();
  });

  it('加载历史并渲染消息', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    expect(screen.getByText('好设定！')).toBeInTheDocument();
  });

  it('消息流使用居中阅读列与消息元信息结构', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const conversation = screen.getByTestId('chat-conversation');
    expect(conversation).toHaveClass('chat-conversation');
    expect(conversation).toHaveAttribute('data-layout', 'reading-column');
    expect(screen.getAllByTestId('chat-message-body')).toHaveLength(2);
    expect(screen.getAllByTestId('chat-message-meta')).toHaveLength(2);
    expect(screen.getByText('编剧')).toBeInTheDocument();
  });

  it('底部输入区使用编辑器式 Composer 容器', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const composer = screen.getByTestId('chat-composer');
    expect(composer).toHaveAttribute('data-layout', 'inset-composer');
    expect(composer).toContainElement(screen.getByTestId('chat-input'));
    expect(composer.querySelector('.chat-input-row')).toHaveAttribute('data-layout', 'centered-controls');
    expect(composer).toContainElement(screen.getByTestId('chat-attach-btn'));
    expect(composer.querySelector('.chat-input-row')).toContainElement(screen.getByTestId('chat-attach-btn'));
    expect(composer).toContainElement(screen.getByRole('button', { name: '发送' }));
    expect(composer).toContainElement(screen.getByText('总结成稿'));
  });

  it('首次加载后输入 @ 只保留一个字符并打开候选菜单', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    // 模拟浏览器在 contenteditable 子节点外插入字符（首次刷新后的真实输入路径）。
    input.appendChild(document.createTextNode('@'));
    fireEvent.input(input);
    await waitFor(() => expect(input.textContent).toBe('@'));
    expect(screen.getByTestId('chat-asset-mention-menu')).toBeInTheDocument();
    expect((input.textContent ?? '').match(/@/g)).toHaveLength(1);
  });

  it('候选菜单使用浮层并限制在输入容器宽度内', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '@' } });
    const menu = await screen.findByTestId('chat-asset-mention-menu');
    expect(menu).toHaveClass('asset-mention-menu');
    expect(menu).toHaveAttribute('data-placement', 'above');
    expect(menu).toHaveAttribute('data-width-bound', 'container');
  });

  it('Shift+Enter 保留多行输入，不触发发送', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '第一行' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(input).toHaveValue('第一行');
    expect(CHAT_BODIES).toHaveLength(0);
  });

  it('发送消息后流式渲染 agent 回复', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // 新 mock 单帧 chunk（精灵骑士）+ DONE：断言随 mock 调整
    await waitFor(() => expect(screen.getByText(/精灵骑士/)).toBeInTheDocument());
  });

  it('LLM 流式回复时自动滚动到底部', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const conversation = screen.getByTestId('chat-conversation');
    let scrollTop = 460;
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '继续写' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText(/精灵骑士/)).toBeInTheDocument());
    expect(scrollTop).toBe(600);
  });

  // —— 图像附件：Ctrl+V 粘贴 → 预览 → 发送携带 images；纯文本粘贴不拦截 ——
  it('Ctrl+V 粘贴图像成为附件：发送时 body.images 携带 data URL，气泡展示缩略图', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    const file = new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        types: ['Files'],
      },
    } as unknown as ClipboardEvent);
    // 附件预览出现（FileReader 异步读入）
    await waitFor(() => expect(screen.getByText('clipboard.png')).toBeInTheDocument());
    expect(screen.getByTestId('chat-attach-row')).toBeInTheDocument();
    // 仅图片无文本也可发送：body.images 携带 data URL
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    const body = CHAT_BODIES.at(-1) as { message: string; images?: Array<{ name: string; data: string }> };
    expect(body.message).toBe('');
    expect(body.images).toHaveLength(1);
    expect(body.images![0]!.name).toBe('clipboard.png');
    expect(body.images![0]!.data).toMatch(/^data:image\/png;base64,/);
    // 用户气泡展示缩略图
    await waitFor(() => expect(screen.getByAltText('clipboard.png')).toBeInTheDocument());
  });

  it('素材库图像拖入对话编辑区：转换为图片附件预览', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const composer = screen.getByTestId('chat-composer');
    fireEvent.drop(composer, {
      dataTransfer: {
        getData: (type: string) => type === 'application/x-asset'
          ? JSON.stringify({ id: 'a1', kind: 'img', name: 'library.png' })
          : '',
      },
    } as unknown as DragEvent);
    await waitFor(() => expect(screen.getByText('library.png')).toBeInTheDocument());
    expect(screen.getByTestId('chat-attach-row')).toBeInTheDocument();
    expect(screen.getByAltText('library.png')).toBeInTheDocument();
  });

  it('素材库文本与视频拖入对话：显示引用并随请求透传', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const composer = screen.getByTestId('chat-composer');
    const drop = (item: { id: string; name: string; kind: string }) => fireEvent.drop(composer, {
      dataTransfer: {
        getData: (type: string) => type === 'application/x-asset' ? JSON.stringify(item) : '',
      },
    } as unknown as DragEvent);
    drop({ id: 'txt-1', name: '世界观.md', kind: 'txt' });
    drop({ id: 'vid-1', name: '参考视频.mp4', kind: 'vid' });
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveValue('@世界观.md @参考视频.mp4 '));
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: `${(screen.getByTestId('chat-input') as HTMLTextAreaElement).value}结合这些素材继续创作` } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES.at(-1)!.assetRefs).toEqual([
      { id: 'txt-1', name: '世界观.md', kind: 'txt' },
      { id: 'vid-1', name: '参考视频.mp4', kind: 'vid' },
    ]);
  });

  it('输入 @ 可搜索并引用任意素材，发送时透传素材引用', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.getByTestId('chat-asset-mention-menu')).toBeInTheDocument();
    expect(screen.getByText('世界观.md')).toBeInTheDocument();
    expect(screen.getByText('角色.png')).toBeInTheDocument();
    expect(screen.getByText('参考视频.mp4')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '@世' } });
    expect(screen.getByText('世界观.md')).toBeInTheDocument();
    expect(screen.queryByText('角色.png')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-asset-mention-txt-1'));
    expect(screen.queryByTestId('chat-asset-ref-txt-1')).not.toBeInTheDocument();
    expect(input).toHaveValue('@世界观.md ');
    fireEvent.change(input, { target: { value: `${(input as HTMLTextAreaElement).value}结合这个素材继续创作` } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES.at(-1)!.assetRefs).toEqual([
      { id: 'txt-1', name: '世界观.md', kind: 'txt' },
    ]);
    expect(CHAT_BODIES.at(-1)!.message).toContain('@世界观.md');
  });

  it('附件可移除：点 × 后预览消失', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], types: ['Files'] },
    } as unknown as ClipboardEvent);
    await waitFor(() => expect(screen.getByText('a.png')).toBeInTheDocument());
    const chip = screen.getByText('a.png').closest('.chat-attach')!;
    fireEvent.click(chip.querySelector('.chat-attach-x')!);
    await waitFor(() => expect(screen.queryByText('a.png')).not.toBeInTheDocument());
  });

  it('粘贴纯文本不拦截（保持默认粘贴行为）', async () => {
    presetLegacySession();
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    const prevented = { defaultPrevented: false };
    const ev = {
      clipboardData: { items: [], types: ['text/plain'] },
      preventDefault: () => { prevented.defaultPrevented = true; },
    };
    fireEvent.paste(input, ev as unknown as ClipboardEvent);
    expect(prevented.defaultPrevented).toBe(false);
  });

  it('总结成稿：解析后回调 onSummarized 携带答案', async () => {
    let summarized: Record<string, string> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response(
          'data: {"chunk":"theme: 战争与和解\\nprotagonist: 精灵骑士"}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={(a) => { summarized = a; }} />);
    await waitFor(() => expect(screen.getByText('总结成稿')).toBeInTheDocument());
    fireEvent.click(screen.getByText('总结成稿'));
    await waitFor(() => expect(summarized).toEqual({ theme: '战争与和解', protagonist: '精灵骑士' }));
  });

  it('总结成稿连接失败：不显示格式错误（只提示连接失败）', async () => {
    // mock POST /api/story/chat 返回 500：流式请求失败
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        return new Response('err', { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('总结成稿')).toBeInTheDocument());
    fireEvent.click(screen.getByText('总结成稿'));
    // 出现连接失败提示
    await waitFor(() => expect(screen.getByText(/（agent 连接失败：story chat 请求失败: 500）/)).toBeInTheDocument());
    // 不出现格式错误提示（旧实现会同时显示两条矛盾提示）
    expect(screen.queryByText('未识别到答案格式，请重试')).not.toBeInTheDocument();
  });

  it('总结成稿使用配置的 storyTeller + storySummarize 提示词', async () => {
    const onSummarized = vi.fn();
    presetLegacySession();
    render(
      <StoryChat
        projectName="demo"
        onSummarized={onSummarized}
        prompts={{ storyTeller: '定制编剧', storySummarize: '定制总结' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.click(screen.getByText('总结成稿'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/story/chat'),
      expect.objectContaining({ method: 'POST' }),
    ));
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat') && (c[1] as RequestInit)?.method === 'POST',
    );
    const body = JSON.parse(String(calls.at(-1)![1]?.body)) as { message: string; systemPrompt?: string };
    expect(body.systemPrompt).toContain('定制编剧');
    expect(body.message).toContain('定制总结');
    expect(body.message).not.toContain('定制编剧');
  });

  // —— Task 4 新增：左侧会话列表面板 ——
  it('会话面板：无会话自动新建；列表显示会话标题', async () => {
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话');
  });

  it('点选历史会话：加载该会话消息', async () => {
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sa';
    HISTORY = [{ who: 'agent', text: '甲的历史', at: 2 }];
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('甲的历史')).toBeInTheDocument());
    // 切到 sb
    SESSIONS = [
      { id: 'sa', title: '会话甲', createdAt: 1, updatedAt: 2 },
      { id: 'sb', title: '会话乙', createdAt: 3, updatedAt: 4 },
    ];
    ACTIVE = 'sb';
    HISTORY = [{ who: 'user', text: '乙的消息', at: 4 }];
    fireEvent.click(screen.getByText('会话乙'));
    await waitFor(() => expect(screen.getByText('乙的消息')).toBeInTheDocument());
    expect(screen.queryByText('甲的历史')).not.toBeInTheDocument();
  });

  it('发送/总结成稿携带当前 sessionId', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(
      <StoryChat
        projectName="demo"
        onSummarized={() => {}}
        prompts={{ storyTeller: '你是导演工作台的故事编剧' }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('session-item-s9')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES[0]!.sessionId).toBe('s9');
    // send 透传 systemPrompt=storyTeller（对话式统一角色提示词，经后端 systemPrompt 字段）
    expect(CHAT_BODIES.at(-1)!.systemPrompt).toContain('你是导演工作台的故事编剧');
    fireEvent.click(screen.getByText('总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(1));
    expect(CHAT_BODIES.at(-1)!.sessionId).toBe('s9');
  });

  it('剧本项目发送时使用项目级 storyTeller 作为 systemPrompt', async () => {
    presetLegacySession();
    render(
      <StoryChat
        projectName="demo"
        onSummarized={() => {}}
        board={{
          id: 'b1', name: '项目', createdAt: 0, updatedAt: 0,
          systemPrompts: { storyTeller: '项目专属故事编剧' }, ragEnabled: false, ragAssets: [],
        }}
        prompts={{ storyTeller: '全局故事编剧' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('我想做精灵与哥布林的故事')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '继续创作' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.at(-1)?.message).toBe('继续创作'));
    expect(CHAT_BODIES.at(-1)?.systemPrompt).toBe('项目专属故事编剧');
  });

  it('发送与总结成稿携带设置的模型与思考强度（agentModel/thinkingLevel 透传）', async () => {
    SESSIONS = [{ id: 's9', title: '当前', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's9';
    render(
      <StoryChat
        projectName="demo"
        onSummarized={() => {}}
        agentModel="anthropic/claude-sonnet-4"
        thinkingLevel="high"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('session-item-s9')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    const sendBody = CHAT_BODIES[0] as { model?: string; thinking?: string };
    expect(sendBody.model).toBe('anthropic/claude-sonnet-4');
    expect(sendBody.thinking).toBe('high');
    fireEvent.click(screen.getByText('总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(1));
    const sumBody = CHAT_BODIES.at(-1) as { model?: string; thinking?: string };
    expect(sumBody.model).toBe('anthropic/claude-sonnet-4');
    expect(sumBody.thinking).toBe('high');
  });

  it('重命名/删除会话（确认后）', async () => {
    SESSIONS = [{ id: 's1', title: '旧名', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByText('旧名')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-rename-s1'));
    const renameInput = await screen.findByTestId('text-dialog-input');
    fireEvent.change(renameInput, { target: { value: '新名字' } });
    fireEvent.click(screen.getByTestId('text-dialog-confirm'));
    await waitFor(() => expect(screen.getByText('新名字')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('session-del-s1'));
    await waitFor(() => expect(screen.getByText('确认删除')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('新名字')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });

  it('流式中点删除会话：busy 守卫不触发 DELETE 请求', async () => {
    // 覆盖 mock：POST /api/story/chat 返回延迟流（首帧 80ms 后），期间 busy 保持 true；
    // confirm 置 true——若无 busy 守卫，删除会真的发出 DELETE（与 jsdom confirm 默认 false 区分）
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }], activeId: 's1' }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        if (method === 'POST') {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              await new Promise((r) => setTimeout(r, 80));
              controller.enqueue(encoder.encode('data: {"chunk":"慢流"}\n\n'));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '主角是谁？' } });
    fireEvent.click(screen.getByText('发送'));
    // 流式未完成（首帧 80ms 后）：立即点删除，busy 守卫应直接返回
    fireEvent.click(screen.getByTestId('session-del-s1'));
    // 等待流式结束（若误触发 DELETE，早已发出）
    await new Promise((r) => setTimeout(r, 150));
    const delCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat/sessions') && (c[1] as RequestInit)?.method === 'DELETE',
    );
    expect(delCalls.length).toBe(0);
    vi.restoreAllMocks();
  });

  // —— Final round：删光自动新建 ——
  // DELETE 返回 activeId: null（会话删光）时自动 POST 新建会话并加载其（空）历史。
  it('删除最后一个会话后自动新建：列表恢复新会话并加载空历史', async () => {
    SESSIONS = [{ id: 's1', title: '唯一会话', createdAt: 1, updatedAt: 2 }];
    ACTIVE = 's1';
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('唯一会话'));
    fireEvent.click(screen.getByTestId('session-del-s1'));
    await waitFor(() => expect(screen.getByText('确认删除')).toBeInTheDocument());
    fireEvent.click(screen.getByText('确认删除'));
    // 自动新建（POST create）已发出：新会话回到列表
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话'));
    const posts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat/sessions') && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(posts.length).toBeGreaterThan(0);
    // 空历史加载：EmptyState 显示
    expect(screen.getByText(/还没有对话/)).toBeInTheDocument();
  });

  // —— Final round：发送后刷新会话列表 ——
  // 后端在首条用户消息后自动命名会话并 bump updatedAt；发送完成后前端须重新拉取列表。
  it('发送后刷新会话列表：标题随后端自动命名更新', async () => {
    SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        if (method === 'POST') {
          // 模拟后端：首条用户消息后自动命名会话（标题 = 消息截断）
          const body = JSON.parse(String(init?.body)) as { message: string };
          SESSIONS = SESSIONS.map((s) => (s.id === ACTIVE ? { ...s, title: body.message.slice(0, 20) } : s));
          return new Response(
            'data: {"chunk":"奇幻冒险"}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话'));
    const gets = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat/sessions') && (c[1] as RequestInit)?.method !== 'POST',
    );
    const input = screen.getByTestId('chat-input');
    fireEvent.change(input, { target: { value: '我的主角是精灵骑士' } });
    fireEvent.click(screen.getByText('发送'));
    // 流式输出渲染
    await waitFor(() => expect(screen.getByText(/奇幻冒险/)).toBeInTheDocument());
    // 发送完成 → 刷新列表：标题更新为后端自动命名
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('我的主角是精灵骑士'));
    // 第二次 GET /api/story/chat/sessions 已发出（发送后刷新；挂载 1 次 + 刷新 1 次）
    expect(gets().length).toBe(2);
  });

  it('总结成稿完成后也刷新会话列表（标题同步）', async () => {
    SESSIONS = [{ id: 's1', title: '新会话', createdAt: 1, updatedAt: 1 }];
    ACTIVE = 's1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/story/chat/sessions')) {
        return new Response(JSON.stringify({ sessions: SESSIONS, activeId: ACTIVE }), { status: 200 });
      }
      if (u.includes('/api/story/chat/history')) {
        return new Response(JSON.stringify({ messages: HISTORY }), { status: 200 });
      }
      if (u.includes('/api/story/chat')) {
        if (method === 'POST') {
          // 模拟后端：总结成稿落盘后会话标题/updatedAt 变化
          SESSIONS = SESSIONS.map((s) => (s.id === ACTIVE ? { ...s, title: '总结成稿会话', updatedAt: 9 } : s));
          return new Response(
            'data: {"chunk":"theme: 战争与和解"}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<StoryChat projectName="demo" onSummarized={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('新会话'));
    const gets = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).includes('/api/story/chat/sessions') && (c[1] as RequestInit)?.method !== 'POST',
    );
    fireEvent.click(screen.getByText('总结成稿'));
    // 总结完成 → 刷新列表：标题更新
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toHaveTextContent('总结成稿会话'));
    expect(gets().length).toBe(2);
  });

  it('破甲开启时总结成稿请求以预设文本开头', async () => {
    render(
      <StoryChat
        projectName="demo" onSummarized={() => {}}
        armorBreak="破甲预设文本" armorBreakEnabled
      />,
    );
    await waitFor(() => expect(screen.getByTestId('session-item-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('总结成稿'));
    await waitFor(() => expect(CHAT_BODIES.length).toBeGreaterThan(0));
    expect(CHAT_BODIES.at(-1)!.systemPrompt).toMatch(/^破甲预设文本\n\n/);
    expect(CHAT_BODIES.at(-1)!.message).toContain('theme: 一句话主题');
  });
});
