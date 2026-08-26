import type { PdfAnnotationSettings } from "./annotation-settings";
import { railGapPt, railWidthPt } from "./rail-layout";

export const OUTER_MARGIN_PX = 28;
const SHIFTED_VIEWER_CLASS = "margin-notes-pdf-viewer-shifted";
const GUTTER_PROPERTY = "--margin-notes-pdf-left-gutter";

export type LeftSpaceDemand =
	| { kind: "rail"; unit: number }
	| { kind: "free"; freeXPct: number; pageWidth: number };

/**
 * Space needed before the PDF page origin by every page-relative annotation.
 * A left rail uses a point width; a free note can explicitly carry a negative
 * page percentage. Both are the same problem once converted to screen px.
 */
export function requiredLeftGutter(settings: PdfAnnotationSettings, demands: readonly LeftSpaceDemand[]): number {
	let overflow = 0;
	for (const demand of demands) {
		if (demand.kind === "rail") {
			overflow = Math.max(
				overflow,
				Math.max(0, railWidthPt(settings, "left") + railGapPt(settings, "left")) * demand.unit
			);
		} else if (demand.freeXPct < 0) {
			overflow = Math.max(overflow, (-demand.freeXPct / 100) * demand.pageWidth);
		}
	}
	return overflow > 0 ? Math.ceil(overflow + OUTER_MARGIN_PX) : 0;
}

/**
 * Gives left-side annotations the same positive-coordinate canvas that right-
 * side annotations get naturally. The viewer root and annotation layer then
 * share one page-relative origin; no annotation is clamped to the viewport.
 */
export class LeftAnnotationSpace {
	private state = new WeakMap<
		HTMLElement,
		{ viewerRoot: HTMLElement; gutter: number; pendingScrollDelta: number }
	>();

	apply(scroller: HTMLElement, viewerRoot: HTMLElement | null, requestedPx: number): void {
		const next = requestedPx > 0 ? Math.ceil(requestedPx) : 0;
		let current = this.state.get(scroller);
		// Remove the pre-v0.45 padding implementation after a hot reload.
		scroller.style.paddingLeft = "";
		if (current && viewerRoot && current.viewerRoot !== viewerRoot) {
			this.restoreViewer(current.viewerRoot);
			this.state.delete(scroller);
			current = undefined;
		}
		if (!current) {
			if (!viewerRoot) return;
			this.state.set(scroller, { viewerRoot, gutter: next, pendingScrollDelta: 0 });
			this.shiftViewer(viewerRoot, next);
			return;
		}
		if (current.gutter === next) return;
		// When left content first appears, reveal the new canvas instead of
		// immediately scrolling it back out of view. Later zoom-driven changes do
		// compensate, keeping the PDF page stable while the annotation moves by its
		// genuine page-relative distance — symmetrical with a right-side note.
		if (current.gutter > 0 || next === 0) current.pendingScrollDelta += next - current.gutter;
		current.gutter = next;
		this.shiftViewer(current.viewerRoot, next);
	}

	/** Apply after layer width and page geometry have settled for this rebuild. */
	commit(scroller: HTMLElement): void {
		const current = this.state.get(scroller);
		if (!current || current.pendingScrollDelta === 0) return;
		const delta = current.pendingScrollDelta;
		current.pendingScrollDelta = 0;
		scroller.scrollLeft = Math.max(0, scroller.scrollLeft + delta);
	}

	clear(scroller: HTMLElement): void {
		const current = this.state.get(scroller);
		if (current) {
			this.restoreViewer(current.viewerRoot);
			scroller.scrollLeft = Math.max(0, scroller.scrollLeft - current.gutter);
		}
		this.state.delete(scroller);
		scroller.style.paddingLeft = "";
	}

	private shiftViewer(viewerRoot: HTMLElement, gutter: number): void {
		viewerRoot.style.setProperty(GUTTER_PROPERTY, `${gutter}px`);
		viewerRoot.classList.toggle(SHIFTED_VIEWER_CLASS, gutter > 0);
	}

	private restoreViewer(viewerRoot: HTMLElement): void {
		viewerRoot.classList.remove(SHIFTED_VIEWER_CLASS);
		viewerRoot.style.removeProperty(GUTTER_PROPERTY);
	}
}
