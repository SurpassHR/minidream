import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProjectSwitcher } from './ProjectSwitcher';
import { AssetLibrary } from './AssetLibrary';
import type { AssetItem } from './AssetLibrary';
import { AddProjectDialog } from './AddProjectDialog';

describe('AddProjectDialog', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('浏览按钮通过系统目录选择器填入真实项目路径', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ path: '/tmp/story-project' }),
      { status: 200 },
    )));
    render(<AddProjectDialog open onClose={() => {}} onAdded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '浏览' }));
    await waitFor(() => expect(screen.getByDisplayValue('/tmp/story-project')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/projects/pick-directory', expect.objectContaining({ headers: {} }));
  });
});

describe('ProjectSwitcher', () => {
  // 下拉面板默认收起：先点当前项目名展开；下拉内的查询用 within 限定（按钮也含项目名）
  const openDropdown = () => fireEvent.click(screen.getByTestId('project-name'));
  const dropdown = () => within(screen.getByTestId('project-dropdown'));

  it('渲染当前项目名；展开后列出项目并高亮当前项（含分镜统计）', () => {
    render(<ProjectSwitcher
      projects={[
        { path: '/p/elf', name: 'elf_and_goblin', current: true, shots: 3, duration: 11.25, mode: 'KEYFRAME' },
        { path: '/p/pose', name: 'pose-transfer', current: false, shots: -1, duration: -1, mode: 'REF2V' },
      ]}
      activePath="/p/elf" fallbackName="" onSelect={() => {}} onAdd={() => {}} onRemove={() => {}}
    />);
    // 按钮显示当前项目名
    expect(screen.getByTestId('project-name')).toHaveTextContent('elf_and_goblin');
    openDropdown();
    expect(dropdown().getByText('elf_and_goblin').closest('.ps-item')).toHaveClass('active');
    expect(dropdown().getByText('pose-transfer').closest('.ps-item')).not.toHaveClass('active');
    expect(dropdown().getByText('3 分镜 · 11.25s')).toBeInTheDocument();
    // 无图数据项目显示占位文案而不是伪造统计
    expect(dropdown().getByText('尚未构建画布')).toBeInTheDocument();
  });

  it('点击项目触发 onSelect（传目录路径）并收起下拉', () => {
    const onSelect = vi.fn();
    render(<ProjectSwitcher
      projects={[{ path: '/p/x', name: 'x', current: true, shots: 1, duration: 3.75, mode: '' }]}
      activePath="/p/x" fallbackName="" onSelect={onSelect} onAdd={() => {}} onRemove={() => {}}
    />);
    openDropdown();
    fireEvent.click(dropdown().getByText('x'));
    expect(onSelect).toHaveBeenCalledWith('/p/x');
    expect(screen.queryByTestId('project-dropdown')).not.toBeInTheDocument();
  });

  it('空列表显示空态与添加按钮', () => {
    render(<ProjectSwitcher projects={[]} activePath="" fallbackName="" onSelect={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    openDropdown();
    expect(dropdown().getByText('尚未添加项目')).toBeInTheDocument();
    expect(dropdown().getByText('＋ 添加项目')).toBeInTheDocument();
  });

  it('未打开项目时不显示 graph fallback 名称', () => {
    render(<ProjectSwitcher projects={[]} activePath="" fallbackName="director-workbench" projectOpen={false} onSelect={() => {}} onAdd={() => {}} onRemove={() => {}} />);
    expect(screen.getByTestId('project-name')).toHaveTextContent('未打开项目');
    expect(screen.getByTestId('project-name')).not.toHaveTextContent('director-workbench');
  });

  it('重命名按钮触发 onRename（不冒泡到 onSelect）', () => {
    const onRename = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectSwitcher
      projects={[{ path: '/p/y', name: 'y', current: false, shots: 1, duration: 3.75, mode: '' }]}
      activePath="" fallbackName="" onSelect={onSelect} onAdd={() => {}} onRename={onRename} onRemove={() => {}}
    />);
    openDropdown();
    const actions = screen.getByTestId('project-y-actions');
    expect(actions).toHaveClass('project-item-actions');
    expect(within(actions).getByTitle('重命名项目')).toBeInTheDocument();
    expect(within(actions).getByTitle('删除项目文件（不可恢复）')).toBeInTheDocument();
    fireEvent.click(within(actions).getByTitle('重命名项目'));
    expect(onRename).toHaveBeenCalledWith('/p/y', 'y');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('删除按钮触发 onRemove（不冒泡到 onSelect）', () => {
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    render(<ProjectSwitcher
      projects={[{ path: '/p/y', name: 'y', current: false, shots: 1, duration: 3.75, mode: '' }]}
      activePath="" fallbackName="" onSelect={onSelect} onAdd={() => {}} onRemove={onRemove}
    />);
    openDropdown();
    fireEvent.click(dropdown().getByTitle('删除项目文件（不可恢复）'));
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

describe('AssetLibrary CRUD', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/content')) {
        return new Response(JSON.stringify({ content: '旧文本内容' }), { status: 200 });
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ asset: { id: 'a1', kind: 'txt', name: '新名称.md' } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('文本素材可编辑名称与内容并保存', async () => {
    const onChanged = vi.fn();
    render(<AssetLibrary items={[{ id: 'a1', kind: 'txt', name: '旧名称.md' }]} onDropToCanvas={() => {}} onAssetsChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('asset-edit-a1'));
    const name = await screen.findByTestId('asset-edit-name');
    const content = await screen.findByTestId('asset-edit-content');
    expect(content).toHaveValue('旧文本内容');
    fireEvent.change(name, { target: { value: '新名称.md' } });
    fireEvent.change(content, { target: { value: '新文本内容' } });
    fireEvent.click(screen.getByTestId('asset-edit-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls.find((entry) => (entry[1] as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: '新名称.md', content: '新文本内容' });
  });

  it('图像与视频素材卡片显示真实缩略图', () => {
    render(<AssetLibrary items={[
      { id: 'thumb-img', kind: 'img', name: 'thumb.png' },
      { id: 'thumb-vid', kind: 'vid', name: 'thumb.mp4' },
    ]} onDropToCanvas={() => {}} />);
    expect(screen.getByTestId('asset-thumbnail-image')).toHaveAttribute('src', '/api/assets/thumb-img/file');
    expect(screen.getByTestId('asset-thumbnail-video')).toHaveAttribute('src', '/api/assets/thumb-vid/file');
  });

  it('图像素材点击后打开图片预览', async () => {
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png' }]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('preview.png'));
    const preview = await screen.findByTestId('asset-preview-image');
    expect(preview).toHaveAttribute('src', '/api/assets/img-1/file');
    expect(within(screen.getByRole('dialog')).getByText('preview.png')).toBeInTheDocument();
  });

  it('视频素材点击后打开首帧预览', async () => {
    render(<AssetLibrary items={[{ id: 'vid-1', kind: 'vid', name: 'preview.mp4' }]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('preview.mp4'));
    const preview = await screen.findByTestId('asset-preview-video');
    expect(preview).toHaveAttribute('src', '/api/assets/vid-1/file');
    expect(preview).toHaveAttribute('preload', 'metadata');
  });

  it('文本素材点击后读取并显示文本预览', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/content')) {
        return new Response(JSON.stringify({ content: '# 预览内容\\n第二行' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    render(<AssetLibrary items={[{ id: 'txt-1', kind: 'txt', name: 'preview.md' }]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('preview.md'));
    expect(await screen.findByTestId('asset-preview-text')).toHaveTextContent('# 预览内容');
    expect(screen.getByTestId('asset-preview-text')).toHaveTextContent('第二行');
  });

  it('素材删除需要确认并调用 DELETE', async () => {
    const onChanged = vi.fn();
    render(<AssetLibrary items={[{ id: 'a1', kind: 'img', name: 'a.png' }]} onDropToCanvas={() => {}} onAssetsChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('asset-delete-a1'));
    expect(await screen.findByText('删除素材')).toBeInTheDocument();
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some((entry) => String(entry[0]).includes('/api/assets/a1') && (entry[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
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

describe('AssetLibrary 图像 captioning', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/caption')) {
        return new Response(JSON.stringify({
          caption: '墨绿斗篷的精灵骑士，手持发光长剑',
          asset: { id: 'cap-1', kind: 'txt', name: 'preview.txt' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('图像卡片 captioning 按钮调用接口并打开 caption 预览', async () => {
    const onChanged = vi.fn();
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png' }]} onDropToCanvas={() => {}} onAssetsChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('asset-caption-img-1'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assets/img-1/caption', expect.objectContaining({ method: 'POST' })));
    expect(onChanged).toHaveBeenCalled();
    // 预览打开并直接显示 caption 文本（无需再拉取内容）
    expect(await screen.findByTestId('asset-preview-text')).toHaveTextContent('墨绿斗篷的精灵骑士');
  });

  it('captioning 失败时显示错误且不打开预览', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (String(url).endsWith('/caption')) {
        return new Response(JSON.stringify({ code: 'INVALID_PATCH', message: '请先在设置中配置 Ollama 地址与视觉模型' }), { status: 400 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png' }]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByTestId('asset-caption-img-1'));
    expect(await screen.findByText(/Captioning 失败/)).toBeInTheDocument();
    expect(screen.queryByTestId('asset-preview-text')).not.toBeInTheDocument();
  });

  it('非图像素材不显示 captioning 按钮', () => {
    render(<AssetLibrary items={[{ id: 't1', kind: 'txt', name: 'a.txt' }]} onDropToCanvas={() => {}} />);
    expect(screen.queryByTestId('asset-caption-t1')).not.toBeInTheDocument();
  });

  it('图像卡片在缩略图下方显示 caption 文本', () => {
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png', caption: '墨绿斗篷的精灵骑士' }]} onDropToCanvas={() => {}} />);
    expect(screen.getByText('墨绿斗篷的精灵骑士')).toBeInTheDocument();
  });

  it('无 caption 的图像卡片不显示描述区', () => {
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png' }]} onDropToCanvas={() => {}} />);
    expect(document.querySelector('.aname-caption')).not.toBeInTheDocument();
  });

  it('点开图像素材预览时显示 caption', async () => {
    render(<AssetLibrary items={[{ id: 'img-1', kind: 'img', name: 'preview.png', caption: '墨绿斗篷的精灵骑士' }]} onDropToCanvas={() => {}} />);
    fireEvent.click(screen.getByText('preview.png'));
    const preview = await screen.findByTestId('asset-preview-image');
    expect(preview).toHaveAttribute('src', '/api/assets/img-1/file');
    expect(screen.getByTestId('asset-preview-caption')).toHaveTextContent('墨绿斗篷的精灵骑士');
  });
});