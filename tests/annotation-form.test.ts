import assert from "node:assert/strict";
import { annotationForm, setAnnotationForm, type AnnotationForm } from "../src/pdf/annotation-form";
import { normalizeAnnotation } from "../src/pdf/annotation-types";

const original = normalizeAnnotation({
	id: "stable-record", page: 5, quote: "continuous source quote", text: "Comment\n$E=mc^2$",
	anchor: [10, 20, 30, 40], anchorRects: [[10, 20, 30, 40]],
	textSelection: { pdfPath: "paper.pdf", page: 5, range: [0, 2, 1, 4] },
	colorKey: "my-colour", layerIds: ["layer-a", "layer-b"],
	createdAt: 123, updatedAt: 456, freeX: -10, freeY: 25, freeW: 30,
	fontScale: 1.2, showLeader: true,
});
const { markOnly: _mark, pinned: _pin, collapsed: _collapsed, side: _side, ...content } = original;
// Repeated conversions followed by storage normalization must not duplicate or
// lose the note, selected lines, shared identity, colours or layer memberships.
for (const form of ["mark", "left", "popup", "right", "free", "mark"] as AnnotationForm[]) {
	setAnnotationForm(original, form);
	const reloaded = normalizeAnnotation(JSON.parse(JSON.stringify(original)) as typeof original);
	assert.equal(annotationForm(reloaded), form);
	const { markOnly, pinned, collapsed, side, ...retained } = reloaded;
	assert.deepEqual(retained, content);
	if (form === "left" || form === "right") assert.equal(side, form);
	assert.equal(Boolean(markOnly), form === "mark");
	assert.equal(pinned, form === "left" || form === "right");
	assert.equal(collapsed, form === "popup" || form === "mark");
}
console.log("annotation-form: presentation round-trip preserves records");
