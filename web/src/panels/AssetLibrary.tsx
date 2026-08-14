import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';

export interface AssetItem {
  kind: 'txt' | 'img' | 'vid';
  name: string;
  meta?: string;   // 尺寸/时长等
  thumb?: string;  // 缩略图样式类（t1..t6）
}

// 从剪贴板/拖拽 File 列表按类型入库：
// 图像（png/jpg/jpeg/webp/gif）→ uploadAsset；.txt/.md → importText；其余报不支持
async function importFiles(
  files: FileList | File[],
  opts: { onOk: () => void; onError: (msg: string) => void },
): Promise<void> {
  for (const f of Array.from(files)) {
    const kind = f.type.startsWith('image/') ? 'img'
      : /.(txt|md)$/i.test(f.name) ? 'txt' : null;
    if (!kind) {
      opts.onError(`不支持的文件类型：${f.name}`);
      continue;
    }
    try {
      if (kind === 'txt') {
        const content = await f.text();
        await client.importText(f.name, content);
      } else {
        await client.uploadAsset(f);
      }
      opts.onOk();
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : String(err));
    }
  }
}

export function AssetLibrary(props: {
  items: AssetItem[];
  onDropToCanvas: (item: AssetItem, position: { x: number; y: number }) => void;
  // 导入成功后的刷新回调（父组件重新拉取素材列表）
  onAssetsChanged?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [importError, setImportError] = useState(''); // 导入失败提示（透传后端错误消息）
  const [items, setItems] = useState(props.items);
  // 拖入文件悬停高亮
  const [dragging, setDragging] = useState(false);
  // 父组件数据源变化（导入后 onAssetsChanged 刷新）时同步内部列表，使新素材立即可见
  useEffect(() => { setItems(props.items); }, [props.items]);
  // 真实导入：隐藏 file input + 待导入类型（决定 accept 与入库方式）
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingKind, setPendingKind] = useState<'txt' | 'img' | 'vid' | null>(null);

  const filtered = items.filter((i) => i.name.includes(query));

  const pickFile = (kind: 'txt' | 'img' | 'vid') => {
    setPendingKind(kind);
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    try {
      if (pendingKind === 'txt') {
        const content = await file.text();
        await client.importText(file.name, content);
      } else {
        await client.uploadAsset(file);
      }
      setImportError('');
      props.onAssetsChanged?.();
    } catch (err) {
      // 导入失败：透传后端错误消息，避免静默失败
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingKind(null);
    }
  };

  // Ctrl+V 粘贴导入：剪贴板含图像文件 → 直接入库；
  // 焦点在搜索框且剪贴板无图像时保持默认文本粘贴行为
  const handlePaste = (e: React.ClipboardEvent) => {
    const target = e.target as HTMLElement;
    const inInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    const images = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (images.length === 0) {
      if (!inInput) setImportError('剪贴板中没有图像');
      return; // 输入框内：交给默认粘贴
    }
    e.preventDefault();
    void importFiles(images, {
      onOk: () => { setImportError(''); props.onAssetsChanged?.(); },
      onError: setImportError,
    });
  };

  // 拖入文件导入：图像 / .txt/.md；悬停时高亮提示
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (!files.length) return;
    void importFiles(files, {
      onOk: () => { setImportError(''); props.onAssetsChanged?.(); },
      onError: setImportError,
    });
  };

  return (
    <div
      className={`assets ${dragging ? 'drag-over' : ''}`}
      onPaste={handlePaste}
      onDragOver={(e) => {
        e.preventDefault();
        if (Array.from(e.dataTransfer.types).includes('Files')) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div className="asset-tools">
        <input
          className="asset-search" placeholder="搜索素材…" value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="import-btn" onClick={() => setMenuOpen((v) => !v)}>＋ 导入</button>
      </div>
      <div className="import-hint">Ctrl+V 粘贴或拖入图片 / .txt 文件，自动入库</div>
      {menuOpen && (
        <div className="import-pop">
          <h4>导入到素材库</h4>
          <div className="ipt-row" onClick={() => pickFile('txt')}><span className="ic">📝</span>文字 / 提示词</div>
          <div className="ipt-row" onClick={() => pickFile('img')}><span className="ic">🖼</span>图像 / 参考图</div>
          <div className="ipt-row" onClick={() => pickFile('vid')}><span className="ic">🎬</span>视频 / 参考视频</div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        accept={pendingKind === 'txt' ? '.txt,.md' : pendingKind === 'img' ? '.png,.jpg,.jpeg,.webp' : '.mp4,.webm,.mov'}
        onChange={(e) => void onFileChosen(e)}
      />
      {importError && <div className="ne-error import-error">导入失败：{importError}</div>}
      {dragging && <div className="drop-mask">松开以导入素材</div>}
      <div className="asset-grid">
        {filtered.map((item) => (
          <div
            key={item.name}
            className="asset-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-asset', JSON.stringify(item));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            {item.kind === 'txt' ? (
              <div className="thumb txt"><span className="type-badge">TXT</span></div>
            ) : (
              <div className={`thumb ${item.thumb ?? 't1'}`}>
                <span className="type-badge">{item.kind.toUpperCase()}</span>
                {item.kind === 'vid' && <span className="vid-badge">▶ {item.meta ?? ''}</span>}
              </div>
            )}
            <div className="aname">{item.name}</div>
          </div>
        ))}
        {filtered.length === 0 && (items.length === 0 ? (
          <div className="asset-empty" data-testid="asset-empty">
            <div className="ae-frame"><span className="ae-icon">🖼</span></div>
            <div className="ae-title">素材库是空的</div>
            <div className="ae-sub">Ctrl+V 粘贴剪贴板图像，或把图片 / .txt 文件拖进这里，自动入库</div>
            <button className="import-btn" onClick={() => setMenuOpen(true)}>＋ 导入素材</button>
          </div>
        ) : (
          <div className="asset-empty slim">
            <div className="ae-title">没有匹配「{query}」的素材</div>
            <button className="link-btn" onClick={() => setQuery('')}>清除搜索</button>
          </div>
        ))}
      </div>
    </div>
  );
}
