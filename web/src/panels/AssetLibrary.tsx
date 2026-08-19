import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import { Icon } from '../icons';
import { ConfirmDialog } from './ConfirmDialog';

export interface AssetItem {
  id?: string;
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
  const [editTarget, setEditTarget] = useState<AssetItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssetItem | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [previewTarget, setPreviewTarget] = useState<AssetItem | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');

  const filtered = items.filter((i) => i.name.includes(query));

  const openPreview = async (item: AssetItem) => {
    if (!item.id) return;
    setPreviewTarget(item);
    setPreviewContent(null);
    setPreviewError('');
    if (item.kind !== 'txt') return;
    try {
      const res = await fetch(`/api/assets/${encodeURIComponent(item.id)}/content`);
      const body = await res.json() as { content?: string; message?: string };
      if (!res.ok) throw new Error(body.message ?? '读取文本素材失败');
      setPreviewContent(body.content ?? '');
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取文本素材失败');
    }
  };

  const closePreview = () => {
    setPreviewTarget(null);
    setPreviewContent(null);
    setPreviewError('');
  };

  const openEdit = async (item: AssetItem) => {
    if (!item.id) return;
    setEditTarget(item);
    setEditName(item.name);
    setEditContent('');
    setEditFile(null);
    if (item.kind === 'txt') {
      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(item.id)}/content`);
        const body = await res.json() as { content?: string };
        setEditContent(body.content ?? '');
      } catch (err) {
        setImportError(err instanceof Error ? err.message : '读取素材内容失败');
      }
    }
  };

  const saveEdit = async () => {
    const target = editTarget;
    if (!target?.id || !editName.trim()) return;
    setEditBusy(true);
    try {
      if (editFile) await client.replaceAsset(target.id, editFile);
      await client.updateAsset(target.id, {
        name: editName.trim(),
        ...(target.kind === 'txt' ? { content: editContent } : {}),
      });
      setEditTarget(null);
      setEditFile(null);
      setImportError('');
      props.onAssetsChanged?.();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '保存素材失败');
    } finally {
      setEditBusy(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target?.id) return;
    setDeleteTarget(null);
    try {
      await client.deleteAsset(target.id);
      setImportError('');
      props.onAssetsChanged?.();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '删除素材失败');
    }
  };

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
          <div className="ipt-row" onClick={() => pickFile('txt')}><span className="ic"><Icon name="file-text" /></span>文字 / 提示词</div>
          <div className="ipt-row" onClick={() => pickFile('img')}><span className="ic"><Icon name="image" /></span>图像 / 参考图</div>
          <div className="ipt-row" onClick={() => pickFile('vid')}><span className="ic"><Icon name="video" /></span>视频 / 参考视频</div>
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
            key={item.id ?? item.name}
            className="asset-card"
            draggable
            role="button"
            tabIndex={0}
            onClick={() => { void openPreview(item); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void openPreview(item);
              }
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-asset', JSON.stringify(item));
              e.dataTransfer.effectAllowed = 'copy';
            }}
          >
            {item.kind === 'txt' ? (
              <div className="thumb txt"><span className="type-badge">TXT</span></div>
            ) : (
              <div className={`thumb ${item.thumb ?? 't1'}`}>
                {item.id && item.kind === 'img' && (
                  <img
                    data-testid="asset-thumbnail-image"
                    className="thumb-media"
                    src={`/api/assets/${encodeURIComponent(item.id)}/file`}
                    alt=""
                    draggable={false}
                  />
                )}
                {item.id && item.kind === 'vid' && (
                  <video
                    data-testid="asset-thumbnail-video"
                    className="thumb-media"
                    src={`/api/assets/${encodeURIComponent(item.id)}/file`}
                    muted
                    playsInline
                    preload="metadata"
                    tabIndex={-1}
                    aria-hidden="true"
                    onLoadedMetadata={(e) => { e.currentTarget.currentTime = 0; }}
                  />
                )}
                <span className="type-badge">{item.kind.toUpperCase()}</span>
                {item.kind === 'vid' && <span className="vid-badge">▶ {item.meta ?? ''}</span>}
              </div>
            )}
            <div className="aname">{item.name}</div>
            {item.id && (
              <div className="asset-card-actions">
                <button type="button" data-testid={`asset-edit-${item.id}`} title="编辑素材" onClick={(e) => { e.stopPropagation(); void openEdit(item); }}><Icon name="pencil" /></button>
                <button type="button" data-testid={`asset-delete-${item.id}`} title="删除素材" onClick={(e) => { e.stopPropagation(); setDeleteTarget(item); }}><Icon name="trash" /></button>
              </div>
            )}
          </div>
        ))}
        {filtered.length === 0 && (items.length === 0 ? (
          <div className="asset-empty" data-testid="asset-empty">
            <div className="ae-frame"><span className="ae-icon"><Icon name="image" /></span></div>
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
      {previewTarget && (
        <div className="dialog-mask asset-preview-mask" role="dialog" aria-label={`预览素材：${previewTarget.name}`} onClick={closePreview}>
          <div className="dialog dialog-wide asset-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">预览素材</div>
            <div className="asset-preview-name">{previewTarget.name}</div>
            {previewTarget.kind === 'img' && (
              <img
                data-testid="asset-preview-image"
                className="asset-preview-image"
                src={`/api/assets/${encodeURIComponent(previewTarget.id!)}/file`}
                alt={previewTarget.name}
              />
            )}
            {previewTarget.kind === 'vid' && (
              <video
                data-testid="asset-preview-video"
                className="asset-preview-video"
                src={`/api/assets/${encodeURIComponent(previewTarget.id!)}/file`}
                controls
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = 0;
                }}
              />
            )}
            {previewTarget.kind === 'txt' && (
              previewError ? (
                <div className="ne-error asset-preview-error">读取失败：{previewError}</div>
              ) : previewContent === null ? (
                <div className="asset-preview-loading">读取中…</div>
              ) : (
                <pre data-testid="asset-preview-text" className="asset-preview-text">{previewContent}</pre>
              )
            )}
            <div className="dialog-actions">
              <button type="button" className="btn-ghost" onClick={closePreview}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {editTarget && (
        <div className="dialog-mask asset-edit-mask" role="dialog" aria-label="编辑素材">
          <div className="dialog dialog-wide asset-edit-dialog">
            <div className="dialog-title">编辑素材</div>
            <label className="asset-edit-label">名称<input data-testid="asset-edit-name" className="ne-input" value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
            {editTarget.kind === 'txt' ? (
              <label className="asset-edit-label">内容<textarea data-testid="asset-edit-content" className="ne-textarea" value={editContent} onChange={(e) => setEditContent(e.target.value)} /></label>
            ) : (
              <>
                <div className="asset-edit-file">当前文件：{editTarget.name}</div>
                <input
                  ref={replaceInputRef}
                  data-testid="asset-replace-input"
                  type="file"
                  accept={editTarget.kind === 'img' ? '.png,.jpg,.jpeg,.webp' : '.mp4,.webm,.mov'}
                  onChange={(e) => setEditFile(e.target.files?.[0] ?? null)}
                />
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn-ghost" onClick={() => setEditTarget(null)} disabled={editBusy}>取消</button>
              <button type="button" className="btn-primary" data-testid="asset-edit-save" onClick={() => { void saveEdit(); }} disabled={editBusy || !editName.trim()}>{editBusy ? '保存中…' : '保存素材'}</button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除素材"
        body={`删除「${deleteTarget?.name ?? ''}」？该操作会移除素材文件，且无法撤销。`}
        confirmLabel="确认删除"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { void confirmDelete(); }}
      />
    </div>
  );
}
