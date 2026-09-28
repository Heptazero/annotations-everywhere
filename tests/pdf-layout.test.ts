import assert from "node:assert/strict";
import { LeftAnnotationSpace, requiredLeftGutter } from "../src/pdf/annotation-space";
import { anchorTop, defaultFreeXPct, freeLeft, measurePageBox, pdfRectInPageBox } from "../src/pdf/page-geometry";
import { railGapPt, railLeft, railWidthPt } from "../src/pdf/rail-layout";

const settings = {
	railWidthLeft: 200,
	railWidthRight: 220,
	railGapLeft: 30,
	railGapRight: 40,
} as never;

assert.equal(railWidthPt(settings, "left"), 200);
assert.equal(railWidthPt(settings, "right"), 220);
assert.equal(railGapPt(settings, "left"), 30);
assert.equal(requiredLeftGutter(settings, [{ kind: "rail", unit: 2 }]), 488);
assert.equal(requiredLeftGutter(settings, [{ kind: "free", freeXPct: -25, pageWidth: 800 }]), 228);
assert.equal(requiredLeftGutter(settings, [{ kind: "free", freeXPct: 25, pageWidth: 800 }]), 0);
assert.equal(
	requiredLeftGutter(settings, [
		{ kind: "rail", unit: 1 },
		{ kind: "free", freeXPct: -50, pageWidth: 800 },
	]),
	428
);

const box = {
	left: 500,
	top: 100,
	width: 612,
	height: 792,
	ptX0: 0,
	ptX1: 612,
	ptWidth: 612,
	ptY0: 0,
	ptY1: 792,
	ptHeight: 792,
	unit: 1,
};
assert.equal(railLeft("left", box, 200, 30), 270);
assert.equal(railLeft("right", box, 220, 40), 1152);
assert.equal(railLeft("left", { ...box, left: 100 }, 200, 30), -130);
assert.equal(anchorTop([10, 700, 20, 720], 8, box), 180);
assert.ok(defaultFreeXPct([10, 700, 20, 720], box) > 6);
assert.ok(Math.abs(freeLeft(-20, [10, 700, 20, 720], { ...box, left: 100 }) + 22.4) < 1e-9);

const fakePage = {
	div: { getBoundingClientRect: () => ({ left: 150, top: 250, width: 1224, height: 1584 }) },
	pdfPage: { view: [0, 0, 612, 792] },
};
const fakeScroller = { scrollLeft: 50, scrollTop: 100 };
const measured = measurePageBox(fakePage as never, fakeScroller as never, { left: 100, top: 200 } as DOMRect);
assert.equal(measured.left, 100);
assert.equal(measured.top, 150);
assert.equal(measured.unit, 2);

// A selected pixel rectangle must round-trip through the viewer's viewport,
// including a rotated page. Media-box width/height interpolation cannot do this.
const textRect: [number, number, number, number] = [10, 700, 30, 720];
assert.deepEqual(
	pdfRectInPageBox({ viewport: { convertToViewportPoint: (x: number, y: number) => [x * 2, (792 - y) * 2] } } as never, textRect, box),
	{ x0: 520, x1: 560, y0: 244, y1: 284 }
);
assert.deepEqual(
	pdfRectInPageBox({ viewport: { convertToViewportPoint: (x: number, y: number) => [y * 2, x * 2] } } as never, textRect, box),
	{ x0: 1900, x1: 1940, y0: 120, y1: 160 }
);

// The initial gutter reveals the rail. Later changes accumulate until the final
// layout commits, when scrollWidth is ready and the page can keep its position.
let currentScrollLeft = 100;
let widthReady = false;
const fakeRailScroller = {
	style: { paddingLeft: "" },
	get scrollLeft() {
		return currentScrollLeft;
	},
	set scrollLeft(next: number) {
		// Models the browser clamping a premature write against stale scrollWidth.
		currentScrollLeft = Math.min(next, widthReady ? 1000 : 100);
	},
};
const viewerClasses = new Set<string>();
const viewerProperties = new Map<string, string>();
const fakeViewerRoot = {
	classList: {
		toggle(name: string, force: boolean) {
			if (force) viewerClasses.add(name);
			else viewerClasses.delete(name);
		},
		remove(name: string) {
			viewerClasses.delete(name);
		},
	},
	style: {
		setProperty(name: string, value: string) {
			viewerProperties.set(name, value);
		},
		removeProperty(name: string) {
			viewerProperties.delete(name);
		},
	},
};
const space = new LeftAnnotationSpace();
space.apply(fakeRailScroller as never, fakeViewerRoot as never, 200);
space.commit(fakeRailScroller as never);
assert.equal(fakeRailScroller.scrollLeft, 100);
assert.equal(viewerProperties.get("--margin-notes-pdf-left-gutter"), "200px");
assert.ok(viewerClasses.has("margin-notes-pdf-viewer-shifted"));
space.apply(fakeRailScroller as never, fakeViewerRoot as never, 320);
assert.equal(fakeRailScroller.scrollLeft, 100);
widthReady = true;
space.commit(fakeRailScroller as never);
assert.equal(fakeRailScroller.scrollLeft, 220);
space.apply(fakeRailScroller as never, fakeViewerRoot as never, 260);
space.commit(fakeRailScroller as never);
assert.equal(fakeRailScroller.scrollLeft, 160);
space.clear(fakeRailScroller as never);
assert.equal(fakeRailScroller.scrollLeft, 0);
assert.equal(viewerProperties.size, 0);
assert.equal(viewerClasses.size, 0);

// A free note dragged across the page's left edge creates space for the first
// time. Do not immediately scroll that new space away; later zoom changes are
// the ones that preserve the page position through compensation.
currentScrollLeft = 100;
const introducedSpace = new LeftAnnotationSpace();
introducedSpace.apply(fakeRailScroller as never, fakeViewerRoot as never, 0);
introducedSpace.apply(fakeRailScroller as never, fakeViewerRoot as never, 200);
introducedSpace.commit(fakeRailScroller as never);
assert.equal(fakeRailScroller.scrollLeft, 100);

console.log("pdf-page/rail-layout: 17 cases passed");
