import type { Modifier } from '@dnd-kit/core';

export type DragBounds = { top: number; bottom: number };

/**
 * 把被拖拽的元素限制在 bounds（拖拽开始时测得的视口坐标）内，并锁定横向。
 *
 * 为什么需要：表格外层的 Card 为了横向滚动设了 overflow-x: auto，CSS 会把 overflow-y 也算成 auto，
 * 于是被拖的行一旦超出表格底部就会撑大这个滚动容器，dnd-kit 的自动滚动随之一直向下滚，越滚越长（无限下拉）。
 * 把行夹在列表范围内，就不会再撑大任何滚动区域。
 *
 * transform 已包含自动滚动带来的位移，且与拖拽开始时的 rect 同一坐标系，所以 bounds 必须在 onDragStart 时取一次，
 * 不能在拖拽过程中重新测量。
 */
export function lockXClampYToBounds(getBounds: () => DragBounds | null): Modifier {
  return ({ transform, draggingNodeRect }) => {
    const bounds = getBounds();
    if (!bounds || !draggingNodeRect) return { ...transform, x: 0 };
    const minY = bounds.top - draggingNodeRect.top;
    // 被拖元素比范围还高时（只有一行等情况）不动，避免 min > max。
    const maxY = Math.max(minY, bounds.bottom - draggingNodeRect.bottom);
    return { ...transform, x: 0, y: Math.min(Math.max(transform.y, minY), maxY) };
  };
}
