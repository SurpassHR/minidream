import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';

export interface AssetItem {
  kind: 'txt' | 'img' | 'vid';
  name: string;
  meta?: string;   // 尺寸/时长等
  thumb?: string;  // 缩略图样式类（t1..t6）
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

  return (
    <div className="assets">
      <div className="asset-tools">
        <input
          className="asset-search" placeholder="搜索素材…" value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="import-btn" onClick={() => setMenuOpen((v) => !v)}>＋ 导入</button>
      </div>
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
        {filtered.length === 0 && <div className="q-empty">暂无素材，点＋导入</div>}
      </div>
    </div>
  );
}
