import { makeAnnotationId, type PdfAnnotation } from "./annotation-types";
import type { PdfRect } from "./pdf-layer";
import type { Selection } from "./selection-geom";
import type { PdfReferenceSource } from "./pdf-reference-index";
import { referenceTargetKey, samePdfRegion, validPdfRect, type PdfReferenceTarget } from "./pdf-reference-target";

export interface PdfReferenceRegion {
	target: PdfReferenceTarget;
	rect: PdfRect;
	rects: PdfRect[];
	sources: PdfReferenceSource[];
}

function union(rects: PdfRect[]): PdfRect {
	return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
}

/** Different link encodings at the same region collapse to a single rendered mark. */
export function resolveReferenceRegions(refs: PdfReferenceSource[], resolveSelection: (range: Selection) => PdfRect[]): PdfReferenceRegion[] {
	const regions: PdfReferenceRegion[] = [];
	for (const ref of [...refs].sort((a, b) => Number(!!b.target.selection) - Number(!!a.target.selection))) {
		const selectedRects = ref.target.selection ? resolveSelection(ref.target.selection).filter(validPdfRect) : [];
		const rects = selectedRects.length ? selectedRects : ref.target.rect ? [ref.target.rect] : [];
		if (!rects.length) continue; // text layer will cause a rebuild when ready
		const rect = union(rects);
		const existing = regions.find((region) => region.target.page === ref.target.page && samePdfRegion(region.rect, rect));
		if (existing) existing.sources.push(ref);
		else regions.push({ target: { ...ref.target, rect }, rect, rects, sources: [ref] });
	}
	return regions;
}

export function annotationForReferenceRegion(region: PdfReferenceRegion, annotations: PdfAnnotation[]): PdfAnnotation | undefined {
	return annotations.find((ann) => ann.page === region.target.page && validPdfRect(ann.anchor) && samePdfRegion(ann.anchor, region.rect));
}

export function referenceAnnotation(pdfPath: string, region: PdfReferenceRegion): PdfAnnotation {
	return { id: `pdf-ref:${referenceTargetKey({ page: region.target.page, rect: region.rect })}`,
		page: region.target.page, anchor: [...region.rect], anchorRects: region.rects.map((rect) => [...rect]), markOnly: true,
		textSelection: region.target.selection ? { pdfPath, page: region.target.page, range: [...region.target.selection] } : undefined,
		pinned: false, collapsed: true, side: "right", text: "", createdAt: 0, updatedAt: 0 };
}

export function isReferenceAnnotation(ann: PdfAnnotation): boolean { return ann.id.startsWith("pdf-ref:") && ann.createdAt === 0; }

/** Derivation alone never calls this. Editing explicitly promotes to a real, unique record. */
export function materializeReferenceAnnotation(ann: PdfAnnotation): PdfAnnotation {
	return isReferenceAnnotation(ann) ? { ...ann, id: makeAnnotationId(), createdAt: Date.now(), updatedAt: Date.now() } : ann;
}
