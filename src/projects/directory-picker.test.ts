import { describe, expect, it, vi } from 'vitest';
import { openDirectory, pickProjectDirectory } from './directory-picker.js';

describe('原生项目目录选择器', () => {
  it('Linux 使用 zenity 返回选中的目录', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '/tmp/story-project\n' }));
    const result = pickProjectDirectory({ platform: 'linux', run });

    expect(result).toEqual({ path: '/tmp/story-project', available: true });
    expect(run).toHaveBeenCalledWith('zenity', expect.arrayContaining(['--file-selection', '--directory']), expect.anything());
  });

  it('zenity 不可用时回退到 kdialog', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: null, stdout: '', error: new Error('ENOENT') })
      .mockReturnValueOnce({ status: 0, stdout: '/tmp/fallback-project\n' });
    const result = pickProjectDirectory({ platform: 'linux', run });

    expect(result).toEqual({ path: '/tmp/fallback-project', available: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toBe('kdialog');
  });

  it('用户取消选择时返回空路径但选择器仍可用', () => {
    const run = vi.fn(() => ({ status: 1, stdout: '' }));
    const result = pickProjectDirectory({ platform: 'linux', run });

    expect(result).toEqual({ path: null, available: true });
  });

  it('Linux 使用 xdg-open 打开目录', () => {
    const run = vi.fn(() => ({ status: 0 }));

    openDirectory('/tmp/assets', { platform: 'linux', run });

    expect(run).toHaveBeenCalledWith('xdg-open', ['/tmp/assets'], expect.anything());
  });

  it('Windows 使用 explorer.exe 打开目录', () => {
    const run = vi.fn(() => ({ status: 0 }));

    openDirectory('C:\\assets', { platform: 'win32', run });

    expect(run).toHaveBeenCalledWith('explorer.exe', ['C:\\assets'], expect.anything());
  });
});
