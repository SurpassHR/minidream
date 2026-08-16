import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';

const DEFAULT_SETTINGS = { comfyUrl: '', agentModel: '', agentThinking: '' };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/settings')) {
      return new Response(JSON.stringify({ settings: { comfyUrl: 'http://127.0.0.1:8188', agentModel: 'anthropic/claude-sonnet-4', agentThinking: 'medium' } }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('SettingsModal', () => {
  it('渲染三项设置（ComfyUI/默认模型/思考强度），打开时同步外部值', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByText('⚙ 设置')).toBeInTheDocument();
    expect(screen.getByText('COMFYUI 地址')).toBeInTheDocument();
    expect(screen.getByText('默认模型')).toBeInTheDocument();
    expect(screen.getByText('思考强度')).toBeInTheDocument();
    // 打开时同步 props.settings
    expect(screen.getByPlaceholderText('http://127.0.0.1:8188')).toBeInTheDocument();
  });

  it('保存调用 PUT /api/settings（携带三项值）并回调 onSaved', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open
      settings={{ comfyUrl: 'http://127.0.0.1:8188', agentModel: 'anthropic/claude-sonnet-4', agentThinking: 'medium' }}
      models={[{ id: 'anthropic/claude-sonnet-4', provider: 'anthropic', thinking: false }]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByPlaceholderText('http://127.0.0.1:8188'), { target: { value: 'http://127.0.0.1:9999' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.comfyUrl).toBe('http://127.0.0.1:9999');
    expect(body.agentModel).toBe('anthropic/claude-sonnet-4');
    expect(body.agentThinking).toBe('medium');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('关闭时点击遮罩触发 onClose', () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.click(container.querySelector('.dialog-mask')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('closed 时不渲染', () => {
    const { container } = render(<SettingsModal
      open={false} settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(container.querySelector('.dialog-mask')).toBeNull();
  });

  it('首次打开（prompts undefined）预填 5 角色条目（内容=内置默认）', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 5 个角色名称输入
    for (const n of ['storyTeller', 'objectDesigner', 'storyChat', 'storySummarize', 'storyBackfill']) {
      expect(screen.getByDisplayValue(n)).toBeInTheDocument();
    }
    // 故事向导条目内容 = 内置默认
    expect(screen.getByDisplayValue(/你是导演工作台的「故事向导」角色/)).toBeInTheDocument();
  });

  it('已保存 prompts 直接展示（含自定义条目），不预填', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { custom: '自定义内容' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByDisplayValue('custom')).toBeInTheDocument();
    expect(screen.getByDisplayValue('自定义内容')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('storyTeller')).not.toBeInTheDocument();
  });

  it('新增/编辑/删除条目', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 新增：种子 5 条后新条目索引为 5（命名按 prev.length+1 → 新提示词 6）
    fireEvent.click(screen.getByTestId('prompt-add'));
    expect(screen.getByTestId('prompt-name-5')).toHaveValue('新提示词 6');
    fireEvent.change(screen.getByTestId('prompt-name-5'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('prompt-text-5'), { target: { value: '自定义内容' } });
    expect(screen.getByDisplayValue('自定义内容')).toBeInTheDocument();
    // 删除索引 1（objectDesigner）
    fireEvent.click(screen.getByTestId('prompt-del-1'));
    expect(screen.queryByDisplayValue('objectDesigner')).not.toBeInTheDocument();
  });

  it('重置为默认提示词：恢复 5 角色条目（自定义保留）', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { storyTeller: '改过', custom: 'x' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    expect(screen.getByDisplayValue(/你是导演工作台的「故事向导」角色/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('custom')).toBeInTheDocument();
    expect(screen.getByDisplayValue('storyBackfill')).toBeInTheDocument();
  });

  it('保存携带 prompts（整体 map；空名称行丢弃）', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '定制故事向导' } });
    fireEvent.click(screen.getByTestId('prompt-add'));
    fireEvent.change(screen.getByTestId('prompt-name-5'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByTestId('prompt-text-5'), { target: { value: '自定义内容' } });
    fireEvent.change(screen.getByTestId('prompt-name-4'), { target: { value: '   ' } }); // 空名称 → 保存时丢弃
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.prompts.storyTeller).toBe('定制故事向导');
    expect(body.prompts.custom).toBe('自定义内容');
    expect(body.prompts.storyBackfill).toBeUndefined(); // 空名称行已丢弃
    expect(Object.keys(body.prompts).length).toBe(5); // storyTeller/objectDesigner/storyChat/storySummarize/custom（storyBackfill 空名被丢）
  });
});
