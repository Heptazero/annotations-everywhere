export interface PickerViewport { left: number; top: number; width: number; height: number }

/** Fixed-position coordinates in the visible viewport, including a mobile keyboard. */
export function referencePickerPlacement(at: { x: number; y: number }, size: { width: number; height: number }, viewport: PickerViewport): { left: number; top: number; maxWidth: number; maxHeight: number } {
	const gap = Math.min(8, viewport.width / 4, viewport.height / 4);
	const maxWidth = Math.max(0, viewport.width - gap * 2);
	const maxHeight = Math.max(0, viewport.height - gap * 2);
	const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
	return {
		left: Math.max(viewport.left + gap, Math.min(at.x, viewport.left + viewport.width - gap - width)),
		top: Math.max(viewport.top + gap, Math.min(at.y + 6, viewport.top + viewport.height - gap - height)),
		maxWidth, maxHeight,
	};
}

/** -1 is the search field. Up from search opens the last result, not the first. */
export function referencePickerNextIndex(key: string, index: number, count: number): number | null {
	if (!count) return null;
	if (key === "ArrowDown") return Math.min(index + 1, count - 1);
	if (key === "ArrowUp") return index < 0 ? count - 1 : Math.max(index - 1, 0);
	if (index >= 0 && key === "Home") return 0;
	if (index >= 0 && key === "End") return count - 1;
	return null;
}
