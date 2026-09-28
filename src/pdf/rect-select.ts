// Mirrored from everything-bilink/src/rect-select.ts — drag-to-draw-a-box fallback
// for when there's no active text selection to anchor an annotation to.

import { Notice } from "obsidian";
import type { PDFPageView } from "./pdfjs-types";
import { getOverlayLayer, screenToPdfPoint, type PdfRect } from "./pdf-layer";

/** Shared one-shot arm/disarm state for the "draw a rectangle" tool. */
export interface RectSelectController {
	armed: boolean;
}

/**
 * Attaches a one-shot drag-to-draw-a-box listener to `pageView`. Only reacts while
 * `controller.armed` is true; disarms itself after one completed (or cancelled) drag.
 * Returns a detach function.
 */
export function attachRectSelectListener(
	pageView: PDFPageView,
	controller: RectSelectController,
	onComplete: (rect: PdfRect) => void
): () => void {
	const onPointerDown = (ev: PointerEvent) => {
		if (!controller.armed) return;
		if (ev.button !== 0) return;
		ev.preventDefault();
		ev.stopPropagation();

		const layer = getOverlayLayer(pageView);
		const pageBox = pageView.div.getBoundingClientRect();
		const box = layer.createDiv("margin-notes-pdf-drawing-box");

		const startX = ev.clientX;
		const startY = ev.clientY;

		const updateBox = (x: number, y: number) => {
			box.setCssStyles({
				position: "absolute",
				left: `${Math.min(startX, x) - pageBox.left}px`,
				top: `${Math.min(startY, y) - pageBox.top}px`,
				width: `${Math.abs(x - startX)}px`,
				height: `${Math.abs(y - startY)}px`,
			});
		};
		updateBox(startX, startY);

		const onMove = (mv: PointerEvent) => updateBox(mv.clientX, mv.clientY);
		const onUp = (up: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			box.remove();
			controller.armed = false;

			const width = Math.abs(up.clientX - startX);
			const height = Math.abs(up.clientY - startY);
			if (width < 4 || height < 4) {
				new Notice("选区太小,已取消");
				return;
			}

			// Convert the opposite corners, then normalize: on a rotated PDF the
			// screen's bottom-left is not necessarily the PDF's bottom-left.
			const [ax, ay] = screenToPdfPoint(pageView, Math.min(startX, up.clientX), Math.max(startY, up.clientY));
			const [bx, by] = screenToPdfPoint(pageView, Math.max(startX, up.clientX), Math.min(startY, up.clientY));
			onComplete([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	};

	pageView.div.addEventListener("pointerdown", onPointerDown, true);
	return () => pageView.div.removeEventListener("pointerdown", onPointerDown, true);
}
