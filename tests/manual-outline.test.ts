import assert from "node:assert/strict";
import { combineOutlines, groupAnnotationsByOutline, mergeManualOutlines, normalizeManualOutline } from "../src/pdf/manual-outline";
import { normalizeAnnotation } from "../src/pdf/annotation-types";
import type { PdfOutlineItem } from "../src/pdf/pdf-outline";

const original: PdfOutlineItem[] = [
	{ title: "引言", page: 1, topRatio: null, items: [] },
	{ title: "讨论", page: 8, topRatio: null, items: [] },
];
const manual = [
	{ id: "method", title: "方法", page: 3, level: 1 },
	{ id: "measure", title: "实验设置", page: 5, level: 2 },
];
assert.deepEqual(normalizeManualOutline([{ ...manual[0] }, { id: "bad", title: " ", page: 0, level: 9 }]), [manual[0]]);
assert.deepEqual(mergeManualOutlines(manual, manual).map((item) => item.id), ["method", "measure"]);
const combined = combineOutlines(original, manual);
assert.deepEqual(combined.map((item) => item.title), ["引言", "方法", "讨论"]);
assert.equal(combined[1].items[0].title, "实验设置");
assert.equal(combined[1].manualId, "method");
assert.equal(original[0].items.length, 0);
const notes = [1, 3, 5, 7, 8].map((page) => normalizeAnnotation({ id: `n${page}`, page, text: "note" }));
const grouped = groupAnnotationsByOutline(combined, notes);
assert.deepEqual(grouped.byHeading.get(combined[0])?.map((ann) => ann.page), [1]);
assert.deepEqual(grouped.byHeading.get(combined[1])?.map((ann) => ann.page), [3]);
assert.deepEqual(grouped.byHeading.get(combined[1].items[0])?.map((ann) => ann.page), [5, 7]);
assert.deepEqual(grouped.byHeading.get(combined[2])?.map((ann) => ann.page), [8]);
assert.equal(grouped.counts.get(combined[1]), 3);
assert.equal(grouped.beforeFirst.length, 0);
const orphan = groupAnnotationsByOutline(combined, [normalizeAnnotation({ id: "early", page: 0, text: "x" })]);
assert.equal(orphan.beforeFirst.length, 1);
const container: PdfOutlineItem[] = [{ title: "父项", page: 1, topRatio: null, items: [
	{ title: "子项", page: 4, topRatio: null, items: [] },
] }, { title: "后续章节", page: 8, topRatio: null, items: [] }];
assert.equal(combineOutlines(container, [{ id: "late", title: "补充", page: 5, level: 1 }])[0].title, "父项");
assert.equal(combineOutlines(container, [{ id: "early", title: "补充", page: 3, level: 1 }])[0].items[0].title, "子项");
const preserved = combineOutlines(container, [{ id: "early", title: "补充", page: 3, level: 1 }]);
const afterManualStart = groupAnnotationsByOutline(preserved, [normalizeAnnotation({ id: "after", page: 5, text: "x" })]);
assert.equal(afterManualStart.byHeading.get(preserved[1])?.length, 1);
const withoutDestination: PdfOutlineItem[] = [{ title: "无位置父项", page: null, topRatio: null, items: [
	{ title: "子项", page: 4, topRatio: null, items: [] },
] }];
assert.equal(combineOutlines(withoutDestination, [{ id: "last", title: "补充", page: 5, level: 1 }])[0].items[0].title, "子项");
console.log("manual-outline: 12 cases passed");
