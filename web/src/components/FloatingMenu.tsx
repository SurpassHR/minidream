import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** 触发下拉的根元素（用于判断点击是否在控件内部） */
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  className?: string;
  role?: string;
  ariaMultiselectable?: boolean;
  children: React.ReactNode;
}

interface MenuRect {
  left: number;
  top: number;
  width: number;
  openUp: boolean;
}

/**
 * 将下拉菜单渲染到 document.body（fixed 定位），避免被画布/节点的
 * overflow:hidden 裁剪，并确保覆盖在其后绘制的节点之上。
 * 打开时按触发按钮的屏幕位置定位；下方放不下且上方有空间时向上翻转。
 *
 * 定位/翻转放在同一个幂等 layout effect 里，只用 ref 记录高度与翻转状态，
 * 不通过 setState 回写高度，避免 layout effect 循环触发。
 */
export default function FloatingMenu({ triggerRef, open, onClose, className, role, ariaMultiselectable, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);
  const heightRef = useRef(0);
  const [rect, setRect] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      placedRef.current = false;
      heightRef.current = 0;
      return;
    }
    const el = triggerRef.current?.querySelector<HTMLElement>('.filter-select-trigger') ?? triggerRef.current;
    const bounds = el?.getBoundingClientRect();
    if (!bounds) return;
    // 第一次：向下定位；后续进入测量/翻转分支
    if (!placedRef.current) {
      setRect({ left: bounds.left, top: bounds.bottom + 4, width: bounds.width, openUp: false });
      placedRef.current = true;
      return;
    }
    if (!menuRef.current || !rect || rect.openUp) return;
    const height = menuRef.current.offsetHeight;
    heightRef.current = height;
    if (rect.top + height > window.innerHeight && rect.top - height - 8 > 0) {
      setRect({ ...rect, openUp: true });
    }
  }, [open, triggerRef, rect]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !rect) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      role={role}
      aria-multiselectable={ariaMultiselectable}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.openUp ? Math.max(4, rect.top - heightRef.current - 8) : rect.top,
        width: rect.width,
        zIndex: 1000,
      }}
      /* 下拉已 portal 到 body，但 React 合成事件仍沿组件树冒泡到画布，滚轮会误触缩放；在此拦截，选项列表自身滚动不受影响 */
      onWheel={event => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
