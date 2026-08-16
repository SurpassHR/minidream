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
});
