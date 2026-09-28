export interface MarkPointerStart {
	x: number;
	y: number;
	button: number;
}

/** Keep a click on a mark distinct from selecting even a very short PDF word. */
export function isMarkClick(
	start: MarkPointerStart | null,
	end: { x: number; y: number },
	selectedText: string
): boolean {
	return !!start && start.button === 0 && !selectedText.trim() && Math.hypot(end.x - start.x, end.y - start.y) <= 5;
}
