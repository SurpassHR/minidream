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

  it('始终显示 3 角色条目：名称只读（标签+键名），内容=内置默认', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 3 个角色名称只读展示（键名 + 中文标签），无名称输入框
    for (const n of ['storyTeller', 'objectDesigner', 'storySummarize']) {
      expect(screen.getByText(n)).toBeInTheDocument();
      expect(screen.getByTestId('prompt-name-0')).not.toHaveAttribute('onChange'); // 名称不可编辑（span 非 input）
    }
    expect(screen.getByText('故事向导 · 对话式')).toBeInTheDocument();
    expect(screen.queryByText('storyChat')).not.toBeInTheDocument();
    // 内容 = 内置默认
    expect(screen.getByDisplayValue(/MiniMax H3 Prompt Director/)).toBeInTheDocument();
    // 无新增按钮
    expect(screen.queryByTestId('prompt-add')).not.toBeInTheDocument();
  });

  it('存储值优先：已存的键显示存储内容，缺失的键显示内置默认（角色常驻）', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { storyTeller: '定制故事向导', custom: '自定义内容' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByDisplayValue('定制故事向导')).toBeInTheDocument();
    // storySummarize 缺失 → 显示内置默认（角色条目常驻，不因存储缺失而消失）
    expect(screen.getByText('storySummarize')).toBeInTheDocument();
    // 自定义键不再展示（仅 3 角色）
    expect(screen.queryByDisplayValue('自定义内容')).not.toBeInTheDocument();
  });

  it('编辑内容 + 条目级恢复默认', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '改过的故事向导' } });
    expect(screen.getByDisplayValue('改过的故事向导')).toBeInTheDocument();
    // 条目级「↺ 默认」恢复内置默认内容
    fireEvent.click(screen.getByTestId('prompt-reset-0'));
    expect(screen.getByDisplayValue(/MiniMax H3 Prompt Director/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('改过的故事向导')).not.toBeInTheDocument();
  });

  it('重置为默认提示词：全部恢复内置默认', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { storyTeller: '改过', storySummarize: '也改过' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    expect(screen.getByDisplayValue(/MiniMax H3 Prompt Director/)).toBeInTheDocument();
    expect(screen.getByText('storySummarize')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('也改过')).not.toBeInTheDocument();
  });

  it('保存携带 prompts：固定 3 角色键 map（空内容保留=回退默认）', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '定制故事向导' } });
    fireEvent.change(screen.getByTestId('prompt-text-2'), { target: { value: '' } }); // storySummarize 清空
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(Object.keys(body.prompts).sort()).toEqual(
      ['objectDesigner', 'storySummarize', 'storyTeller'],
    );
    expect(body.prompts.storyTeller).toBe('定制故事向导');
    expect(body.prompts.storySummarize).toBe(''); // 空内容保留（消费点回退默认）
  });

  it('全部恢复默认后保存：prompts 为 3 键内置默认内容', async () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-1'), { target: { value: '改动' } });
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(Object.keys(body.prompts)).toHaveLength(3);
    expect(body.prompts.storyTeller).toContain('MiniMax H3 Prompt Director');
  });

  it('渲染破甲预设 textarea 与开关（打开时同步外部值）', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, armorBreak: '破甲文本', armorBreakEnabled: true }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByTestId('armor-break-text')).toHaveValue('破甲文本');
    expect(screen.getByTestId('armor-break-enabled')).toBeChecked();
  });

  it('保存携带 armorBreak/armorBreakEnabled', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('armor-break-text'), { target: { value: '新的破甲文本' } });
    fireEvent.click(screen.getByTestId('armor-break-enabled'));
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.armorBreak).toBe('新的破甲文本');
    expect(body.armorBreakEnabled).toBe(true);
  });
});
