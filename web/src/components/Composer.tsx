import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { GenerateData } from '../api';
import { computeResolution } from '../resolution';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

type PanelId = 'preference' | null;

export interface Attachment {
  id: string;
  kind: 'image' | 'video';
  /** 展示名：图片自动命名 图像1/图像2…；视频保留文件名 */
  name: string;
  dataUrl: string;
  /** 原始 URL（引用会话中已生成的图片时保留，预览用；无则回退 dataUrl） */
  url?: string;
  /** 是否为会话内生成图的引用（chip 标签显示「引用」） */
  referenced?: boolean;
  /** 原始文件名（自动命名 图像N 时保留，悬浮提示用） */
  sourceName?: string;
}

/** 供父组件（App）将「引用」的图片注入输入框 */
export interface ComposerHandle {
  addAttachment: (att: Omit<Attachment, 'id'> & { id?: string }) => void;
  focus: () => void;
}

export interface ComposerSubmitOpts {
  workflowId?: string;
  params?: Record<string, unknown>;
  images?: { name?: string; dataUrl: string }[];
  videos?: { name?: string; dataUrl: string }[];
  /** 生成比例（如 16:9 / 智能） */
  ratio?: string;
  /** 生成尺寸（MP，如 1 / 1.5 / 8） */
  size?: number;
}

/** 尺寸显示：1 → 1MP，1.5 → 1.5MP */
function formatSize(v: number): string {
  const n = Math.round(v * 100) / 100;
  return Number.isInteger(n) ? String(n) : String(n);
}

const Composer = forwardRef<ComposerHandle, {
  placeholder: string;
  composer: GenerateData['composer'];
  value: string;
  onChange: (v: string) => void;
  onSubmit: (opts: ComposerSubmitOpts) => void;
  onStop?: () => void;
  disabled?: boolean;
}>(function Composer({ placeholder, composer, value, onChange, onSubmit, onStop, disabled }, ref) {
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [ratio, setRatio] = useState(composer.preferences.ratios[0] ?? '智能');
  const sizeCfg = composer.preferences.sizes ?? { min: 0.5, max: 10, step: 0.5, default: 1 };
  const [size, setSize] = useState(sizeCfg.default);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  /** @ 提及弹窗：query 为 @ 后已输入的内容，index 为当前选中项 */
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const dropErrorTimer = useRef<number>(0);

  const showDropError = (msg: string) => {
    setDropError(msg);
    window.clearTimeout(dropErrorTimer.current);
    dropErrorTimer.current = window.setTimeout(() => setDropError(null), 2500);
  };

  const canSend = value.trim().length > 0 && !disabled;

  const clampSize = (v: number) => Math.min(sizeCfg.max, Math.max(sizeCfg.min, v));
  // 当前比例+尺寸对应的像素预览（智能比例 → null）
  const preview = computeResolution(ratio, size);

  // 暴露给父组件：注入「引用」图片并聚焦输入框（图片名按列表位置派生 图像N）
  useImperativeHandle(ref, () => ({
    addAttachment: att => {
      const isImg = att.kind === 'image';
      setAttachments(prev => [
        ...prev,
        { ...att, id: att.id ?? `a${Date.now()}`, name: isImg ? '' : att.name, sourceName: isImg ? att.name : undefined },
      ]);
    },
    focus: () => taRef.current?.focus(),
  }), []);

  const submit = () => {
    if (!canSend) return;
    // 只有输入框中 @图像N 提及的图片才进入上下文（N = 图片在引用列表中的位置）
    const mentioned = new Set<string>();
    const re = /@(图像\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) {
      const name = m[1];
      if (name) mentioned.add(name);
    }
    const allImages = attachments.filter(a => a.kind === 'image');
    const imageAtts = allImages.filter((_a, i) => mentioned.has(`图像${i + 1}`));
    const videoAtts = attachments.filter(a => a.kind === 'video');
    onSubmit({
      images: imageAtts.map((a, i) => ({ name: `图像${allImages.indexOf(a) + 1}`, dataUrl: a.dataUrl })),
      videos: videoAtts.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
      ratio,
      size,
    });
    setAttachments([]);
  };

  const toggle = (p: Exclude<PanelId, null>) => {
    setOpenPanel(openPanel === p ? null : p);
  };

  // 把本地文件（图片/视频）读为 dataUrl 并追加到引用列表
  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    let pending = files.length;
    const added: Attachment[] = [];
    const onDone = () => {
      if (--pending === 0 && added.length > 0) {
        setAttachments(prev => [...prev, ...added]);
      }
    };
    for (const file of files) {
      const kind: Attachment['kind'] = file.type.startsWith('video/') ? 'video' : 'image';
      const reader = new FileReader();
      reader.onload = () => {
        added.push({
          id: `a${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind,
          name: kind === 'image' ? '' : file.name || '粘贴视频.mp4',
          sourceName: kind === 'image' ? file.name : undefined,
          dataUrl: String(reader.result),
        });
        onDone();
      };
      reader.onerror = () => onDone();
      reader.readAsDataURL(file);
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    addFiles(files);
  };

  // 拖入的是页面内已有的图片（如会话里生成的图）→ dataTransfer 里只有 URL，拉取后加入引用列表
  const addImageUrl = async (rawUrl: string): Promise<boolean> => {
    const url = (rawUrl.split('\n')[0] ?? '').trim();
    if (!url) return false;
    const sameOrigin =
      url.startsWith('/') ||
      url.startsWith(location.origin) ||
      url.startsWith('blob:') ||
      url.startsWith('data:');
    if (!sameOrigin) return false; // 跨域图片不拉取
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) return false;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const q = new URLSearchParams(url.split('?')[1] ?? '');
      const last = url.split('/').pop()?.split('?')[0] ?? '';
      const rawName = q.get('filename') || (last.includes('.') ? last : '');
      const sourceName = decodeURIComponent(rawName) || undefined;
      setAttachments(prev => [
        ...prev,
        {
          id: `a${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'image',
          name: '',
          sourceName,
          dataUrl,
          url,
        },
      ]);
      return true;
    } catch {
      return false;
    }
  };

  // 拖拽图片/视频到输入框 → 进入引用列表（文件或页面内图片 URL 均可）
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type.startsWith('video/'),
    );
    if (files.length > 0) {
      addFiles(files);
      return;
    }
    const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).trim();
    if (uri) {
      const ok = await addImageUrl(uri);
      if (!ok) showDropError('无法引用该图片');
    }
  };

  // Ctrl+V 粘贴图片到输入框 → 进入引用列表
  const onPaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items
      .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
      .map(i => i.getAsFile())
      .filter((f): f is File => !!f);
    if (images.length > 0) {
      e.preventDefault();
      addFiles(images);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const kindLabel = { image: '图片', video: '视频', text: '文本' };

  // 当前可 @ 的图片列表（图片名按列表位置派生：第 N 张 = 图像N）
  const imageAtts = attachments.filter(a => a.kind === 'image');
  const imageName = (a: Attachment) => `图像${imageAtts.indexOf(a) + 1}`;
  const filteredImages = mention ? imageAtts.filter(a => imageName(a).includes(mention.query)) : [];

  // 输入变化时检测光标前的 @，打开/更新提及弹窗
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    onChange(text);
    const pos = e.target.selectionStart ?? text.length;
    const match = /@([^\s@]*)$/.exec(text.slice(0, pos));
    if (match && imageAtts.length > 0) {
      const query = match[1] ?? '';
      if (imageAtts.some(a => imageName(a).includes(query))) {
        setMention({ query, index: 0 });
        return;
      }
    }
    setMention(null);
  };

  // 把选中的 @图像N 插入文本（替换已输入的 @ 前缀与部分内容）
  const insertMention = (index: number) => {
    const ta = taRef.current;
    const item = filteredImages[index];
    if (!ta || !item) {
      setMention(null);
      return;
    }
    const text = value;
    const pos = ta.selectionStart ?? text.length;
    const match = /@([^\s@]*)$/.exec(text.slice(0, pos));
    if (!match) {
      setMention(null);
      return;
    }
    const partial = match[1] ?? '';
    const mentionText = imageName(item);
    const insertAt = pos - partial.length - 1; // '@' 所在位置
    const next = text.slice(0, insertAt) + '@' + mentionText + text.slice(pos);
    onChange(next);
    setMention(null);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = insertAt + 1 + mentionText.length;
      ta.setSelectionRange(newPos, newPos);
    });
  };

  return (
    <div
      className={`composer${focused ? ' focused' : ''}${dragOver ? ' dragging' : ''}`}
      onDragEnter={e => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={e => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="composer-drop-hint">
          松开以添加图片/视频到引用列表
        </div>
      )}
      {dropError && <div className="composer-drop-error">{dropError}</div>}
      {openPanel && <div className="composer-mask" onClick={() => setOpenPanel(null)} />}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map(a =>
            a.kind === 'image' ? (
              // 图片 chip：缩略图 + 等宽彩色标签 + 彩色背景，点击预览大图
              <span
                key={a.id}
                className={`attachment-chip image${a.referenced ? ' referenced' : ''}`}
                title={a.sourceName ? `${a.sourceName} · 点击预览图片` : '点击预览图片'}
                onClick={() => setLightbox({ url: a.url ?? a.dataUrl, alt: imageName(a) })}
              >
                <img className="attachment-thumb" src={a.url ?? a.dataUrl} alt={imageName(a)} />
                <em className="attachment-kind image">{a.referenced ? '引用' : kindLabel.image}</em>
                <span className="attachment-name">{imageName(a)}</span>
                <button
                  className="attachment-remove"
                  aria-label="移除"
                  onClick={e => {
                    e.stopPropagation();
                    removeAttachment(a.id);
                  }}
                >
                  ×
                </button>
              </span>
            ) : (
              <span key={a.id} className="attachment-chip">
                <em className={`attachment-kind ${a.kind}`}>{kindLabel[a.kind]}</em>
                {a.name}
                <button className="attachment-remove" onClick={() => removeAttachment(a.id)} aria-label="移除">
                  ×
                </button>
              </span>
            ),
          )}
        </div>
      )}

      <div className="composer-input-wrap">
        {mention && filteredImages.length > 0 && (
          <div className="mention-popup">
            {filteredImages.map((a, i) => (
              <button
                key={a.id}
                type="button"
                className={`mention-item${i === mention.index ? ' active' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertMention(i)}
              >
                <img src={a.url ?? a.dataUrl} alt={imageName(a)} />
                <span className="mention-name">{imageName(a)}</span>
                {a.referenced && <span className="mention-tag">引用</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          className="composer-input"
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={onInputChange}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            window.setTimeout(() => setMention(null), 120);
          }}
          onPaste={onPaste}
          onKeyDown={e => {
            if (mention) {
              const count = filteredImages.length;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMention(m => (m ? { ...m, index: (m.index + 1) % count } : m));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMention(m => (m ? { ...m, index: (m.index - 1 + count) % count } : m));
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertMention(mention.index);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>

      <div className="composer-bottom">
        <div className="composer-modes">
          {/* 生成比例 + 生成尺寸 */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'preference' ? ' open' : ''}`}
              onClick={() => toggle('preference')}
              title="生成比例 / 生成尺寸"
            >
              {ratio} · {formatSize(size)}MP
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'preference' && (
              <div className="composer-panel pref-panel">
                <div className="panel-title">生成比例</div>
                <div className="pref-ratios">
                  {composer.preferences.ratios.map(r => (
                    <button
                      key={r}
                      className={`pref-ratio${ratio === r ? ' active' : ''}`}
                      onClick={() => setRatio(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>

                <div className="panel-title">生成尺寸</div>
                <div className="pref-size">
                  <div className="pref-size-row">
                    <button
                      className="pref-size-btn"
                      onClick={() => setSize(prev => clampSize(Math.round((prev - sizeCfg.step) / sizeCfg.step) * sizeCfg.step))}
                      aria-label="减小尺寸"
                    >
                      −
                    </button>
                    <div className="pref-size-input-wrap">
                      <input
                        className="pref-size-input"
                        type="number"
                        min={sizeCfg.min}
                        max={sizeCfg.max}
                        step={sizeCfg.step}
                        value={size}
                        onChange={e => {
                          const v = parseFloat(e.target.value);
                          setSize(Number.isFinite(v) ? clampSize(v) : sizeCfg.default);
                        }}
                      />
                      <span className="pref-size-unit">MP</span>
                    </div>
                    <button
                      className="pref-size-btn"
                      onClick={() => setSize(prev => clampSize(Math.round((prev + sizeCfg.step) / sizeCfg.step) * sizeCfg.step))}
                      aria-label="增大尺寸"
                    >
                      +
                    </button>
                  </div>
                  <input
                    className="pref-size-range"
                    type="range"
                    min={sizeCfg.min}
                    max={sizeCfg.max}
                    step={sizeCfg.step}
                    value={size}
                    onChange={e => setSize(clampSize(parseFloat(e.target.value)))}
                  />
                  <div className="pref-size-scale">
                    <span>{formatSize(sizeCfg.min)}MP</span>
                    <span>{formatSize(sizeCfg.max)}MP</span>
                  </div>
                  <div className="pref-size-preview">
                    {preview ? (
                      <>
                        <span className="pref-size-preview-px">{preview.width} × {preview.height} px</span>
                        {preview.capped && (
                          <span className="pref-size-preview-hint">已按最大边长等比缩放</span>
                        )}
                      </>
                    ) : (
                      <span className="pref-size-preview-hint">智能比例：跟随工作流默认分辨率</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        <div className="composer-actions">
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onPickFile} />
          <button
            className="composer-tool"
            title="上传素材（图片/视频）"
            aria-label="上传素材"
            onClick={() => fileRef.current?.click()}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="7" cy="7" r="1.6" fill="currentColor" />
              <path d="m4 12 3.4-3.4 2.4 2.4 1.7-1.7 2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="composer-tool"
            title="参考图"
            aria-label="参考图"
            onClick={() => fileRef.current?.click()}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 2.5h7l3 3v10H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M11 2.5V6h3.5M6.5 9.5v4M4.5 11.5h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          {disabled ? (
            <button
              className="composer-stop"
              onClick={onStop}
              title="停止生成"
              aria-label="停止生成"
            >
              <span className="composer-stop-icon" />
              停止
            </button>
          ) : (
            <button
              className={`composer-send${canSend ? ' enabled' : ''}`}
              disabled={!canSend}
              onClick={submit}
              title="发送"
              aria-label="发送"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2.5v11m0 0 4.5-4.5M10 13.5 5.5 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
});

export default Composer;
