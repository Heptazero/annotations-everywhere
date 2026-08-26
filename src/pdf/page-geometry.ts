import type { PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";

/** Reference page used to make annotation chrome comparable across PDF media boxes. */
export const REFERENCE_PAGE_WIDTH_PT = 612;

/** Page geometry in scroll-container coordinates plus the normalized chrome scale. */
export interface PageBox {
	left: number;
	top: number;
	width: number;
	height: number;
	ptX0: number;
	ptX1: number;
	ptWidth: number;
	ptY0: number;
	ptY1: number;
	ptHeight: number;
	unit: number;
}

export function measurePageBox(pageView: PDFPageView, scroller: HTMLElement, scrollerRect: DOMRect): PageBox {
	const r = pageView.div.getBoundingClientRect();
	const [ptX0, ptY0, ptX1, ptY1] = pageView.pdfPage.view;
	return {
		left: r.left - scrollerRect.left + scroller.scrollLeft,
		top: r.top - scrollerRect.top + scroller.scrollTop,
		width: r.width,
		height: r.height,
		ptX0,
		ptX1,
		ptWidth: ptX1 - ptX0,
		ptY0,
		ptY1,
		ptHeight: ptY1 - ptY0,
		unit: r.width > 0 ? r.width / REFERENCE_PAGE_WIDTH_PT : 1,
	};
}

export function anchorTop(rect: PdfRect, offsetY: number | undefined, box: PageBox): number {
	const topPt = box.ptY1 - Math.max(rect[1], rect[3]);
	return box.top + (topPt / box.ptHeight) * box.height + (offsetY ?? 0) * box.unit;
}

export function defaultFreeXPct(rect: PdfRect, box: PageBox): number {
	const right = Math.max(rect[0], rect[2]);
	return ((right - box.ptX0) / box.ptWidth) * 100 + 3;
}

export function defaultFreeYPct(rect: PdfRect, box: PageBox): number {
	return ((box.ptY1 - Math.max(rect[1], rect[3])) / box.ptHeight) * 100;
}

/** Page-relative free-note x. Negative percentages deliberately remain negative. */
export function freeLeft(freeXPct: number | undefined, rect: PdfRect, box: PageBox): number {
	return box.left + ((freeXPct ?? defaultFreeXPct(rect, box)) / 100) * box.width;
}
