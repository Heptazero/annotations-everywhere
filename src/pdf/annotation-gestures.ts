import type { AnnotationBoxHandle } from "./annotation-box";
import type { PdfAnnotationSettings } from "./annotation-settings";
import type { PdfAnnotation } from "./annotation-types";
import type { PageBox } from "./page-geometry";
import { MIN_RAIL_WIDTH_PT, railGapPt, railLeft } from "./rail-layout";
import type { PDFPageView } from "./pdfjs-types";

const TAP_SLOP_PX = 4;
const DOT_LONG_PRESS_MS = 360;
const MIN_FREE_WIDTH_PT = 40;
const MIN_HEIGHT_PT = 20;

export interface AnnotationGestureOptions {
	getSettings: () => PdfAnnotationSettings;
	saveSettings: (patch: Partial<PdfAnnotationSettings>) => void;
	currentPageBox: (pageView: PDFPageView) => PageBox | null;
	mutate: (pdfPath: string, ann: PdfAnnotation, fn: (next: PdfAnnotation) => void) => void;
	refresh: () => void;
	refreshLeader: (annotationId: string) => void;
}

/** Pointer lifecycle for dots, note dragging and resize handles. */
export class AnnotationGestureController {
	constructor(private options: AnnotationGestureOptions) {}

	attachDotLongPress(
		dot: HTMLElement,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView,
		onGestureClaimed: () => void
	): void {
		dot.addEventListener("pointerdown", (ev) => {
			if (ev.button !== 0) return;
			ev.stopPropagation();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const startLeft = parseFloat(dot.style.left || "0");
			const startTop = parseFloat(dot.style.top || "0");
			let dragging = false;
			let cancelled = false;

			const stop = () => {
				window.clearTimeout(timer);
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				dot.removeClass("is-pressing");
				dot.removeClass("is-dragging");
			};
			const timer = window.setTimeout(() => {
				if (cancelled) return;
				dragging = true;
				dot.removeClass("is-pressing");
				dot.addClass("is-dragging");
				dot.setPointerCapture?.(ev.pointerId);
			}, DOT_LONG_PRESS_MS);
			dot.addClass("is-pressing");

			const onMove = (move: PointerEvent) => {
				const dx = move.clientX - startX;
				const dy = move.clientY - startY;
				if (!dragging) {
					if (Math.hypot(dx, dy) >= TAP_SLOP_PX) {
						cancelled = true;
						onGestureClaimed();
						stop();
					}
					return;
				}
				move.preventDefault();
				move.stopPropagation();
				dot.style.top = `${startTop + dy}px`;
				if (!ann.pinned) dot.style.left = `${startLeft + dx}px`;
			};
			const onUp = (up: PointerEvent) => {
				if (!dragging) {
					stop();
					return;
				}
				up.preventDefault();
				up.stopPropagation();
				const dx = up.clientX - startX;
				const dy = up.clientY - startY;
				const box = this.options.currentPageBox(pageView);
				onGestureClaimed();
				stop();
				if (Math.hypot(dx, dy) < TAP_SLOP_PX) return;
				this.options.mutate(pdfPath, ann, (next) => {
					if (next.pinned) next.offsetY = (next.offsetY ?? 0) + (box ? dy / box.unit : dy);
					else if (box) {
						next.freeX = ((startLeft + dx - box.left) / box.width) * 100;
						next.freeY = ((startTop + dy - box.top) / box.height) * 100;
					}
				});
			};
			const onCancel = () => stop();
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
			window.addEventListener("pointercancel", onCancel, { once: true });
		});
	}

	attachBox(
		handle: AnnotationBoxHandle,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView,
		onMenu: (at: { x: number; y: number }) => void
	): void {
		const grip = handle.toolbarEl.createDiv({ cls: "margin-notes-pdf-grip" });
		grip.setAttribute("aria-label", ann.pinned ? "拖动上下移动,点击打开菜单" : "拖动摆放,点击打开菜单");
		grip.addEventListener("pointerdown", (ev) => this.beginNoteDrag(ev, handle.el, pdfPath, ann, pageView, onMenu));
		if (ann.pinned) this.attachRailResize(handle, ann, pageView);
		else this.attachFreeResize(handle, pdfPath, ann, pageView);
	}

	private beginNoteDrag(
		ev: PointerEvent,
		el: HTMLElement,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView,
		onTap: (at: { x: number; y: number }) => void
	): void {
		ev.preventDefault();
		ev.stopPropagation();
		let moved = false;
		const startX = ev.clientX;
		const startY = ev.clientY;
		const startLeft = parseFloat(el.style.left || "0");
		const startTop = parseFloat(el.style.top || "0");
		const onMove = (move: PointerEvent) => {
			if (!moved && Math.hypot(move.clientX - startX, move.clientY - startY) < TAP_SLOP_PX) return;
			moved = true;
			el.addClass("is-dragging");
			el.style.top = `${startTop + move.clientY - startY}px`;
			if (!ann.pinned) el.style.left = `${startLeft + move.clientX - startX}px`;
			this.options.refreshLeader(ann.id);
		};
		const onUp = (up: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			el.removeClass("is-dragging");
			if (!moved) {
				onTap({ x: up.clientX, y: up.clientY });
				return;
			}
			const dx = up.clientX - startX;
			const dy = up.clientY - startY;
			const box = this.options.currentPageBox(pageView);
			this.options.mutate(pdfPath, ann, (next) => {
				if (next.pinned) next.offsetY = (next.offsetY ?? 0) + (box ? dy / box.unit : dy);
				else if (box) {
					next.freeX = ((startLeft + dx - box.left) / box.width) * 100;
					next.freeY = ((startTop + dy - box.top) / box.height) * 100;
				}
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	}

	private attachRailResize(handle: AnnotationBoxHandle, ann: PdfAnnotation, pageView: PDFPageView): void {
		const innerEdge = ann.side === "right" ? "left" : "right";
		const widthKey = ann.side === "right" ? "railWidthRight" : "railWidthLeft";
		const gapKey = ann.side === "right" ? "railGapRight" : "railGapLeft";
		const begin = (edge: "left" | "right") => (ev: PointerEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
			const box = this.options.currentPageBox(pageView);
			if (!box) return;
			const startX = ev.clientX;
			const startW = handle.el.offsetWidth;
			const startGap = railGapPt(this.options.getSettings(), ann.side);
			const isInner = edge === innerEdge;
			const sign = ann.side === "right" ? 1 : -1;
			handle.el.addClass("is-dragging");
			const solve = (x: number) => {
				const dx = ((x - startX) * sign) / box.unit;
				const width = Math.max(MIN_RAIL_WIDTH_PT, isInner ? startW - dx : startW + dx);
				const gap = isInner ? startGap + startW - width : startGap;
				return { width, gap };
			};
			const onMove = (move: PointerEvent) => {
				const { width, gap } = solve(move.clientX);
				handle.el.style.width = `${width}px`;
				handle.el.style.left = `${railLeft(ann.side, box, width * box.unit, gap * box.unit)}px`;
			};
			const onUp = (up: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const { width, gap } = solve(up.clientX);
				const widthPt = Math.round(width);
				const gapPt = Math.round(gap);
				const settings = this.options.getSettings();
				if (widthPt !== Math.round(settings[widthKey]) || gapPt !== Math.round(settings[gapKey])) {
					this.options.saveSettings({ [widthKey]: widthPt, [gapKey]: gapPt });
				} else this.options.refresh();
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		};
		for (const edge of ["left", "right"] as const) {
			const grip = handle.el.createDiv(`margin-notes-pdf-resize is-edge is-${edge}`);
			grip.setAttribute("aria-label", edge === innerEdge ? "拖动调整轨道离页面的距离" : "拖动调整轨道宽度");
			grip.addEventListener("pointerdown", begin(edge));
		}
	}

	private attachFreeResize(
		handle: AnnotationBoxHandle,
		pdfPath: string,
		ann: PdfAnnotation,
		pageView: PDFPageView
	): void {
		const begin = (edge: "left" | "right" | "corner") => (ev: PointerEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
			const startX = ev.clientX;
			const startY = ev.clientY;
			const startW = handle.el.offsetWidth;
			const startH = handle.el.offsetHeight;
			const startLeft = parseFloat(handle.el.style.left || "0");
			const unit = this.options.currentPageBox(pageView)?.unit ?? 1;
			const grabsLeft = edge === "left";
			handle.el.addClass("is-dragging");
			const widthAt = (x: number) =>
				Math.max(MIN_FREE_WIDTH_PT, startW + (grabsLeft ? startX - x : x - startX) / unit);
			const heightAt = (y: number) => Math.max(MIN_HEIGHT_PT, startH + (y - startY) / unit);
			const onMove = (move: PointerEvent) => {
				const width = widthAt(move.clientX);
				handle.el.style.width = `${width}px`;
				if (grabsLeft) handle.el.style.left = `${startLeft + (startW - width) * unit}px`;
				if (edge === "corner") handle.el.style.height = `${heightAt(move.clientY)}px`;
			};
			const onUp = (up: PointerEvent) => {
				window.removeEventListener("pointermove", onMove);
				handle.el.removeClass("is-dragging");
				const box = this.options.currentPageBox(pageView);
				if (!box) return;
				const width = widthAt(up.clientX);
				const newLeft = grabsLeft ? startLeft + (startW - width) * unit : startLeft;
				this.options.mutate(pdfPath, ann, (next) => {
					next.freeW = ((width * unit) / box.width) * 100;
					if (grabsLeft) next.freeX = ((newLeft - box.left) / box.width) * 100;
					if (edge === "corner") next.freeH = ((heightAt(up.clientY) * unit) / box.height) * 100;
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		};
		for (const edge of ["left", "right"] as const) {
			const grip = handle.el.createDiv(`margin-notes-pdf-resize is-edge is-${edge}`);
			grip.setAttribute("aria-label", "拖动调整宽度");
			grip.addEventListener("pointerdown", begin(edge));
		}
		const corner = handle.el.createDiv("margin-notes-pdf-resize is-corner");
		corner.setAttribute("aria-label", "拖动调整大小");
		corner.addEventListener("pointerdown", begin("corner"));
	}
}
