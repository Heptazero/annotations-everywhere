import assert from "node:assert/strict";
import { loadPdfAnnotationSettings } from "../src/pdf/annotation-settings";
import { sortAnnotationsForReading, sortPageAnnotations } from "../src/pdf/reading-order";

const item = (id: string, page: number, anchor: [number, number, number, number]) => ({ id, page, anchor });

const single = sortPageAnnotations([
	item("lower-left", 1, [50, 100, 90, 120]),
	item("upper-right", 1, [400, 600, 450, 620]),
]);
assert.deepEqual(single.map((entry) => entry.id), ["upper-right", "lower-left"]);

const double = sortPageAnnotations(
	[
		item("left-lower", 1, [50, 100, 90, 120]),
		item("right-upper", 1, [350, 600, 390, 620]),
		item("left-upper", 1, [50, 500, 90, 520]),
		item("right-lower", 1, [350, 80, 390, 100]),
	],
	300
);
assert.deepEqual(double.map((entry) => entry.id), ["left-upper", "left-lower", "right-upper", "right-lower"]);

const spanning = sortPageAnnotations(
	[
		item("title", 1, [80, 700, 520, 730]),
		item("left-above", 1, [50, 500, 90, 520]),
		item("right-above", 1, [350, 600, 390, 620]),
		item("section", 1, [100, 350, 500, 370]),
		item("left-below", 1, [50, 100, 90, 120]),
		item("right-below", 1, [350, 200, 390, 220]),
	],
	300
);
assert.deepEqual(spanning.map((entry) => entry.id), [
	"title",
	"left-above",
	"right-above",
	"section",
	"left-below",
	"right-below",
]);

const pages = sortAnnotationsForReading(
	[item("page-2", 2, [50, 700, 90, 720]), item("page-1", 1, [350, 100, 390, 120])],
	300
);
assert.deepEqual(pages.map((entry) => entry.id), ["page-1", "page-2"]);
assert.deepEqual(sortPageAnnotations([item("finite", 1, [0, 0, 1, 1])], Number.NaN).map((entry) => entry.id), ["finite"]);

const normalized = await loadPdfAnnotationSettings({
	loadData: async () => ({
		pdfAnnotationSettings: {
			doubleColumnSplits: { "paper.pdf": 306, "bad.pdf": "306", "nan.pdf": Number.NaN },
		},
	}),
});
assert.deepEqual(normalized.doubleColumnSplits, { "paper.pdf": 306 });
assert.deepEqual(
	(await loadPdfAnnotationSettings({ loadData: async () => ({ pdfAnnotationSettings: { doubleColumnSplits: [] } }) }))
		.doubleColumnSplits,
	{}
);

console.log("reading-order: 7 cases passed");
