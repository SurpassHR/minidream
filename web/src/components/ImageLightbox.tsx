import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

export interface LightboxImage {
  url: string;
  alt: string;
  generation?: {
    taskId?: string;
    workflowId?: string;
    prompt?: string;
    params?: Record<string, unknown>;
    ratio?: string;
    size?: number;
    createdAt?: number;
  };
}

const MIN_ZOOM = 0.1; // 可缩小到「适配屏幕」尺寸的 10%
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.18;
/** 适配窗口时四周留白（px），避免图片贴边 */
const FIT_PADDING = 48;

/**
 * 图片灯箱：
 * - 打开时按窗口适配（contain）并居中，不再以原始尺寸铺满屏幕
 * - 滚轮/按钮缩放（可缩小到适配尺寸以下），缩放中心跟随光标/窗口中心
 * - 拖拽平移，双击恢复适配，关闭按钮 / Esc / 点击遮罩关闭
 */
export default function ImageLightbox({
  image,
  onClose,
}: {
  image: LightboxImage;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** 适配窗口的基础缩放（contain，≤1，小图不放大） */
  const [baseScale, setBaseScale] = useState(1);
  /** 相对基础缩放的倍率：1 = 恰好适配屏幕 */
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /** 原始分辨率（加载后读取，显示用） */
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(Boolean(image.generation));
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const dragMovedRef = useRef(false);

  // 打开新图时重置
  useEffect(() => {
    setBaseScale(1);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setNaturalSize(null);
    setInfoOpen(Boolean(image.generation));
    setCopied(false);
  }, [image.url, image.generation]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 图片加载后：contain 适配窗口并居中（大图缩到窗口内，小图保持原尺寸）
  const fitImage = useCallback(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    const scale = Math.min(
      (wrap.clientWidth - FIT_PADDING * 2) / img.naturalWidth,
      (wrap.clientHeight - FIT_PADDING * 2) / img.naturalHeight,
      1,
    );
    setBaseScale(scale);
    setZoom(1);
    setOffset({
      x: (wrap.clientWidth - img.naturalWidth * scale) / 2,
      y: (wrap.clientHeight - img.naturalHeight * scale) / 2,
    });
  }, []);

  // 按给定倍率围绕中心缩放（按钮用）
  const zoomBy = useCallback(
    (factor: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const cx = wrap.clientWidth / 2;
      const cy = wrap.clientHeight / 2;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      const k = next / zoom;
      setOffset(prev => ({
        x: cx - (cx - prev.x) * k,
        y: cy - (cy - prev.y) * k,
      }));
      setZoom(next);
    },
    [zoom],
  );

  // 滚轮缩放（以光标为中心）：wheel 需非 passive 监听才能 preventDefault
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const wrap = wrapRef.current;
      const img = imgRef.current;
      if (!wrap || !img) return;
      const rect = wrap.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      const k = next / zoom;
      // 保持光标下的图像点不动：offset' = cursor - k * (cursor - offset)
      setOffset(prev => ({
        x: cx - (cx - prev.x) * k,
        y: cy - (cy - prev.y) * k,
      }));
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom]);

  const onMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.lightbox-tools, .lightbox-close, .lightbox-info')) return;
    e.preventDefault();
    setDragging(true);
    dragMovedRef.current = false;
    dragStartRef.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const { mx, my, ox, oy } = dragStartRef.current;
    const dx = e.clientX - mx;
    const dy = e.clientY - my;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragMovedRef.current = true;
    setOffset({ x: ox + dx, y: oy + dy });
  };

  const endDrag = () => setDragging(false);

  // 拖拽结束后浏览器会补发 click，避免误关灯箱
  const formatValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const copyPrompt = async () => {
    const prompt = image.generation?.prompt;
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const handleBackdropClick = () => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false;
      return;
    }
    onClose();
  };

  return (
    <div
      ref={wrapRef}
      className={`lightbox${dragging ? ' dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.ariaLabel')}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={handleBackdropClick}
      onDoubleClick={e => {
        if ((e.target as HTMLElement).closest('.lightbox-tools, .lightbox-close, .lightbox-info')) return;
        fitImage();
      }}
    >
      <img
        ref={imgRef}
        className="lightbox-img"
        src={image.url}
        alt={image.alt}
        draggable={false}
        onLoad={fitImage}
        onClick={e => e.stopPropagation()}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${baseScale * zoom})`,
        }}
      />
      <div className="lightbox-tools">
        <button
          aria-label={t('lightbox.zoomOut')}
          title={t('lightbox.zoomOut')}
          onClick={e => {
            e.stopPropagation();
            zoomBy(1 / ZOOM_STEP);
          }}
        >
          −
        </button>
        <button
          aria-label={t('lightbox.zoomIn')}
          title={t('lightbox.zoomIn')}
          onClick={e => {
            e.stopPropagation();
            zoomBy(ZOOM_STEP);
          }}
        >
          +
        </button>
        <button
          aria-label={t('lightbox.fit')}
          title={t('lightbox.fit')}
          onClick={e => {
            e.stopPropagation();
            fitImage();
          }}
        >
          ⤢
        </button>
        <span className="lightbox-zoom">{Math.round(zoom * 100)}%</span>
        {naturalSize && (
          <span className="lightbox-size">{naturalSize.w} × {naturalSize.h} px</span>
        )}
        {image.generation && (
          <button
            aria-label={t('lightbox.infoToggle')}
            title={t('lightbox.infoToggle')}
            className={`lightbox-info-toggle${infoOpen ? ' active' : ''}`}
            onClick={e => {
              e.stopPropagation();
              setInfoOpen(open => !open);
            }}
          >
            i
          </button>
        )}
      </div>
      {infoOpen && image.generation && (
        <aside className="lightbox-info" onClick={e => e.stopPropagation()}>
          <div className="lightbox-info-head">
            <strong>{t('lightbox.infoTitle')}</strong>
            <button
              className="lightbox-info-close"
              aria-label={t('lightbox.infoClose')}
              title={t('lightbox.infoClose')}
              onClick={() => setInfoOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="lightbox-info-section">
            <div className="lightbox-info-label">{t('lightbox.prompt')}</div>
            <pre className="lightbox-prompt"><code>{image.generation.prompt || t('lightbox.notRecorded')}</code></pre>
            {image.generation.prompt && (
              <button className="lightbox-copy" onClick={() => void copyPrompt()}>
                {copied ? t('lightbox.copied') : t('lightbox.copyPrompt')}
              </button>
            )}
          </div>
          <dl className="lightbox-info-list">
            {image.generation.workflowId && (
              <div><dt>{t('lightbox.workflow')}</dt><dd>{image.generation.workflowId}</dd></div>
            )}
            {naturalSize && (
              <div><dt>{t('lightbox.resolution')}</dt><dd>{naturalSize.w} × {naturalSize.h} px</dd></div>
            )}
            {image.generation.ratio && (
              <div><dt>{t('lightbox.ratio')}</dt><dd>{image.generation.ratio}</dd></div>
            )}
            {image.generation.size !== undefined && (
              <div><dt>{t('lightbox.size')}</dt><dd>{image.generation.size} MP</dd></div>
            )}
            {image.generation.createdAt && (
              <div><dt>{t('lightbox.createdAt')}</dt><dd>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(image.generation.createdAt)}</dd></div>
            )}
          </dl>
          {image.generation.params && Object.keys(image.generation.params).length > 0 && (
            <div className="lightbox-info-section">
              <div className="lightbox-info-label">{t('lightbox.params')}</div>
              <dl className="lightbox-params">
                {Object.entries(image.generation.params)
                  .filter(([, value]) => value !== undefined && value !== null)
                  .map(([key, value]) => (
                    <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>
                  ))}
              </dl>
            </div>
          )}
        </aside>
      )}
      <button
        className="lightbox-close"
        aria-label={t('lightbox.closeAria')}
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
      <div className="lightbox-hint">{t('lightbox.hint')}</div>
    </div>
  );
}
