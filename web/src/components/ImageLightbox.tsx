import { useCallback, useEffect, useRef, useState } from 'react';

export interface LightboxImage {
  url: string;
  alt: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.18;

/**
 * 全屏图片查看器：
 * - 滚轮缩放，缩放中心跟随光标（光标下的图像点保持不动）
 * - 拖拽平移，关闭按钮 / Esc / 点击遮罩关闭
 */
export default function ImageLightbox({
  image,
  onClose,
}: {
  image: LightboxImage;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const dragMovedRef = useRef(false);

  // 打开新图时重置
  useEffect(() => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }, [image.url]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 图片加载后按原始尺寸居中
  const centerImage = useCallback(() => {
    const wrap = wrapRef.current;
    const img = imgRef.current;
    if (!wrap || !img) return;
    setZoom(MIN_ZOOM);
    setOffset({
      x: (wrap.clientWidth - img.naturalWidth) / 2,
      y: (wrap.clientHeight - img.naturalHeight) / 2,
    });
  }, []);

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
      aria-label="图片大图预览"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={handleBackdropClick}
    >
      <img
        ref={imgRef}
        className="lightbox-img"
        src={image.url}
        alt={image.alt}
        draggable={false}
        onLoad={centerImage}
        onClick={e => e.stopPropagation()}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        }}
      />
      <button
        className="lightbox-close"
        aria-label="关闭大图"
        onClick={e => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
      <div className="lightbox-hint">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
    </div>
  );
}
