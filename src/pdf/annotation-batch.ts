import type { PageLayout } from "./layout-check";
import { makeAnnotationId, type PdfAnnotation } from "./annotation-types";
import type { PdfRect } from "./pdf-layer";

export type AnnotationTransferMode = "copy" | "move";

export interface PageRangeMapping {
	sourceFrom: number;
	sourceTo: number;
	targetFrom: number;
}

export interface AnnotationSelectionRef {
	pdfPath: string;
	id: string;
}

export interface PreparedAnnotationTransfer {
	sourceIds: string[];
	annotations: PdfAnnotation[];
}

function mappedPage(page: number, mappings: readonly PageRangeMapping[]): number | null {
	const matches = mappings.filter((mapping) => page >= mapping.sourceFrom && page <= mapping.sourceTo);
	if (matches.length !== 1) return null;
	return matches[0].targetFrom + page - matches[0].sourceFrom;
}

function scaleRect(rect: PdfRect, scaleX: number, scaleY: number): PdfRect {
	if (rect.every((value) => value === 0)) return [0, 0, 0, 0];
	return [rect[0] * scaleX, rect[1] * scaleY, rect[2] * scaleX, rect[3] * scaleY];
}

export function validatePageMappings(mappings: readonly PageRangeMapping[]): string | null {
	if (mappings.length === 0) return "请至少添加一组页码对应关系";
	for (const mapping of mappings) {
		if (![mapping.sourceFrom, mapping.sourceTo, mapping.targetFrom].every(Number.isInteger) ||
			mapping.sourceFrom < 1 || mapping.sourceTo < mapping.sourceFrom || mapping.targetFrom < 1) {
			return "页码对应关系无效";
		}
	}
	for (let i = 0; i < mappings.length; i++) {
		for (let j = i + 1; j < mappings.length; j++) {
			if (mappings[i].sourceFrom <= mappings[j].sourceTo && mappings[j].sourceFrom <= mappings[i].sourceTo) {
				return "原 PDF 的页码范围不能重叠";
			}
		}
	}
	return null;
}

/** Creates independent records and scales PDF-point anchors for the target page. */
export function prepareAnnotationTransfer(
	annotations: PdfAnnotation[],
	mappings: readonly PageRangeMapping[],
	sourceLayout: PageLayout[],
	targetLayout: PageLayout[],
	now = Date.now()
): PreparedAnnotationTransfer {
	const mappingError = validatePageMappings(mappings);
	if (mappingError) throw new Error(mappingError);
	const transferred: PdfAnnotation[] = [];
	for (const annotation of annotations) {
		const targetPage = mappedPage(annotation.page, mappings);
		if (targetPage === null) throw new Error(`第 ${annotation.page} 页的批注没有对应的目标页`);
		const sourcePage = sourceLayout[annotation.page - 1];
		const targetPageLayout = targetLayout[targetPage - 1];
		if (!sourcePage) throw new Error(`原 PDF 没有第 ${annotation.page} 页`);
		if (!targetPageLayout) throw new Error(`目标 PDF 没有第 ${targetPage} 页`);
		if (sourcePage.rotation !== targetPageLayout.rotation) {
			throw new Error(`原第 ${annotation.page} 页与目标第 ${targetPage} 页旋转方向不同`);
		}
		const scaleX = targetPageLayout.width / sourcePage.width;
		const scaleY = targetPageLayout.height / sourcePage.height;
		transferred.push({
			...annotation,
			id: makeAnnotationId(),
			page: targetPage,
			anchor: scaleRect(annotation.anchor, scaleX, scaleY),
			anchorRects: annotation.anchorRects?.map((rect) => scaleRect(rect, scaleX, scaleY)),
			layerIds: annotation.layerIds ? [...annotation.layerIds] : undefined,
			offsetY: annotation.offsetY === undefined ? undefined : annotation.offsetY * scaleY,
			updatedAt: now,
		});
	}
	return { sourceIds: annotations.map((annotation) => annotation.id), annotations: transferred };
}
