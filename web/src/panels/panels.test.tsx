import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectList } from './ProjectList';
import { AssetLibrary } from './AssetLibrary';
import type { AssetItem } from './AssetLibrary';

describe('ProjectList', () => {
  it('渲染项目并高亮当前项（含分镜统计与模式徽章）', () => {
    render(<ProjectList
      projects={[
        { path: '/p/elf', name: 'elf_and_goblin', current: true, shots: 3, duration: 11.25, mode: 'KEYFRAME' },
        { path: '/p/pose', name: 'pose-transfer', current: false, shots: -1, duration: -1, mode: 'REF2V' },
      ]}
      activePath="/p/elf" onSelect={() => {}} onAdd={() => {}} onRemove={() => {}}
    />);
    expect(screen.getByText('elf_and_goblin').closest('.proj')).toHaveClass('active');
    expect(screen.getByText('pose-transfer').closest('.proj')).not.toHaveClass('active');
    expect(screen.getByText('3 分镜 · 11.25s')).toBeInTheDocument();
    // 无图数据项目显示占位文案而不是伪造统计
    expect(screen.getByText('尚未构建画布')).toBeInTheDocument();
  });

  it('点击项目触发 onSelect（传目录路径）', () => {
    const onSelect = vi.fn();
    render(<ProjectList
      projects={[{ path: '/p/x', name: 'x', current: true, shots: 1, duration: 3.75, mode: '' }]}
      activePath="/p/x" onSelect={onSelect} onAdd={() => {}} onRemove={() => {}}
    />);
    fireEvent.click(screen.getByText('x'));
    expect(onSelect).toHaveBeenCalledWith('/p/x');
  });

  it('空列表显示空态与添加按钮；点击移除按钮触发 onRemove（不冒泡到 onSelect）', () => {
    render(<ProjectList projects={[]} activePath="" onSelect={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByText('尚未添加项目')).toBeInTheDocument();
    expect(screen.getByText('＋ 添加项目')).toBeInTheDocument();
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectList
      projects={[{ path: '/p/y', name: 'y', current: false, shots: 1, duration: 3.75, mode: '' }]}
      activePath="" onSelect={onSelect} onAdd={() => {}} onRemove={onRemove}
    />);
    fireEvent.click(screen.getByTitle('从项目栏移除（不删除目录）'));
    expect(onRemove).toHaveBeenCalledWith('/p/y', 'y');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('AssetLibrary', () => {
  const items: AssetItem[] = [
    { kind: 'txt', name: 'global_prompt_v3.txt' },
    { kind: 'img', name: 'KF0_全景.png', meta: '768×1344' },
    { kind: 'vid', name: 'segment_01.mp4', meta: '3.75s' },
  ];

  it('渲染素材卡片并标注类型', () => {
    render(<AssetLibrary items={items} onDropToCanvas={() => {}} />);
    expect(screen.getByText('global_prompt_v3.txt')).toBeInTheDocument();
    expect(screen.getByText('TXT')).toBeInTheDocument();
    expect(screen.getByText('IMG')).toBeInTheDocument();
    expect(screen.getByText('VID')).toBeInTheDocument();
  });

  it('搜索过滤素材', () => {
    render(<AssetLibrary items={items} onDropToCanvas={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('搜索素材…'), { target: { value: 'KF0' } });
    expect(screen.getByText('KF0_全景.png')).toBeInTheDocument();
    expect(screen.queryByText('segment_01.mp4')).not.toBeInTheDocument();
  });

  it('导入按钮弹出类型菜单，点文字后触发文件选择（真实导入）', () => {
    render(<AssetLibrary items={items} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('＋ 导入'));
    expect(screen.getByText('文字 / 提示词')).toBeInTheDocument();
    fireEvent.click(screen.getByText('文字 / 提示词'));
    expect(document.querySelector('input[type=file]')).not.toBeNull();
  });

  it('导入菜单选择文字类型触发文件选择', () => {
    render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('＋ 导入'));
    fireEvent.click(screen.getByText('文字 / 提示词'));
    const fileInput = document.querySelector('input[type=file]');
    expect(fileInput).not.toBeNull();
  });

  it('空素材列表渲染空态卡片（标题 + 导入引导按钮）', () => {
    render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    expect(screen.getByTestId('asset-empty')).toBeInTheDocument();
    expect(screen.getByText('素材库是空的')).toBeInTheDocument();
    expect(screen.getByText(/Ctrl\+V 粘贴剪贴板图像/)).toBeInTheDocument();
    // 空态按钮可直接打开导入菜单
    fireEvent.click(screen.getByText('＋ 导入素材'));
    expect(screen.getByText('文字 / 提示词')).toBeInTheDocument();
  });

  it('搜索无结果时显示无匹配空态并可清除搜索', () => {
    render(<AssetLibrary items={[{ kind: 'img', name: 'KF0.png' }]} onDropToCanvas={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('搜索素材…'), { target: { value: 'zzz' } });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('清除搜索'));
    expect(screen.getByText('KF0.png')).toBeInTheDocument();
  });
});

describe('AssetLibrary 粘贴与拖入导入', () => {
  beforeEach(() => {
    // 上传接口返回成功；onAssetsChanged 触发刷新
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ asset: { id: 'a1', kind: 'img', name: 'pasted.png' } }),
      { status: 201 },
    )));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function pngFile(name = 'clipboard.png'): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  }

  it('Ctrl+V 粘贴图像文件触发上传', async () => {
    const onChanged = vi.fn();
    const { container } = render(<AssetLibrary items={[]} onDropToCanvas={() => {}} onAssetsChanged={onChanged} />);
    const assets = container.querySelector('.assets')!;
    const file = pngFile();
    fireEvent.paste(assets, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        types: ['Files'],
      },
    } as unknown as ClipboardEvent);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assets/upload', expect.anything()));
    expect(onChanged).toHaveBeenCalled();
  });

  it('粘贴非图像且不在输入框内时给出提示，不阻止默认行为', () => {
    const { container } = render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    const assets = container.querySelector('.assets')!;
    const prevented = { defaultPrevented: false };
    const ev = { clipboardData: { items: [], types: [] }, preventDefault: () => { prevented.defaultPrevented = true; } };
    fireEvent.paste(assets, ev as unknown as ClipboardEvent);
    expect(prevented.defaultPrevented).toBe(false);
    expect(screen.getByText(/剪贴板中没有图像/)).toBeInTheDocument();
  });

  it('拖入图像文件触发上传', async () => {
    const onChanged = vi.fn();
    const { container } = render(<AssetLibrary items={[]} onDropToCanvas={() => {}} onAssetsChanged={onChanged} />);
    const assets = container.querySelector('.assets')!;
    fireEvent.drop(assets, {
      dataTransfer: { files: [pngFile('drag.png')], types: ['Files'] },
    } as unknown as DragEvent);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assets/upload', expect.anything()));
    expect(onChanged).toHaveBeenCalled();
  });

  it('拖入 .txt 走文本导入接口', async () => {
    const { container } = render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    Object.defineProperty(File.prototype, 'text', {
      value: async function () { return 'hello'; },
      configurable: true,
    });
    const txt = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const assets = container.querySelector('.assets')!;
    fireEvent.drop(assets, {
      dataTransfer: { files: [txt], types: ['Files'] },
    } as unknown as DragEvent);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assets/import-text', expect.anything()));
  });
});

describe('AssetLibrary 导入失败反馈', () => {
  beforeEach(() => {
    // mock 后端导入接口返回 500（import-text 失败）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'INVALID_PATCH', message: '保存失败' }),
      { status: 500 },
    )));
    // jsdom 的 File 缺 text()（浏览器标准 API），测试中补齐
    Object.defineProperty(File.prototype, 'text', {
      value: async function () { return 'hello'; },
      configurable: true,
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('导入失败时面板内显示错误提示（不静默）', async () => {
    render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    // 打开导入菜单并选文字类型（设置 pendingKind=txt）
    fireEvent.click(screen.getByText('＋ 导入'));
    fireEvent.click(screen.getByText('文字 / 提示词'));
    // 触发隐藏 file input 的 change：选中一个 txt 文件
    const fileInput = document.querySelector('input[type=file]');
    expect(fileInput).not.toBeNull();
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    fireEvent.change(fileInput!, { target: { files: [file] } });
    // 错误提示出现并透传后端消息
    await waitFor(() => expect(screen.getByText(/导入失败/)).toBeInTheDocument());
    expect(screen.getByText(/保存失败/)).toBeInTheDocument();
  });
});