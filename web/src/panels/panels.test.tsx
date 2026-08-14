import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectList } from './ProjectList';
import { AssetLibrary } from './AssetLibrary';
import type { AssetItem } from './AssetLibrary';

describe('ProjectList', () => {
  it('渲染项目并高亮当前项', () => {
    render(<ProjectList
      projects={[
        { id: 'p1', name: 'elf_and_goblin', meta: '3 分镜 · 11.25s', mode: 'KEYFRAME' },
        { id: 'p2', name: 'cat-vs-bunny', meta: '3 分镜 · 9.12s', mode: 'KEYFRAME' },
      ]}
      activeId="p1" onSelect={() => {}}
    />);
    expect(screen.getByText('elf_and_goblin').closest('.proj')).toHaveClass('active');
    expect(screen.getByText('cat-vs-bunny').closest('.proj')).not.toHaveClass('active');
  });

  it('点击项目触发 onSelect', () => {
    const onSelect = vi.fn();
    render(<ProjectList projects={[{ id: 'p1', name: 'x', meta: 'm', mode: 'M' }]} activeId="" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('x'));
    expect(onSelect).toHaveBeenCalledWith('p1');
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

  it('空素材列表渲染空态提示', () => {
    render(<AssetLibrary items={[]} onDropToCanvas={() => {}} />);
    expect(screen.getByText(/暂无素材/)).toBeInTheDocument();
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
