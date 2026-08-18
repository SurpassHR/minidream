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

  it('提示词库仅保留 objectDesigner：名称只读（标签+键名），内容=内置默认', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // storyTeller / storySummarize 已下沉到剧本项目：全局不再展示
    expect(screen.queryByText('storyTeller')).not.toBeInTheDocument();
    expect(screen.queryByText('storySummarize')).not.toBeInTheDocument();
    expect(screen.getByText('objectDesigner')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-name-0')).not.toHaveAttribute('onChange'); // 名称不可编辑（span 非 input）
    expect(screen.getByText('物体设计 · AI 优化')).toBeInTheDocument();
    // 内容 = 内置默认
    expect(screen.getByDisplayValue(/物体设计师/)).toBeInTheDocument();
    // 无新增按钮
    expect(screen.queryByTestId('prompt-add')).not.toBeInTheDocument();
  });

  it('存储值优先：objectDesigner 已存内容展示，缺失键显示内置默认', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { objectDesigner: '定制物体设计', custom: '自定义内容' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    expect(screen.getByDisplayValue('定制物体设计')).toBeInTheDocument();
    // 自定义键不再展示（仅保留 objectDesigner）
    expect(screen.queryByDisplayValue('自定义内容')).not.toBeInTheDocument();
  });

  it('编辑内容 + 条目级恢复默认', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '改过的物体设计' } });
    expect(screen.getByDisplayValue('改过的物体设计')).toBeInTheDocument();
    // 条目级「↺ 默认」恢复内置默认内容
    fireEvent.click(screen.getByTestId('prompt-reset-0'));
    expect(screen.getByDisplayValue(/物体设计师/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('改过的物体设计')).not.toBeInTheDocument();
  });

  it('重置为默认提示词：objectDesigner 恢复内置默认', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, prompts: { objectDesigner: '改过' } }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    expect(screen.getByDisplayValue(/物体设计师/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('改过')).not.toBeInTheDocument();
  });

  it('保存携带 prompts：仅 objectDesigner 键（空内容保留=回退默认）', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '定制物体设计' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(Object.keys(body.prompts).sort()).toEqual(['objectDesigner']);
    expect(body.prompts.objectDesigner).toBe('定制物体设计');
  });

  it('全部恢复默认后保存：prompts 为 1 键内置默认内容', async () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('prompt-text-0'), { target: { value: '改动' } });
    fireEvent.click(screen.getByText('↺ 重置为默认提示词'));
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(Object.keys(body.prompts)).toHaveLength(1);
    expect(body.prompts.objectDesigner).toContain('物体设计师');
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

  it('左侧导航切换右侧配置项：默认 ComfyUI，点击切换 Ollama/提示词库', () => {
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 默认激活 ComfyUI 配置
    expect(screen.getByTestId('sec-comfy')).toHaveClass('active');
    expect(screen.getByTestId('sec-ollama')).not.toHaveClass('active');
    expect(screen.getByTestId('sec-prompts')).not.toHaveClass('active');
    // 点击导航切换
    fireEvent.click(screen.getByTestId('nav-ollama'));
    expect(screen.getByTestId('sec-ollama')).toHaveClass('active');
    expect(screen.getByTestId('sec-comfy')).not.toHaveClass('active');
    fireEvent.click(screen.getByTestId('nav-prompts'));
    expect(screen.getByTestId('sec-prompts')).toHaveClass('active');
    expect(screen.getByTestId('sec-ollama')).not.toHaveClass('active');
    // 左侧分组标题存在
    expect(screen.getByText('服务连接')).toBeInTheDocument();
    expect(screen.getByText('AI 对话')).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();
  });

  it('渲染 Ollama 区块（地址/视觉模型），打开时同步外部值', () => {
    render(<SettingsModal
      open
      settings={{ ...DEFAULT_SETTINGS, ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'llava:13b' }} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    // 标题同时出现在导航与右侧 section（getAllByText：不要求唯一）
    expect(screen.getAllByText('Ollama 视觉模型').length).toBeGreaterThan(0);
    expect(screen.getByTestId('ollama-url')).toHaveValue('http://127.0.0.1:11434');
    expect(screen.getByTestId('ollama-model')).toHaveValue('llava:13b');
  });

  it('保存携带 ollamaUrl/ollamaModel', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={onClose} onSaved={onSaved} onError={() => {}}
    />);
    fireEvent.change(screen.getByTestId('ollama-url'), { target: { value: 'http://127.0.0.1:11434' } });
    fireEvent.change(screen.getByTestId('ollama-model'), { target: { value: 'qwen2.5vl:7b' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]?.body));
    expect(body.ollamaUrl).toBe('http://127.0.0.1:11434');
    expect(body.ollamaModel).toBe('qwen2.5vl:7b');
  });

  it('打开时拉取已安装 Ollama 模型填充 datalist', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/ollama/models')) {
        return new Response(JSON.stringify({ models: ['llava:13b', 'qwen2.5vl:7b'] }), { status: 200 });
      }
      if (String(url).includes('/api/settings')) {
        return new Response(JSON.stringify({ settings: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    render(<SettingsModal
      open settings={DEFAULT_SETTINGS} models={[]}
      onClose={() => {}} onSaved={() => {}} onError={() => {}}
    />);
    await waitFor(() => expect(screen.getByTestId('ollama-model')).toHaveAttribute('list', 'ollama-models'));
    // datalist 选项以 <option> 渲染（getByDisplayValue 只匹配 input/select，用 option 查询）
    const opts = Array.from(document.querySelectorAll('#ollama-models option')).map((o) => o.getAttribute('value'));
    expect(opts).toEqual(['llava:13b', 'qwen2.5vl:7b']);
  });
});
