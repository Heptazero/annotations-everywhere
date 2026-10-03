import { loadMathJax, MarkdownRenderer, Menu, Notice, type App, type Component } from "obsidian";
import { resolveCollisions } from "../collision-avoidance";
import { buildAnnotationBox, type AnnotationBoxHandle } from "./annotation-box";
import { AnnotationGestureController } from "./annotation-gestures";
import { LeftAnnotationSpace, OUTER_MARGIN_PX, requiredLeftGutter, type LeftSpaceDemand } from "./annotation-space";
import { appendAnnotationLayerMenuItems } from "./annotation-layer-menus";
import { annotationVisibleInLayer } from "./annotation-layers";
import { darken, highlightsBothWays, resolveAnnotationColor, type PdfAnnotationSettings } from "./annotation-settings";
import { adaptiveLeaderEndpoints, leaderVisible } from "./leader-geometry";
import { isMarkClick, type MarkPointerStart } from "./mark-click";
import { openMarkPopover, type MarkPopoverHandle } from "./mark-popover";
import { openSwatchPicker } from "./swatch-picker";
import type { PdfAnnotationStore } from "./annotation-store";
import { DEFAULT_FREE_WIDTH_PCT, type MarginSide, type PdfAnnotation } from "./annotation-types";
import {
	anchorTop as pageAnchorTop,
	defaultFreeXPct,
	defaultFreeYPct,
	freeLeft,
	measurePageBox,
	pdfRectInPageBox,
	type PageBox,
} from "./page-geometry";
import type { PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { resolveQuoteAnchor } from "./quote-anchor";
import { railCollisionGapPx, railGapPt, railLeft, railWidthPt } from "./rail-layout";
import { findScrollAncestor } from "./scroll-container";
import { AnnotationZoomLifecycle } from "./zoom-lifecycle";

/** `[0,0,0,0]` marks a record whose anchor still needs to be looked up from `quote`. */
function isUnresolvedAnchor(anchor: PdfRect): boolean {
	return anchor[0] === 0 && anchor[1] === 0 && anchor[2] === 0 && anchor[3] === 0;
}

const LAYER_CLASS = "margin-notes-pdf-layer";
const REBUILD_DEBOUNCE_MS = 60;
/** How far OUTSIDE the highlight the pointer has to stray before it is worth
 * explaining that the arrow cannot leave it. Below this it reads as a slip. */
const REANCHOR_HINT_PX = 24;

interface Rail {
	id: string;
	top: number;
	height: number;
	el: HTMLElement;
	/** The page's chrome unit at push time, so the minimum gap between notes
	 * scales with it instead of staying a fixed px amount at every zoom. */
	unit: number;
}

/** A leader line plus the knob on its text end, kept so both can be repositioned
 * without a full rebuild while the note or the anchor is being dragged. */
interface LeaderParts {
	line: HTMLElement;
	knob: HTMLElement;
	noteEl: HTMLElement;
	pageView: PDFPageView;
	ann: PdfAnnotation;
	/** Anchor box in scroll-container px; mutated live during an anchor drag. */
	a: { x0: number; x1: number; y0: number; y1: number };
}

/** One rendered annotation, kept so geometry can be re-measured after rendering. */
interface AnchoredAnnotation {
	ann: PdfAnnotation;
	pageView: PDFPageView;
	/**
	 * The anchor actually used for placement. Usually `ann.anchor`, but for a
	 * record still waiting on a quote lookup it's a transient stand-in that is
	 * deliberately NOT written back to `ann` — see `effectiveAnchor()`.
	 */
	rect: PdfRect;
}

interface Placed extends AnchoredAnnotation {
	el: HTMLElement;
}

/**
 * Renders every annotation of one PDF view into a single layer that is a direct
 * child of the viewer's scroll container — the same trick as the CM6 footnote
 * sidenote layer: once it shares the scrolling element, absolutely-positioned
 * children scroll for free, so positions only need recomputing on page render,
 * zoom, or edit, never on scroll.
 *
 * Both display forms live here. Earlier there were two layers (a per-page
 * overlay for floating markers, this one for margin boxes); that split forced
 * free notes to be clipped by the page overlay's `overflow: hidden`, which is
 * exactly what prevented a note from sitting in the blank space beside a page.
 */
export class AnnotationLayer {
	private layer: HTMLDivElement | null = null;
	private scroller: HTMLElement | null = null;
	/** Bumped per rebuild so a superseded async render pass bails out. */
	private gen = 0;
	private last: { pdfPath: string; pages: Map<number, PDFPageView> } | null = null;
	private rebuildTimer = 0;
	private leftSpace = new LeftAnnotationSpace();
	private zoom: AnnotationZoomLifecycle;
	private gestures: AnnotationGestureController;
	/** Anchor rects in scroll coords, for `both` mode's reverse hover test. */
	private hitAreas: { ann: PdfAnnotation; el?: HTMLElement; x0: number; x1: number; y0: number; y1: number }[] = [];
	private hoveredAnchorId: string | null = null;
	/** Permanent bands ("常亮"), by annotation id — hover reuses these instead of
	 * drawing a second one on top (two translucent layers composite to roughly
	 * double the configured opacity, which is why 常亮 looked far darker than the
	 * hover highlight it is supposed to match). */
	private bands = new Map<string, HTMLElement[]>();
	/** Leader lines ("箭头"), by annotation id, so they can be redrawn live while
	 * either end is being dragged rather than waiting for the debounced rebuild. */
	private leaders = new Map<string, LeaderParts>();
	private markPopover: MarkPopoverHandle | null = null;
	private markPointerDown: MarkPointerStart | null = null;
	private markClickTimer = 0;
	private cancelPendingMarkClick = (): void => {
		window.clearTimeout(this.markClickTimer);
		this.markClickTimer = 0;
		document.removeEventListener("pointerdown", this.cancelPendingMarkClick, true);
	};

	constructor(
		private app: App,
		private component: Component,
		private store: PdfAnnotationStore,
		private getSettings: () => PdfAnnotationSettings,
		private getActiveLayerId: () => string | null,
		private saveSettings: (patch: Partial<PdfAnnotationSettings>) => void,
		/** Hands "re-pick this note's highlight" back to the controller, which owns
		 * the selection/box-drag machinery. */
		private requestReanchor: (pdfPath: string, ann: PdfAnnotation) => void
	) {
		this.zoom = new AnnotationZoomLifecycle(
			() => this.isBusy(),
			(hidden) => this.layer?.toggleClass("is-zooming", hidden),
			() => {
				if (!this.last) return false;
				this.rebuild(this.last.pdfPath, this.last.pages);
				return true;
			}
		);
		this.gestures = new AnnotationGestureController({
			getSettings: () => this.getSettings(),
			saveSettings: (patch) => this.saveSettings(patch),
			currentPageBox: (pageView) => this.currentPageBox(pageView),
			mutate: (pdfPath, ann, fn) => this.mutate(pdfPath, ann, fn),
			refresh: () => this.refresh(),
			refreshLeader: (annotationId) => this.refreshLeader(annotationId),
		});
	}

	private ensureLayer(anyPageDiv: HTMLElement): HTMLDivElement {
		const scroller = findScrollAncestor(anyPageDiv);
		if (this.layer?.isConnected && this.scroller === scroller) return this.layer;

		this.layer?.remove();
		// Hand the previous scroller back the padding we borrowed from it before
		// losing the reference, or the old viewer keeps a gutter for a rail that
		// is no longer there.
		if (this.scroller && this.scroller !== scroller) this.leftSpace.clear(this.scroller);
		// CM6's `.cm-scroller` gets `position: relative` from its own base theme;
		// nothing gives the PDF viewer's scroller that for free.
		if (getComputedStyle(scroller).position === "static") scroller.setCssStyles({ position: "relative" });

		this.scroller?.removeEventListener("mousemove", this.onScrollerMove);
		this.scroller?.removeEventListener("contextmenu", this.onScrollerContextMenu);
		this.scroller?.removeEventListener("pointerdown", this.onScrollerPointerDown, true);
		this.scroller?.removeEventListener("click", this.onScrollerClick, true);
		this.scroller?.removeEventListener("dblclick", this.onScrollerDoubleClick, true);
		this.scroller?.removeEventListener("scroll", this.onScrollerScroll);
		const layer = scroller.createDiv(LAYER_CLASS);
		layer.setCssStyles({ position: "absolute", top: "0", left: "0", pointerEvents: "none" });
		layer.toggleClass("is-zooming", this.zoom.active);
		this.layer = layer;
		this.scroller = scroller;
		scroller.addEventListener("mousemove", this.onScrollerMove);
		scroller.addEventListener("contextmenu", this.onScrollerContextMenu);
		scroller.addEventListener("pointerdown", this.onScrollerPointerDown, true);
		scroller.addEventListener("click", this.onScrollerClick, true);
		scroller.addEventListener("dblclick", this.onScrollerDoubleClick, true);
		scroller.addEventListener("scroll", this.onScrollerScroll);
		return layer;
	}

	/** True while a box is mid-edit — rebuilding would destroy the contentEditable. */
	private isBusy(): boolean {
		return !!this.layer?.querySelector(".is-editing, .is-dragging");
	}

	/**
	 * Hides annotations for pdf.js's transient zoom frames. The page elements may
	 * temporarily be CSS-scaled while this sibling layer still has coordinates
	 * measured from the previous frame, so displaying either geometry produces a
	 * visible drift. Once scale events have gone quiet, a forced rebuild measures
	 * the final page boxes; only that completed layout makes the layer visible.
	 */
	beginZoom(): void {
		window.clearTimeout(this.rebuildTimer);
		this.cancelPendingMarkClick();
		this.markPopover?.requestClose();
		this.zoom.begin();
	}

	/**
	 * Coalesced on purpose: a zoom makes pdf.js fire `pagerendered` once per
	 * visible page in a burst, and rebuilding on each of them measured pages that
	 * hadn't finished relaying out yet — which showed up as annotations drifting
	 * off their anchors after zooming.
	 */
	rebuild(pdfPath: string, pages: Map<number, PDFPageView>): void {
		if (this.last && this.last.pdfPath !== pdfPath) {
			this.cancelPendingMarkClick();
			if (this.markPopover?.isDirty()) new Notice("已切换 PDF，未保存的勾画批注已取消");
			this.markPopover?.close();
			this.hitAreas = [];
		}
		this.last = { pdfPath, pages };
		if (this.isBusy()) return;
		window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => void this.doRebuild(pdfPath, pages), REBUILD_DEBOUNCE_MS);
	}

	refresh(): void {
		if (this.last) this.rebuild(this.last.pdfPath, this.last.pages);
	}

	private async doRebuild(pdfPath: string, pages: Map<number, PDFPageView>): Promise<void> {
		// `rebuild()` only checks isBusy() at the moment it SCHEDULES this call —
		// if a drag/resize/edit starts during the debounce window (very possible:
		// e.g. onTextLayerReady firing from the scroll a drag itself causes), that
		// check is already stale by the time this actually runs. Re-check here:
		// otherwise this wipes the layer (`layer.empty()` below) mid-drag, and the
		// pointermove handler goes on updating an element that's no longer in the
		// document — this is what "resize stops responding after moving a little"
		// actually was: the element under the cursor got silently swapped out.
		if (this.isBusy()) return;
		const gen = ++this.gen;
		const settings = this.getSettings();

		const anyPage = [...pages.values()].find((p) => p.div?.isConnected && p.pdfPage?.view);
		if (!anyPage) {
			this.zoom.finishIfSettled();
			return;
		}

		const layer = this.ensureLayer(anyPage.div);
		layer.empty();
		this.hoverMark = null;
		this.hoverPreview = null;
		this.hoverPreviewId = null;
		this.hitAreas = [];
		this.hoveredAnchorId = null;
		this.bands.clear();
		this.leaders.clear();

		const built: Placed[] = [];
		const marks: AnchoredAnnotation[] = [];
		const pending: Promise<void>[] = [];

		// Pass 1: create the DOM and kick off Markdown rendering. No geometry is
		// committed here — see the re-measure below for why.
		for (const [pageNumber, pageView] of pages) {
			if (!pageView.pdfPage?.view || !pageView.div.isConnected) continue;
			for (const ann of this.store.forPage(pdfPath, pageNumber)) {
				if (!annotationVisibleInLayer(ann, this.getActiveLayerId())) continue;
				const rect = this.effectiveAnchor(pdfPath, ann, pageView);
				if (ann.markOnly) {
					marks.push({ ann, pageView, rect });
					continue;
				}
				if (ann.collapsed) {
					built.push({ ann, pageView, rect, el: this.createDot(layer, pdfPath, ann, pageView) });
					continue;
				}
				const handle = this.createBox(layer, pdfPath, ann, pageView);
				pending.push(handle.render());
				built.push({ ann, pageView, rect, el: handle.el });
			}
		}
		if (built.length === 0) {
			layer.setCssStyles({ width: "" });
			if (this.scroller) {
				this.leftSpace.apply(this.scroller, null, 0);
				this.renderModeDecorations([], settings, this.scroller, marks);
				this.leftSpace.commit(this.scroller);
			}
			this.zoom.finishIfSettled();
			return;
		}

		// Position boxes once with the geometry as it stands, so nothing flashes at
		// 0,0. Decorations deliberately wait: Markdown/MathJax can change a box's
		// height, and drawing a leader in both passes used to leave two DOM lines.
		this.layout(built, settings, false);

		// …then again after Markdown/MathJax resolves. Two reasons: box heights
		// aren't final until then (collision avoidance needs real heights), and
		// during a zoom the page rects measured a moment ago are already stale —
		// re-measuring here is what stops annotations drifting off their anchors
		// when the zoom level changes.
		await Promise.all(pending);
		// `gen` catches a NEWER rebuild superseding this one; `isBusy()` catches
		// the user starting to drag one of the boxes THIS pass just built, during
		// the render wait — the second `layout()` call below would otherwise still
		// go and reposition (fight) whatever they're mid-drag on.
		if (gen !== this.gen || this.isBusy()) return;
		this.layout(built, settings, true, marks);
		this.zoom.finishIfSettled();
	}

	/**
	 * Measures the current page geometry and (re)places every built element.
	 *
	 * A pinned note is NOT screen-fixed chrome — it's attached to the page like
	 * a free note, so it scales with zoom in every respect.
	 *
	 * How that scaling is done matters, and it changed in v0.11.0. Sizes used to
	 * be written as already-multiplied px (`width = railWidthPt * zoom`,
	 * `fontSize = fontSize * zoom`), which scaled exactly two properties and left
	 * every other piece of chrome at a fixed px size: the box's own padding, the
	 * toolbar icons, the border, and the ~34px of right padding reserved for the
	 * toolbar. Zoomed out, that fixed chrome ate essentially the whole box — a
	 * 220pt rail at 30% zoom is 66px wide, of which 48px was non-scaling padding,
	 * leaving ~18px of text column. Two or three characters per line, with
	 * automatic height, is what made rail notes grow absurdly tall when zooming
	 * out.
	 *
	 * So: lay the note out at its natural (unscaled, point-valued) size and apply
	 * `transform: scale(zoom)` to the whole element instead. Everything inside
	 * scales in one step and stays in proportion, and — because line-breaking is
	 * now computed at a zoom-independent width — a note's text wraps identically
	 * at every zoom level, so its height no longer changes at all.
	 */
	private layout(
		built: Placed[],
		settings: PdfAnnotationSettings,
		renderDecorations = true,
		marks: AnchoredAnnotation[] = []
	): void {
		const scroller = this.scroller;
		if (!scroller) return;

		// Reserve one shared left canvas before reading final page coordinates.
		// Both a pinned left rail and a free note with negative freeX contribute;
		// treating the latter as ordinary content is what avoids the old x=0 clamp.
		const samplePage = built.find((item) => item.pageView.div.isConnected && item.pageView.pdfPage?.view)?.pageView;
		const preliminaryRect = scroller.getBoundingClientRect();
		const preliminaryBoxes = new Map<PDFPageView, PageBox>();
		const demands: LeftSpaceDemand[] = [];
		for (const item of built) {
			if (!item.pageView.div.isConnected || !item.pageView.pdfPage?.view) continue;
			let box = preliminaryBoxes.get(item.pageView);
			if (!box) {
				box = measurePageBox(item.pageView, scroller, preliminaryRect);
				preliminaryBoxes.set(item.pageView, box);
			}
			if (item.ann.pinned && item.ann.side === "left") demands.push({ kind: "rail", unit: box.unit });
			else if (!item.ann.pinned) {
				const freeXPct = item.ann.freeX ?? defaultFreeXPct(item.rect, box);
				if (freeXPct < 0) demands.push({ kind: "free", freeXPct, pageWidth: box.width });
			}
		}
		this.leftSpace.apply(
			scroller,
			samplePage?.div.parentElement ?? null,
			requiredLeftGutter(settings, demands)
		);

		const scrollerRect = scroller.getBoundingClientRect();
		const boxes = new Map<PDFPageView, PageBox>();
		const rails: Record<MarginSide, Rail[]> = { left: [], right: [] };
		let maxRight = 0;

		for (const item of built) {
			if (!item.pageView.div.isConnected) continue;
			let box = boxes.get(item.pageView);
			if (!box) {
				box = measurePageBox(item.pageView, scroller, scrollerRect);
				boxes.set(item.pageView, box);
			}
			const { ann, el, rect } = item;

			if (ann.pinned) {
				const widthPt = railWidthPt(settings, ann.side);
				const left = railLeft(ann.side, box, widthPt * box.unit, railGapPt(settings, ann.side) * box.unit);
				el.style.left = `${left}px`;
				if (!ann.collapsed) {
					this.scaleBox(el, widthPt, undefined, settings, ann, box);
					maxRight = Math.max(maxRight, left + widthPt * box.unit);
				} else {
					maxRight = Math.max(maxRight, left + settings.dotSize);
				}
				rails[ann.side].push({ id: ann.id, top: pageAnchorTop(rect, ann.offsetY, box), height: 0, el, unit: box.unit });
			} else if (ann.collapsed) {
				const left = freeLeft(ann.freeX, rect, box);
				el.style.left = `${left}px`;
				el.style.top = `${box.top + ((ann.freeY ?? defaultFreeYPct(rect, box)) / 100) * box.height}px`;
				maxRight = Math.max(maxRight, left + settings.dotSize);
			} else {
				maxRight = Math.max(maxRight, this.placeFree(el, rect, ann, box, settings));
			}
		}

		for (const side of ["left", "right"] as const) {
			const group = rails[side];
			// offsetHeight is the element's UNSCALED layout height (transforms don't
			// affect it), so it has to be multiplied back up to compare against the
			// scroll-container coordinates the tops are in.
			for (const r of group) {
				// Expanded boxes scale with the PDF; collapsed dots deliberately stay
				// screen-sized, so their collision footprint must not be scaled again.
				r.height = r.el.hasClass("margin-notes-pdf-dot") ? r.el.offsetHeight : r.el.offsetHeight * r.unit;
			}
			// MIN_GAP is a page-point constant like everything else here — a fixed
			// px value would look cramped zoomed in and oversized zoomed out. All
			// notes in one rail share the document's zoom in practice, so the
			// first entry's is representative.
			const gapPx = railCollisionGapPx(group[0]?.unit ?? 1);
			for (const r of resolveCollisions(group, gapPx)) r.el.style.top = `${r.top}px`;
		}

		// Give the layer a real width so the scroll container can actually reach
		// the notes sitting past the page's right edge, with a margin of blank
		// space beyond the outermost one — otherwise the rightmost note ends up
		// flush against (and fighting with) the viewer's own scrollbar.
		//
		// Measured from the DOM, not from the `maxRight` accumulated above: that
		// running total is what each branch *intended* to place, and a single
		// branch getting it wrong silently truncates the scrollable area, which
		// strands every note past the cut-off with no way to scroll to them. A
		// post-transform getBoundingClientRect cannot disagree with what is on
		// screen, so the reachable area is defined by the genuinely outermost
		// note — whichever kind it happens to be — rather than by the rail.
		// After positioning: leader lines need the notes' final boxes, and the
		// `always` bands must not be counted in the width above (they sit over the
		// page, never past it).
		if (renderDecorations) this.renderModeDecorations(built, settings, scroller, marks);

		const right = Math.max(maxRight, this.measuredRight(built, scroller));
		this.layer!.style.width = right > 0 ? `${right + OUTER_MARGIN_PX}px` : "";
		if (renderDecorations) this.leftSpace.commit(scroller);
	}

	/** Rightmost rendered edge of any placed note, in scroll-container px. */
	private measuredRight(built: Placed[], scroller: HTMLElement): number {
		const scrollerRect = scroller.getBoundingClientRect();
		let right = 0;
		for (const item of built) {
			if (!item.el.isConnected) continue;
			const r = item.el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) continue;
			right = Math.max(right, r.right - scrollerRect.left + scroller.scrollLeft);
		}
		return right;
	}

	/**
	 * Rail x, in scroll-container px.
	 *
	 * Purely page-relative — deliberately NOT clamped to the viewport. An earlier
	 * version clamped against `scrollLeft + clientWidth` to keep the rail always
	 * on screen, which broke three things at once: the rail drifted on zoom
	 * (its position depended on scroll state, unlike free notes, which is exactly
	 * why only the rail drifted); it could never sit out in the blank area past
	 * the page; and it fed back on itself — a wider rail extends the scrollable
	 * width, which moves `scrollLeft + clientWidth` further right, which moves
	 * the rail further right, dragging the viewport along with it.
	 *
	 * The only clamp left is at the content origin: a left rail may not go
	 * negative, since nothing can scroll left of 0 and it would be unreachable.
	 */
	/**
	 * Sizes a note in unscaled point units and hands the zoom to a transform.
	 * `widthPt`/`heightPt` are the note's natural size; the element is then
	 * scaled as one piece from its top-left, which is the corner its `left`/`top`
	 * are measured from. See layout()'s comment for why this beats multiplying
	 * individual properties by zoom.
	 */
	private scaleBox(
		el: HTMLElement,
		widthPt: number,
		heightPt: number | undefined,
		settings: PdfAnnotationSettings,
		ann: PdfAnnotation,
		box: PageBox
	): void {
		el.setCssStyles({
			width: `${widthPt}px`,
			height: heightPt ? `${heightPt}px` : "",
			fontSize: `${settings.fontSize * (ann.fontScale ?? 1)}px`,
			transformOrigin: "top left",
			transform: `scale(${box.unit})`,
		});
		// The whole box is scaled, which is right for text and spacing but wrong
		// for the hairlines: a 1px rule multiplied by the zoom stops being a
		// hairline and turns into a heavy slab (a 2px spine at 3x reads as 6px).
		// Rules are device-pixel furniture, not content, so styles.css divides
		// them by this to cancel the transform out and keep them ~1px on screen
		// at every zoom level.
		el.setCssProps({ "--margin-notes-pdf-inv": String(box.unit > 0 ? 1 / box.unit : 1) });
	}

	/**
	 * Free-placement X, defaulting to just right of the anchor. Used to default
	 * to "just past the page's right edge" — a fixed 102%, ignoring where the
	 * selection actually was — which could easily land outside the visible
	 * viewport on a page with little to no gutter. Anchoring the default to the
	 * selection itself instead means a brand-new note always spawns next to
	 * what it's about; since this is only the DEFAULT (an explicit `freeX` from
	 * a drag always wins), it's recomputed fresh from the anchor on every
	 * render rather than stored, so it can never end up stale either.
	 */
	/** Returns the note's right edge in scroll-container px, for the layer width. */
	private placeFree(
		el: HTMLElement,
		rect: PdfRect,
		ann: PdfAnnotation,
		box: PageBox,
		settings: PdfAnnotationSettings
	): number {
		const left = freeLeft(ann.freeX, rect, box);
		el.style.left = `${left}px`;
		el.style.top = `${box.top + ((ann.freeY ?? defaultFreeYPct(rect, box)) / 100) * box.height}px`;
		// freeW/freeH are page-percentages; convert to the note's own unscaled
		// units by dividing out the zoom the transform is about to re-apply.
		const widthPx = ((ann.freeW ?? DEFAULT_FREE_WIDTH_PCT) / 100) * box.width;
		const heightPx = ann.freeH ? (ann.freeH / 100) * box.height : undefined;
		this.scaleBox(el, widthPx / box.unit, heightPx ? heightPx / box.unit : undefined, settings, ann, box);
		return left + widthPx;
	}

	private createDot(layer: HTMLElement, pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): HTMLElement {
		const dot = layer.createDiv("margin-notes-pdf-dot");
		dot.dataset.annotationId = ann.id;
		dot.dataset.mode = ann.pinned ? "rail" : "free";
		dot.dataset.side = ann.side;
		dot.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		dot.style.setProperty("--margin-notes-pdf-dot-size", `${this.getSettings().dotSize}px`);
		dot.setAttribute("aria-label", "批注点：点击展开，长按后拖动");

		let suppressClickUntil = 0;
		dot.addEventListener("click", (e) => {
			e.stopPropagation();
			if (Date.now() < suppressClickUntil) {
				e.preventDefault();
				return;
			}
			this.mutate(pdfPath, ann, (a) => (a.collapsed = false));
		});
		dot.addEventListener("contextmenu", (e) => {
			if (dot.hasClass("is-dragging")) {
				e.preventDefault();
				return;
			}
			this.showMenu(e, pdfPath, ann);
		});
		this.gestures.attachDotLongPress(dot, pdfPath, ann, pageView, () => {
			suppressClickUntil = Date.now() + 500;
		});
		return dot;
	}

	/**
	 * A record with no real `anchor` (an AI-authored one, typically — see
	 * quote-anchor.ts) gets resolved here, the first time its page is on
	 * screen: search the text layer for `quote`, write the real rect back so
	 * every later render is instant and ordinary.
	 *
	 * A failed match (page's text layer not ready yet, or the quote genuinely
	 * isn't found — a paraphrase rather than a verbatim copy, say) falls back to
	 * a fixed spot near the top of the page instead of being invisible. That
	 * fallback is NOT written to disk, but it does overwrite `ann.anchor` on the
	 * live object the store holds — since `isUnresolvedAnchor` is what this
	 * function gates on, that means a fallback used once stops future retries
	 * for the rest of the session. In practice this is fine for the case that
	 * matters (a quote that truly doesn't match will never resolve however many
	 * times it's retried) and only a narrow race for "text layer wasn't ready
	 * yet" (self-resolves within the ~60ms rebuild debounce almost always) — but
	 * it's a real edge, not a guarantee, and worth knowing if a note ever seems
	 * stuck at the top of a page it shouldn't be on.
	 */
	private effectiveAnchor(pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): PdfRect {
		if (!isUnresolvedAnchor(ann.anchor)) return ann.anchor;

		if (ann.quote) {
			const resolved = resolveQuoteAnchor(pageView, ann.quote);
			if (resolved) {
				ann.anchor = resolved;
				ann.updatedAt = Date.now();
				// Not a user edit — keep it out of the undo history.
				this.store.upsert(pdfPath, ann, false);
				return resolved;
			}
		}
		// Failed: return a placeholder spot WITHOUT touching ann.anchor, so the
		// record stays "unresolved" and gets retried on every later rebuild.
		//
		// This used to assign the placeholder to `ann.anchor` directly. That
		// latched permanently — `isUnresolvedAnchor` then said false forever — and
		// any later upsert (a drag, an edit) persisted the placeholder to disk.
		// Which is exactly what happened to the AI-written notes on the
		// original/translation pair: their quotes are in the TRANSLATION's
		// language, so opening the ORIGINAL first failed every lookup and froze
		// six of eight notes at `[20, 732, 220, 772]`. Retrying instead means the
		// lookup succeeds the moment the matching-language side is opened, and —
		// since the translation preserves the layout — the rect it writes back is
		// correct for both members of the pair.
		if (pageView.pdfPage?.view) {
			const [x0, , , y1] = pageView.pdfPage.view;
			return [x0 + 20, y1 - 60, x0 + 220, y1 - 20];
		}
		return ann.anchor;
	}

	private mutate(pdfPath: string, ann: PdfAnnotation, fn: (a: PdfAnnotation) => void): void {
		fn(ann);
		ann.updatedAt = Date.now();
		this.store.upsert(pdfPath, ann);
		this.refresh();
	}

	private createBox(layer: HTMLElement, pdfPath: string, ann: PdfAnnotation, pageView: PDFPageView): AnnotationBoxHandle {
		const handle = buildAnnotationBox(layer, "margin-notes-pdf-note", {
			app: this.app,
			component: this.component,
			sourcePath: pdfPath,
			initialText: ann.text,
			onCommit: (text) => this.mutate(pdfPath, ann, (a) => (a.text = text)),
			// No icon row: the note carries ONE grip, installed by the gesture controller, which is
			// both the drag handle and the menu trigger. A row of icons needs a
			// solid backplate to stay legible over text, and that plate covered the
			// first line — the thing the note is mostly made of. Everything the
			// icons did is still in the menu.
			actions: [],
		});

		handle.el.dataset.annotationId = ann.id;
		handle.el.dataset.mode = ann.pinned ? "rail" : "free";
		handle.el.dataset.side = ann.side;
		handle.el.dataset.style = ann.style ?? "boxed";
		const color = this.colorOf(ann);
		handle.el.style.setProperty("--margin-notes-pdf-note-color", color);
		handle.el.style.setProperty("--margin-notes-pdf-note-color-deep", darken(color));
		handle.el.querySelector<HTMLElement>(".margin-notes-pdf-swatch")?.style.setProperty("color", color);

		handle.el.addEventListener("contextmenu", (e) => this.showMenu(e, pdfPath, ann));
		// The same `is-linked` state as hovering the TEXT applies, so the two
		// directions of the same relationship look identical rather than one
		// getting an outline and the other only an opacity bump.
		handle.el.addEventListener("mouseenter", () => {
			handle.el.addClass("is-linked");
			this.beginHoverHighlight(pageView, ann);
		});
		handle.el.addEventListener("mouseleave", () => {
			handle.el.removeClass("is-linked");
			this.endHoverHighlight();
		});
		this.gestures.attachBox(handle, pdfPath, ann, pageView, (at) => this.openMenu(pdfPath, ann, at));
		return handle;
	}

	private scaleFont(pdfPath: string, ann: PdfAnnotation, delta: number): void {
		this.mutate(pdfPath, ann, (a) => (a.fontScale = Math.max(0.3, Math.min(4, (a.fontScale ?? 1) + delta))));
	}

	/** Preset swatches rather than the OS colour panel — see swatch-picker.ts. */
	private pickColor(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		openSwatchPicker({
			at,
			swatches: this.getSettings().palette,
			currentKey: ann.colorKey,
			onPick: (colorKey) =>
				this.mutate(pdfPath, ann, (a) => {
					a.colorKey = colorKey;
				}),
		});
	}

	/**
	 * Un-pinning freezes the note exactly where it currently sits — same spot,
	 * same width — by reading its rendered box and writing that back as
	 * freeX/freeY/freeW.
	 *
	 * Leaving those unset (the previous behaviour) meant falling through to
	 * freeXPct/freeYPct's DEFAULTS, which are derived from the anchor. For a note
	 * in a rail that is nowhere near where it was: horizontally it teleports from
	 * the rail lane back beside its source text, and vertically it loses both its
	 * manual `offsetY` nudge and whatever displacement collision avoidance had
	 * given it. "Unpin" should mean "stop being in the lane", not "jump somewhere
	 * else" — from wherever it lands, dragging it is easy.
	 *
	 * `el.style.top` is read after the collision pass has written to it, so it is
	 * the note's true resolved position, not its pre-collision anchor position.
	 */
	private togglePin(pdfPath: string, ann: PdfAnnotation): void {
		if (ann.pinned) {
			const el = this.layer?.querySelector<HTMLElement>(`[data-annotation-id="${ann.id}"]`);
			const pageView = this.last?.pages.get(ann.page);
			const box = pageView ? this.currentPageBox(pageView) : null;
			if (el && box && box.width > 0 && box.height > 0) {
				const left = parseFloat(el.style.left || "0");
				const top = parseFloat(el.style.top || "0");
				// offsetWidth is unscaled (the zoom lives in the transform), so it
				// has to be scaled up before being expressed as a page percentage.
				const widthPx = el.offsetWidth * box.unit;
				this.mutate(pdfPath, ann, (a) => {
					a.pinned = false;
					a.freeX = ((left - box.left) / box.width) * 100;
					a.freeY = ((top - box.top) / box.height) * 100;
					a.freeW = (widthPx / box.width) * 100;
					// Now baked into freeY; leaving it would re-apply on a later re-pin.
					a.offsetY = 0;
				});
				return;
			}
		}

		// A free note's `side` used to be an invisible creation default (`right`),
		// not a statement of intent. Reusing it when pinning made a note visibly on
		// the left jump across the whole page. Choose the rail nearest the note's
		// current centre instead; the menu still allows an explicit move afterwards.
		let nearestSide = ann.side;
		if (!ann.pinned) {
			const el = this.layer?.querySelector<HTMLElement>(`[data-annotation-id="${ann.id}"]`);
			const pageView = this.last?.pages.get(ann.page);
			const box = pageView ? this.currentPageBox(pageView) : null;
			if (el && box) {
				const noteLeft = parseFloat(el.style.left || "0");
				const noteCentre = noteLeft + el.getBoundingClientRect().width / 2;
				nearestSide = noteCentre < box.left + box.width / 2 ? "left" : "right";
			}
		}
		this.mutate(pdfPath, ann, (a) => {
			if (a.pinned) {
				a.pinned = false;
			} else {
				a.pinned = true;
				a.side = nearestSide;
				a.offsetY = 0;
			}
		});
	}

	private showMenu(ev: MouseEvent, pdfPath: string, ann: PdfAnnotation): void {
		ev.preventDefault();
		ev.stopPropagation();
		this.openMenu(pdfPath, ann, { x: ev.clientX, y: ev.clientY });
	}

	private openMenu(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		const menu = new Menu();
		if (ann.markOnly) {
			menu.addItem((i) =>
				i
					.setTitle("显示在右侧轨道")
					.setIcon("message-square")
					.onClick(() =>
						this.mutate(pdfPath, ann, (a) => {
							a.markOnly = undefined;
							a.pinned = true;
							a.collapsed = false;
							a.side = "right";
						})
					)
			);
			menu.addItem((i) =>
				i
					.setTitle("重新指定勾画位置（选中文字或拖框）")
					.setIcon("highlighter")
					.onClick(() => this.requestReanchor(pdfPath, ann))
			);
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("更改颜色…")
					.setIcon("palette")
					.onClick(() => this.pickColor(pdfPath, ann, at))
			);
			if (ann.colorKey) {
				menu.addItem((i) =>
					i
						.setTitle("恢复默认颜色")
						.setIcon("rotate-ccw")
						.onClick(() => this.mutate(pdfPath, ann, (a) => (a.colorKey = undefined)))
				);
			}
			menu.addSeparator();
			appendAnnotationLayerMenuItems(menu, this.getSettings().layers, ann, (next) =>
				this.mutate(pdfPath, ann, (a) => (a.layerIds = next))
			);
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("删除勾画…")
					.setIcon("trash")
					.onClick(() => this.openMarkActions(pdfPath, ann, at, "delete"))
			);
			menu.showAtPosition(at);
			return;
		}
		menu.addItem((i) =>
			i
				.setTitle(ann.pinned ? "解除固定(随意摆放)" : "固定到侧边轨道")
				.setIcon(ann.pinned ? "pin-off" : "pin")
				.onClick(() => this.togglePin(pdfPath, ann))
		);
		menu.addItem((i) =>
			i
				.setTitle(ann.collapsed ? "展开" : "收起成点")
				.setIcon(ann.collapsed ? "maximize-2" : "minus")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.collapsed = !a.collapsed)))
			);
		const leaderShown = ann.showLeader ?? (this.getSettings().highlightMode === "line");
		menu.addItem((i) =>
			i
				.setTitle(leaderShown ? "取消箭头（覆盖默认设置）" : "添加箭头（覆盖默认设置）")
				.setIcon(leaderShown ? "minus" : "arrow-up-right")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.showLeader = !leaderShown)))
		);
		if (ann.pinned) {
			menu.addItem((i) =>
				i
					.setTitle(ann.side === "right" ? "移到左侧" : "移到右侧")
					.setIcon("arrow-left-right")
					.onClick(() => this.mutate(pdfPath, ann, (a) => (a.side = a.side === "right" ? "left" : "right")))
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("重新指定高亮位置(选中文字或拖框)")
				.setIcon("highlighter")
				.onClick(() => this.requestReanchor(pdfPath, ann))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("字号调大")
				.setIcon("a-arrow-up")
				.onClick(() => this.scaleFont(pdfPath, ann, 0.15))
		);
		menu.addItem((i) =>
			i
				.setTitle("字号调小")
				.setIcon("a-arrow-down")
				.onClick(() => this.scaleFont(pdfPath, ann, -0.15))
		);
		menu.addItem((i) =>
			i
				.setTitle("恢复默认字号")
				.setIcon("rotate-ccw")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.fontScale = undefined)))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle(ann.style === "plain" ? "改成带边框样式" : "改成纯文字样式(去掉边框和背景)")
				.setIcon(ann.style === "plain" ? "square" : "type")
				.onClick(() => this.mutate(pdfPath, ann, (a) => (a.style = a.style === "plain" ? "boxed" : "plain")))
		);
		menu.addItem((i) =>
			i
				.setTitle("更改颜色…")
				.setIcon("palette")
				.onClick(() => this.pickColor(pdfPath, ann, at))
		);
		if (ann.colorKey) {
			menu.addItem((i) =>
				i
					.setTitle("恢复默认颜色")
					.setIcon("rotate-ccw")
					.onClick(() =>
						this.mutate(pdfPath, ann, (a) => {
							a.colorKey = undefined;
						})
					)
			);
		}
		menu.addSeparator();
		appendAnnotationLayerMenuItems(menu, this.getSettings().layers, ann, (next) =>
			this.mutate(pdfPath, ann, (a) => (a.layerIds = next))
		);
		if (!ann.pinned) {
			menu.addItem((i) =>
				i
					.setTitle("恢复自动高度")
					.setIcon("unfold-vertical")
					.onClick(() => this.mutate(pdfPath, ann, (a) => (a.freeH = undefined)))
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("删除批注")
				.setIcon("trash")
				.onClick(() => {
					this.store.remove(pdfPath, ann.id);
					this.refresh();
				})
		);
		menu.showAtPosition(at);
	}

	private currentPageBox(pageView: PDFPageView): PageBox | null {
		const scroller = this.scroller;
		if (!scroller || !pageView.div.isConnected || !pageView.pdfPage?.view) return null;
		return measurePageBox(pageView, scroller, scroller.getBoundingClientRect());
	}

	/**
	 * Jump feedback for a list-panel click: flashes the note itself if it's
	 * currently rendered, and — this is the part that actually answers "where
	 * in the PDF does this point at" — draws a temporary highlight box over the
	 * ORIGINAL anchored text/region and scrolls it into view. The note's own
	 * on-screen spot (rail lane, or a dragged-away sticky note) is often not
	 * where the source text is, so flashing the note alone doesn't show that.
	 */
	reveal(pages: Map<number, PDFPageView>, ann: PdfAnnotation): void {
		const el = this.layer?.querySelector<HTMLElement>(`[data-annotation-id="${ann.id}"]`);
		if (el) {
			el.addClass("is-flashing");
			window.setTimeout(() => el.removeClass("is-flashing"), 1200);
		}

		const pageView = pages.get(ann.page);
		if (!pageView) return;
		const mark = this.drawAnchorMark(pageView, ann, "margin-notes-pdf-anchor-flash");
		if (!mark) return;
		mark.scrollIntoView({ block: "center", behavior: "smooth" });
		window.setTimeout(() => mark.remove(), 1600);
	}

	/**
	 * Hover feedback: unlike `reveal()` (a click, timed flash + scroll), this
	 * stays on screen for exactly as long as the pointer is over the note/row
	 * and never scrolls anything — a rail note or a list-panel row can be far
	 * from its source text, and jumping the view on mere hover would be far more
	 * disorienting than the "where does this even point at" problem it's meant
	 * to solve. Silently does nothing if the anchor's page isn't currently
	 * rendered (e.g. hovering a list row for a page that's scrolled out of view).
	 */
	private hoverMark: HTMLElement | null = null;
	private activeBands: HTMLElement[] = [];
	private hoverPreview: HTMLElement | null = null;
	private hoverPreviewId: string | null = null;

	beginHoverHighlight(pageView: PDFPageView, ann: PdfAnnotation): void {
		this.endHoverHighlight();
		// A band already covering this anchor is brightened in place. Drawing a
		// second translucent rect over the first is what made 常亮 look much
		// darker than 悬浮 — the two layers composited instead of matching.
		const bands = this.bands.get(ann.id);
		if (bands?.length) {
			for (const band of bands) band.addClass("is-active");
			this.activeBands = bands;
			return;
		}
		this.hoverMark = this.drawAnchorMark(pageView, ann, "margin-notes-pdf-anchor-hover");
	}

	endHoverHighlight(): void {
		for (const band of this.activeBands) band.removeClass("is-active");
		this.activeBands = [];
		this.hoverMark?.remove();
		this.hoverMark = null;
	}

	private clearHoverPreview(): void {
		this.hoverPreview?.remove();
		this.hoverPreview = null;
		this.hoverPreviewId = null;
	}

	/** Shows collapsed-note content from the much larger source highlight hit area. */
	private showCollapsedPreview(hit: {
		ann: PdfAnnotation;
		x0: number;
		x1: number;
		y0: number;
		y1: number;
	}): void {
		this.clearHoverPreview();
		const layer = this.layer;
		const scroller = this.scroller;
		if (!layer || !scroller || !hit.ann.text) return;

		const preview = layer.createDiv("margin-notes-pdf-collapsed-preview");
		preview.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(hit.ann));
		const spaceBelow = scroller.scrollTop + scroller.clientHeight - hit.y1;
		const spaceAbove = hit.y0 - scroller.scrollTop;
		const above = spaceBelow < 150 && spaceAbove > spaceBelow;
		preview.toggleClass("is-above", above);
		const previewLeft = Math.max(
			scroller.scrollLeft + 4,
			Math.min(hit.x0, scroller.scrollLeft + scroller.clientWidth - 284)
		);
		preview.setCssStyles({
			left: `${previewLeft}px`,
			top: `${above ? hit.y0 - 7 : hit.y1 + 7}px`,
		});
		this.hoverPreview = preview;
		this.hoverPreviewId = hit.ann.id;

		const render = async () => {
			if (hit.ann.text.includes("$")) await loadMathJax();
			if (!preview.isConnected || this.hoverPreviewId !== hit.ann.id) return;
			await MarkdownRenderer.render(this.app, hit.ann.text, preview, this.last?.pdfPath ?? "", this.component);
		};
		void render();
	}

	/**
	 * Right-clicking the highlighted TEXT opens that note's menu — the region on
	 * the page is the most obvious thing to aim at when you want to change the
	 * note attached to it, and it is often far easier to hit than a note sitting
	 * off in a rail. Only swallows the event on an actual hit, so right-clicking
	 * anywhere else on the PDF still gets Obsidian's own menu.
	 */
	private onScrollerContextMenu = (ev: MouseEvent): void => {
		this.cancelPendingMarkClick();
		const pdfPath = this.last?.pdfPath;
		if (!pdfPath || !this.scroller || this.hitAreas.length === 0) return;
		if ((ev.target as HTMLElement | null)?.closest(".margin-notes-pdf-note")) return;

		const r = this.scroller.getBoundingClientRect();
		const x = ev.clientX - r.left + this.scroller.scrollLeft;
		const y = ev.clientY - r.top + this.scroller.scrollTop;
		const hit = this.hitAreas.find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
		if (!hit) return;

		ev.preventDefault();
		ev.stopPropagation();
		this.openMenu(pdfPath, hit.ann, { x: ev.clientX, y: ev.clientY });
	};

	private onScrollerScroll = (): void => {
		this.cancelPendingMarkClick();
		this.markPopover?.requestClose();
	};

	private onScrollerPointerDown = (ev: PointerEvent): void => {
		this.cancelPendingMarkClick();
		this.markPointerDown = { x: ev.clientX, y: ev.clientY, button: ev.button };
	};

	private onScrollerDoubleClick = (): void => {
		this.cancelPendingMarkClick();
	};

	/** A plain click on a mark opens its actions; dragging remains native PDF text selection. */
	private onScrollerClick = (ev: MouseEvent): void => {
		const down = this.markPointerDown;
		this.markPointerDown = null;
		if (ev.detail > 1) return;
		if (!isMarkClick(down, { x: ev.clientX, y: ev.clientY }, window.getSelection()?.toString() ?? "")) return;
		if ((ev.target as HTMLElement | null)?.closest(".margin-notes-pdf-note, .margin-notes-pdf-dot, .margin-notes-pdf-box")) return;
		const pdfPath = this.last?.pdfPath;
		const scroller = this.scroller;
		if (!pdfPath || !scroller) return;
		const r = scroller.getBoundingClientRect();
		const x = ev.clientX - r.left + scroller.scrollLeft;
		const y = ev.clientY - r.top + scroller.scrollTop;
		const hit = this.hitAreas.find((h) => h.ann.markOnly && x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
		if (!hit) return;
		const ann = hit.ann;
		const at = { x: ev.clientX, y: ev.clientY };
		// Delay until the double-click window starts to pass: an immediate dialog
		// steals focus before pdf.js can select a word on the second click.
		this.markClickTimer = window.setTimeout(() => {
			this.cancelPendingMarkClick();
			if (window.getSelection()?.toString().trim()) return;
			if (this.last?.pdfPath !== pdfPath || !this.store.forFile(pdfPath).some((item) => item.id === ann.id)) return;
			this.openMarkActions(pdfPath, ann, at);
		}, 300);
		document.addEventListener("pointerdown", this.cancelPendingMarkClick, true);
	};

	private openMarkActions(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }, initialAction?: "delete"): void {
		this.clearHoverPreview();
		this.endHoverHighlight();
		this.hoveredAnchorId = null;
		const handle = openMarkPopover({
			app: this.app,
			mode: "existing",
			at,
			swatches: this.getSettings().palette,
			currentKey: ann.colorKey,
			quote: ann.quote,
			text: ann.text,
			initialAction,
			onPickColor: (colorKey) => this.mutate(pdfPath, ann, (a) => (a.colorKey = colorKey)),
			onSaveText: (value) => this.mutate(pdfPath, ann, (a) => (a.text = value)),
			onDelete: () => {
				this.store.remove(pdfPath, ann.id);
				this.refresh();
			},
			onClose: () => {
				this.markPopover = null;
				this.hoveredAnchorId = null;
			},
		});
		if (handle) this.markPopover = handle;
	}

	/**
	 * The colour a note and its highlight share. Per-note `color` wins; otherwise
	 * the rail/free default for its kind — so the band over the text is always
	 * the same hue as the note it belongs to, which is what makes several
	 * highlights on one page readable at a glance.
	 */
	private colorOf(ann: PdfAnnotation): string {
		return resolveAnnotationColor(ann, this.getSettings());
	}

	private drawAnchorMark(pageView: PDFPageView, ann: PdfAnnotation, cls: string): HTMLElement | null {
		const layer = this.layer;
		const scroller = this.scroller;
		if (!layer || !scroller || !pageView.div.isConnected || !pageView.pdfPage?.view) return null;

		// Highlight the REAL source text or nothing at all. An unresolved record
		// gets one live quote lookup here; if that fails we return null rather
		// than drawing over `layout()`'s placeholder spot, because a highlight
		// pointing confidently at the wrong lines is worse than no highlight —
		// the whole purpose of this is answering "where is this in the original".
		const rect = isUnresolvedAnchor(ann.anchor)
			? ann.quote
				? resolveQuoteAnchor(pageView, ann.quote)
				: null
			: ann.anchor;
		if (!rect) return null;

		const box = measurePageBox(pageView, scroller, scroller.getBoundingClientRect());
		const bounds = (ann.anchorRects?.length ? ann.anchorRects : [rect]).map((line) => pdfRectInPageBox(pageView, line, box));
		const x0 = Math.min(...bounds.map((line) => line.x0));
		const x1 = Math.max(...bounds.map((line) => line.x1));
		const y0 = Math.min(...bounds.map((line) => line.y0));
		const y1 = Math.max(...bounds.map((line) => line.y1));
		const mark = layer.createDiv("margin-notes-pdf-anchor-group");
		mark.setCssStyles({ left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
		mark.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		for (const line of bounds) {
			const band = mark.createDiv(cls);
			band.setCssStyles({
				left: `${line.x0 - x0}px`,
				top: `${line.y0 - y0}px`,
				width: `${line.x1 - line.x0}px`,
				height: `${line.y1 - line.y0}px`,
			});
		}
		return mark;
	}

	/**
	 * Draws whatever the current mode wants shown without any pointer involved:
	 * a permanent band per anchor (`always`), or a leader line from each note to
	 * its text (`line`). `note`/`both` draw nothing here — they are purely
	 * hover-driven — but `both` still needs the anchor rects recorded, which is
	 * what `hitAreas` is for.
	 */
	private renderModeDecorations(
		built: Placed[],
		settings: PdfAnnotationSettings,
		scroller: HTMLElement,
		marks: AnchoredAnnotation[] = []
	): void {
		// Clearing a Map does not remove its DOM. Keep this defensive cleanup even
		// though normal rebuilds now draw decorations only in the final pass.
		for (const parts of this.leaders.values()) {
			parts.line.remove();
			parts.knob.remove();
		}
		for (const bands of this.bands.values()) for (const band of bands) band.remove();
		this.hitAreas = [];
		this.bands.clear();
		this.leaders.clear();
		const layer = this.layer;
		if (!layer) return;
		const mode = settings.highlightMode;
		const scrollerRect = scroller.getBoundingClientRect();

		for (const item of built) {
			const { ann, el, pageView, rect } = item;
			if (!pageView.div.isConnected || !pageView.pdfPage?.view) continue;
			if (isUnresolvedAnchor(rect)) continue;

			const box = measurePageBox(pageView, scroller, scrollerRect);
			const { x0, x1, y0, y1 } = pdfRectInPageBox(pageView, rect, box);

			// Recorded in every mode: reverse hover uses them when the mode wants it,
			// and right-clicking the region to edit its note works regardless.
			const lines = (ann.anchorRects?.length ? ann.anchorRects : [rect]).map((lineRect) => pdfRectInPageBox(pageView, lineRect, box));
			for (const line of lines) this.hitAreas.push({ ann, el, ...line });

			if (mode === "always") {
				const bands = lines.map((line) => {
					const band = layer.createDiv("margin-notes-pdf-anchor-band");
					band.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
					band.setCssStyles({ left: `${line.x0}px`, top: `${line.y0}px`, width: `${line.x1 - line.x0}px`, height: `${line.y1 - line.y0}px` });
					return band;
				});
				this.bands.set(ann.id, bands);
			}
			// A collapsed note should render as exactly one point. Keeping the
			// leader's draggable endpoint created a second, unexplained dot.
			if (leaderVisible(ann.collapsed, ann.showLeader, mode === "line")) {
				this.drawLeader(layer, ann, el, { x0, x1, y0, y1 }, pageView);
			}
		}

		// Mark-only annotations are deliberately independent of the global note
		// highlight mode: the band is their entire visible representation. It stays
		// pointer-inert so native PDF text selection remains available; right-click
		// and hover use the same scroller-level geometry hit testing as note anchors.
		for (const { ann, pageView, rect } of marks) {
			if (!pageView.div.isConnected || !pageView.pdfPage?.view || isUnresolvedAnchor(rect)) continue;
			const box = measurePageBox(pageView, scroller, scrollerRect);
			const bands: HTMLElement[] = [];
			for (const lineRect of ann.anchorRects?.length ? ann.anchorRects : [rect]) {
				const { x0, x1, y0, y1 } = pdfRectInPageBox(pageView, lineRect, box);
				this.hitAreas.push({ ann, x0, x1, y0, y1 });

				const band = layer.createDiv("margin-notes-pdf-anchor-band margin-notes-pdf-mark-only");
				band.dataset.annotationId = ann.id;
				band.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
				band.setCssStyles({ left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
				bands.push(band);
			}
			this.bands.set(ann.id, bands);
		}
	}

	/**
	 * A thin leader from the note edge nearest its text to the nearest point on
	 * that text. All four note edges participate, so a note above or below its
	 * source gets a vertical leader instead of a forced diagonal from one side.
	 * Drawn as one rotated 1px div rather than an SVG overlay — it needs no
	 * separate coordinate system, and there is exactly one primitive to keep in
	 * sync with the layer's scroll coordinates.
	 */
	private drawLeader(
		layer: HTMLElement,
		ann: PdfAnnotation,
		el: HTMLElement,
		a: { x0: number; x1: number; y0: number; y1: number },
		pageView: PDFPageView
	): void {
		const line = layer.createDiv("margin-notes-pdf-leader");
		const knob = layer.createDiv("margin-notes-pdf-leader-knob");
		for (const n of [line, knob]) n.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		knob.setAttribute("aria-label", "拖动可以改变箭头落在高亮范围内的哪个位置");

		const parts: LeaderParts = { line, knob, noteEl: el, pageView, ann, a: { ...a } };
		this.leaders.set(ann.id, parts);
		this.positionLeader(parts);
		knob.addEventListener("pointerdown", (ev) => this.beginAnchorDrag(ev, parts));
	}

	/**
	 * Places (or replaces) a leader between the nearest of all four note edges
	 * and its text, with the knob on the text end. Split out from drawLeader
	 * so a drag can call it on every pointermove — the line used to be redrawn
	 * only by the debounced rebuild, which is why it visibly lagged behind a note
	 * being dragged.
	 */
	private positionLeader(p: LeaderParts): void {
		const { line, knob, noteEl, a } = p;
		const noteRect = noteEl.getBoundingClientRect();
		const noteLeft = parseFloat(noteEl.style.left || "0");
		const noteTop = parseFloat(noteEl.style.top || "0");

		const { start, end } = adaptiveLeaderEndpoints(
			{ left: noteLeft, top: noteTop, right: noteLeft + noteRect.width, bottom: noteTop + noteRect.height },
			{ left: a.x0, top: a.y0, right: a.x1, bottom: a.y1 },
			p.ann.leaderAt
		);
		const { x: sx, y: sy } = start;
		const { x: tx, y: ty } = end;

		const dx = tx - sx;
		const dy = ty - sy;
		const len = Math.hypot(dx, dy);
		line.setCssStyles({
			left: `${sx}px`,
			top: `${sy}px`,
			width: `${Math.max(0, len)}px`,
			transform: `rotate(${Math.atan2(dy, dx)}rad)`,
			transformOrigin: "0 50%",
		});
		knob.setCssStyles({ left: `${tx}px`, top: `${ty}px` });
	}

	/** Keeps a note's leader glued to it while the note itself is being dragged. */
	private refreshLeader(annId: string): void {
		const p = this.leaders.get(annId);
		if (p) this.positionLeader(p);
	}

	/**
	 * Moves where the arrow attaches, CLAMPED to the highlighted region.
	 *
	 * Two different things could have been meant by dragging this end, and only
	 * one of them is safe. Moving the attachment point is presentational — the
	 * arrow leaves from a tidier spot — and costs nothing if done by accident.
	 * Moving the REGION would redefine where the note says its subject is, which
	 * is content, and a stray drag must never silently rewrite that. So the point
	 * slides freely inside the region and stops at its edge; pulling well past
	 * the edge says how to actually change the region.
	 */
	private beginAnchorDrag(ev: PointerEvent, p: LeaderParts): void {
		ev.preventDefault();
		ev.stopPropagation();
		const pdfPath = this.last?.pdfPath;
		if (!pdfPath || !this.scroller) return;

		const scroller = this.scroller;
		const a = p.a;
		const w = a.x1 - a.x0;
		const h = a.y1 - a.y0;
		let escaped = 0;
		p.knob.addClass("is-dragging");

		const fractionAt = (m: MouseEvent) => {
			const r = scroller.getBoundingClientRect();
			const x = m.clientX - r.left + scroller.scrollLeft;
			const y = m.clientY - r.top + scroller.scrollTop;
			// How far outside the region the pointer went, for the hint below.
			escaped = Math.max(escaped, a.x0 - x, x - a.x1, a.y0 - y, y - a.y1);
			return {
				x: w > 0 ? Math.max(0, Math.min(1, (x - a.x0) / w)) : 0,
				y: h > 0 ? Math.max(0, Math.min(1, (y - a.y0) / h)) : 0.5,
			};
		};

		const onMove = (m: PointerEvent) => {
			p.ann.leaderAt = fractionAt(m);
			this.positionLeader(p);
		};
		const onUp = (u: PointerEvent) => {
			window.removeEventListener("pointermove", onMove);
			p.knob.removeClass("is-dragging");
			const at = fractionAt(u);
			this.mutate(pdfPath, p.ann, (ann) => (ann.leaderAt = at));
			if (escaped >= REANCHOR_HINT_PX) {
				new Notice("箭头只能落在高亮范围内。要改高亮范围:选中新的文字,再用批注菜单里的「重新指定高亮位置」");
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	}

	/**
	 * Reverse hover for `both` mode: pointing at the TEXT lights up its note.
	 *
	 * Driven by a mousemove hit-test rather than by real elements over the
	 * anchors, because anything with `pointer-events: auto` sitting on the page
	 * would swallow text selection — and selecting text is how annotations get
	 * made in the first place.
	 */
	private onScrollerMove = (ev: MouseEvent): void => {
		if (this.markPopover || this.hitAreas.length === 0 || !this.scroller) return;
		// While the pointer is on a note, that note's own mouseenter owns the
		// highlight. Without this the two fight: the note lights its anchor, then
		// the very next mousemove finds no anchor under the cursor and clears it.
		if ((ev.target as HTMLElement | null)?.closest(".margin-notes-pdf-note")) return;
		const r = this.scroller.getBoundingClientRect();
		const x = ev.clientX - r.left + this.scroller.scrollLeft;
		const y = ev.clientY - r.top + this.scroller.scrollTop;

		const reverseNotes = highlightsBothWays(this.getSettings().highlightMode);
		const hit = this.hitAreas.find(
			(h) => (h.ann.markOnly || reverseNotes) && x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1
		);
		if (hit?.ann.id === this.hoveredAnchorId) return;
		this.hoveredAnchorId = hit?.ann.id ?? null;

		for (const h of this.hitAreas) h.el?.removeClass("is-linked");
		this.endHoverHighlight();
		this.clearHoverPreview();
		if (!hit) return;

		hit.el?.addClass("is-linked");
		if ((hit.ann.markOnly && hit.ann.text) || (!hit.ann.markOnly && hit.ann.collapsed)) this.showCollapsedPreview(hit);
		const pageView = this.last?.pages.get(hit.ann.page);
		if (pageView) this.beginHoverHighlight(pageView, hit.ann);
	};

	destroy(): void {
		window.clearTimeout(this.rebuildTimer);
		this.cancelPendingMarkClick();
		this.markPopover?.close();
		this.zoom.destroy();
		this.hoverMark = null;
		this.clearHoverPreview();
		// The gutter lives on pdf.js's own element, not ours — it has to be undone
		// explicitly, unlike the layer, which disappears with its own node.
		if (this.scroller) {
			this.leftSpace.clear(this.scroller);
			this.scroller.removeEventListener("mousemove", this.onScrollerMove);
			this.scroller.removeEventListener("contextmenu", this.onScrollerContextMenu);
			this.scroller.removeEventListener("pointerdown", this.onScrollerPointerDown, true);
			this.scroller.removeEventListener("click", this.onScrollerClick, true);
			this.scroller.removeEventListener("dblclick", this.onScrollerDoubleClick, true);
			this.scroller.removeEventListener("scroll", this.onScrollerScroll);
		}
		this.hitAreas = [];
		this.layer?.remove();
		this.layer = null;
		this.scroller = null;
	}
}
