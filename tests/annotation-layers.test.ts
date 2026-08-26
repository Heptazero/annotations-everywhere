import assert from "node:assert/strict";
import {
	annotationVisibleInLayer,
	DEFAULT_ANNOTATION_LAYERS,
	normalizeAnnotationLayerIds,
	normalizeAnnotationLayers,
	toggleAnnotationLayer,
} from "../src/pdf/annotation-layers";

const defaults = normalizeAnnotationLayers(undefined);
assert.deepEqual(defaults, DEFAULT_ANNOTATION_LAYERS);
assert.notEqual(defaults, DEFAULT_ANNOTATION_LAYERS);
assert.deepEqual(normalizeAnnotationLayers([]), []);
assert.deepEqual(normalizeAnnotationLayerIds(["a", "", "a", 3, " b "]), ["a", "b"]);
assert.equal(annotationVisibleInLayer({}, null), true);
assert.equal(annotationVisibleInLayer({ layerIds: ["a", "b"] }, "b"), true);
assert.equal(annotationVisibleInLayer({ layerIds: ["a"] }, "b"), false);
assert.deepEqual(toggleAnnotationLayer(["a"], "b"), ["a", "b"]);
assert.deepEqual(toggleAnnotationLayer(["a", "b"], "a"), ["b"]);
assert.equal(toggleAnnotationLayer(["a"], "a"), undefined);

console.log("annotation-layers: 9 cases passed");
