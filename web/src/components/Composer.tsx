import { forwardRef, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { uploadImageAsset, type GenerateData } from '../api';
import { computeResolution } from '../resolution';
import { findMentionedSessionAssets, insertAssetMention, nextSessionAssetName, type SessionAsset } from '../sessionAssets';
import ImageLightbox from './ImageLightbox';
import VideoLightbox from './VideoLightbox';
import { MentionText } from '../mentionText';

type PanelId = 'preference' | null;

export interface ComposerHandle {
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
  assets?: SessionAsset[];
}

/** 尺寸显示：1 → 1MP，1.5 → 1.5MP */
function formatSize(v: number): string {
  const n = Math.round(v * 100) / 100;
  return Number.isInteger(n) ? String(n) : String(n);
}

const Composer = forwardRef<ComposerHandle, {
  composer: GenerateData['composer'];
  value: string;
  onChange: (v: string) => void;
  onSubmit: (opts: ComposerSubmitOpts) => void;
  sessionId?: string | null;
  sessionAssets: SessionAsset[];
  onAssetUploaded?: (asset: SessionAsset) => void;
  onStop?: () => void;
  disabled?: boolean;
}>(function Composer({ composer, value, onChange,  onSubmit,
  sessionId,
  sessionAssets, onAssetUploaded, onStop, disabled }, ref) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [ratio, setRatio] = useState(composer.preferences.ratios[0] ?? '智能');
  const sizeCfg = composer.preferences.sizes ?? { min: 0.5, max: 10, step: 0.5, default: 1 };
  const [size, setSize] = useState(sizeCfg.default);
  /** @ 提及弹窗：query 为 @ 后已输入的内容，index 为当前选中项 */
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);
  const [previewAsset, setPreviewAsset] = useState<SessionAsset | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadedAssetsRef = useRef<SessionAsset[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    uploadedAssetsRef.current = [];
    setUploadError(null);
  }, [sessionId]);

  const canSend = value.trim().length > 0 && !disabled;

  const clampSize = (v: number) => Math.min(sizeCfg.max, Math.max(sizeCfg.min, v));
  // 当前比例+尺寸对应的像素预览（智能比例 → null）
  const preview = computeResolution(ratio, size);
  // 「智能」是传给服务端的原始值，仅展示时翻译；计算仍用原始值
  const ratioLabel = (r: string) => (r === '智能' ? t('composer.ratioSmart') : r);

  const fetchAssetDataUrl = async (asset: SessionAsset): Promise<string | null> => {
    if (asset.url.startsWith('data:')) return asset.url;
    try {
      const response = await fetch(asset.url);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });

  const uploadImages = async (files: File[]) => {
    if (disabled || files.length === 0) return;
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    setUploadError(null);
    for (const file of imageFiles) {
      try {
        const allAssets = [...sessionAssets, ...uploadedAssetsRef.current];
        const name = nextSessionAssetName('image', allAssets);
        const uploaded = await uploadImageAsset(await fileToDataUrl(file), name);
        const asset: SessionAsset = { ...uploaded, name };
        uploadedAssetsRef.current = [...uploadedAssetsRef.current, asset];
        onAssetUploaded?.(asset);
        const textarea = taRef.current;
        if (textarea) {
          const caret = textarea.selectionStart ?? value.length;
          const inserted = insertAssetMention(textarea.value, caret, name);
          onChange(inserted.text);
          requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(inserted.caret, inserted.caret);
          });
        } else {
          const inserted = insertAssetMention(value, value.length, name);
          onChange(inserted.text);
        }
      } catch {
        setUploadError(t('composer.uploadFailed'));
      }
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    const itemFiles = files.length > 0
      ? files
      : Array.from(event.clipboardData.items)
          .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
          .map(item => item.getAsFile())
          .filter((file): file is File => file !== null);
    if (itemFiles.length === 0) return;
    event.preventDefault();
    void uploadImages(itemFiles);
  };

  const submit = async () => {
    if (!canSend) return;
    const mentioned = findMentionedSessionAssets(value, sessionAssets);
    const uploaded = await Promise.all(mentioned.map(async asset => ({
      asset,
      dataUrl: await fetchAssetDataUrl(asset),
    })));
    onSubmit({
      images: uploaded
        .filter(item => item.asset.kind === 'image' && item.dataUrl)
        .map(item => ({ name: item.asset.name, dataUrl: item.dataUrl! })),
      videos: uploaded
        .filter(item => item.asset.kind === 'video' && item.dataUrl)
        .map(item => ({ name: item.asset.name, dataUrl: item.dataUrl! })),
      assets: [...uploadedAssetsRef.current],
      ratio,
      size,
    });
    uploadedAssetsRef.current = [];
  };

  const toggle = (p: Exclude<PanelId, null>) => {
    setOpenPanel(openPanel === p ? null : p);
  };

  const filteredAssets = mention
    ? sessionAssets.filter(asset => asset.name.toLowerCase().includes(mention.query.toLowerCase()))
    : [];

  // 输入变化时检测光标前的 @，打开/更新提及弹窗
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    onChange(text);
    const pos = e.target.selectionStart ?? text.length;
    const match = /@([^\s@]*)$/.exec(text.slice(0, pos));
    if (match && sessionAssets.length > 0) {
      const query = match[1] ?? '';
      if (sessionAssets.some(asset => asset.name.toLowerCase().includes(query.toLowerCase()))) {
        setMention({ query, index: 0 });
        return;
      }
    }
    setMention(null);
  };

  // 把选中的 @素材名 插入文本（替换已输入的 @ 前缀与部分内容）
  const insertMention = (index: number) => {
    const ta = taRef.current;
    const item = filteredAssets[index];
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
    const mentionText = item.name;
    const insertAt = pos - partial.length - 1; // '@' 所在位置
    // 引用作为一个不可拆分的行内 token：后面补普通空格，让光标落在代码块外。
    const suffix = text.slice(pos);
    const separator = suffix.length === 0 || !/^\s/.test(suffix) ? ' ' : '';
    const next = text.slice(0, insertAt) + '@' + mentionText + separator + suffix;
    onChange(next);
    setMention(null);
    requestAnimationFrame(() => {
      ta.focus();
      const newPos = insertAt + 1 + mentionText.length + separator.length;
      ta.setSelectionRange(newPos, newPos);
    });
  };

  return (
    <div className="composer">
      {openPanel && <div className="composer-mask" onClick={() => setOpenPanel(null)} />}

      <div className="composer-input-wrap">
        {mention && filteredAssets.length > 0 && (
          <div className="mention-popup">
            {filteredAssets.map((asset, i) => (
              <button
                key={`${asset.kind}:${asset.url}`}
                type="button"
                className={`mention-item${i === mention.index ? ' active' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertMention(i)}
              >
                {asset.kind === 'image' ? (
                  <img src={asset.url} alt={asset.name} />
                ) : (
                  <video src={asset.url} muted playsInline preload="metadata" />
                )}
                <span className="mention-name">{asset.name}</span>
                <span className="mention-tag">{asset.kind === 'image' ? t('composer.mentionImage') : t('composer.mentionVideo')}</span>
              </button>
            ))}
          </div>
        )}
        {uploadError && <div className="composer-drop-error">{uploadError}</div>}
        <div
          className={`composer-rich-input${draggingImage ? ' is-dragging-image' : ''}`}
          onDragEnter={event => {
            if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) setDraggingImage(true);
          }}
          onDragOver={event => {
            if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) event.preventDefault();
          }}
          onDragLeave={event => {
            if (event.currentTarget === event.target) setDraggingImage(false);
          }}
          onDrop={event => {
            const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'));
            if (files.length === 0) return;
            event.preventDefault();
            setDraggingImage(false);
            void uploadImages(files);
          }}
        >
          <div
            ref={highlightRef}
            className="composer-input-highlight"
            aria-hidden="true"
          >
            <MentionText
              value={value}
              assets={sessionAssets}
              onOpen={setPreviewAsset}
              tokenClassName="composer-mention-token"
            />
          </div>
          <textarea
            ref={taRef}
            className="composer-input composer-input-editor"
          rows={2}
          placeholder={t('composer.placeholder')}
          value={value}
          onChange={onInputChange}
          onPaste={handlePaste}
          onScroll={event => {
            if (highlightRef.current) {
              highlightRef.current.scrollTop = event.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            window.setTimeout(() => setMention(null), 120);
          }}
          onKeyDown={e => {
            // 阻止光标进入已识别的 @素材 token，并让 Backspace/Delete 一次删除整个引用。
            const caret = e.currentTarget.selectionStart ?? 0;
            const selectionEnd = e.currentTarget.selectionEnd ?? caret;
            if (caret === selectionEnd) {
              const tokenPattern = /@(image\d+|video\d+)(?![\w])/gi;
              let tokenMatch: RegExpExecArray | null;
              while ((tokenMatch = tokenPattern.exec(value))) {
                const start = tokenMatch.index;
                const end = start + tokenMatch[0].length;
                if (e.key === 'ArrowLeft' && caret > start && caret <= end) {
                  e.preventDefault();
                  e.currentTarget.setSelectionRange(start, start);
                  return;
                }
                if (e.key === 'ArrowRight' && caret >= start && caret < end) {
                  e.preventDefault();
                  e.currentTarget.setSelectionRange(end, end);
                  return;
                }
                if (e.key === 'Backspace' && caret === end) {
                  e.preventDefault();
                  onChange(value.slice(0, start) + value.slice(end));
                  requestAnimationFrame(() => {
                    taRef.current?.focus();
                    taRef.current?.setSelectionRange(start, start);
                  });
                  return;
                }
                if (e.key === 'Delete' && caret === start) {
                  e.preventDefault();
                  onChange(value.slice(0, start) + value.slice(end));
                  requestAnimationFrame(() => {
                    taRef.current?.focus();
                    taRef.current?.setSelectionRange(start, start);
                  });
                  return;
                }
              }
            }
            if (mention) {
              const count = filteredAssets.length;
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
      </div>

      <div className="composer-bottom">
        <div className="composer-modes">
          {/* 生成比例 + 生成尺寸 */}
          <div className="composer-mode-wrap">
            <button
              className={`composer-mode${openPanel === 'preference' ? ' open' : ''}`}
              onClick={() => toggle('preference')}
              title={t('composer.ratioSizeTitle')}
            >
              {ratioLabel(ratio)} · {formatSize(size)}MP
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {openPanel === 'preference' && (
              <div className="composer-panel pref-panel">
                <div className="panel-title">{t('composer.ratio')}</div>
                <div className="pref-ratios">
                  {composer.preferences.ratios.map(r => (
                    <button
                      key={r}
                      className={`pref-ratio${ratio === r ? ' active' : ''}`}
                      onClick={() => setRatio(r)}
                    >
                      {ratioLabel(r)}
                    </button>
                  ))}
                </div>

                <div className="panel-title">{t('composer.size')}</div>
                <div className="pref-size">
                  <div className="pref-size-row">
                    <button
                      className="pref-size-btn"
                      onClick={() => setSize(prev => clampSize(Math.round((prev - sizeCfg.step) / sizeCfg.step) * sizeCfg.step))}
                      aria-label={t('composer.decreaseSize')}
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
                      aria-label={t('composer.increaseSize')}
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
                          <span className="pref-size-preview-hint">{t('composer.cappedHint')}</span>
                        )}
                      </>
                    ) : (
                      <span className="pref-size-preview-hint">{t('composer.smartRatioHint')}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        <div className="composer-actions">
          {disabled ? (
            <button
              className="composer-stop"
              onClick={onStop}
              title={t('composer.stopTitle')}
              aria-label={t('composer.stopTitle')}
            >
              <span className="composer-stop-icon" />
              {t('composer.stop')}
            </button>
          ) : (
            <button
              className={`composer-send${canSend ? ' enabled' : ''}`}
              disabled={!canSend}
              onClick={submit}
              title={t('common.send')}
              aria-label={t('common.send')}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2.5v11m0 0 4.5-4.5M10 13.5 5.5 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {previewAsset && createPortal(
        previewAsset.kind === 'image' ? (
          <ImageLightbox
            image={{ url: previewAsset.url, alt: previewAsset.name, generation: previewAsset.generation }}
            onClose={() => setPreviewAsset(null)}
          />
        ) : (
          <VideoLightbox
            src={previewAsset.url}
            name={previewAsset.name}
            generation={previewAsset.generation}
            onClose={() => setPreviewAsset(null)}
          />
        ),
        document.body,
      )}
    </div>
  );
});

export default Composer;
