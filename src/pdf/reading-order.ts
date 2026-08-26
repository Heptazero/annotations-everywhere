import type { PdfAnnotation } from "./annotation-types";

type PositionedAnnotation = Pick<PdfAnnotation, "page" | "anchor">;

function leftOf(annotation: PositionedAnnotation): number {
	return Math.min(annotation.anchor[0], annotation.anchor[2]);
}

function rightOf(annotation: PositionedAnnotation): number {
	return Math.max(annotation.anchor[0], annotation.anchor[2]);
}

function topOf(annotation: PositionedAnnotation): number {
	return Math.max(annotation.anchor[1], annotation.anchor[3]);
}

function verticalThenHorizontal(a: PositionedAnnotation, b: PositionedAnnotation): number {
	return topOf(b) - topOf(a) || leftOf(a) - leftOf(b);
}

function spansColumns(annotation: PositionedAnnotation, splitX: number): boolean {
	return leftOf(annotation) < splitX - 1 && rightOf(annotation) > splitX + 1;
}

function columnOf(annotation: PositionedAnnotation, splitX: number): number {
	return (leftOf(annotation) + rightOf(annotation)) / 2 < splitX ? 0 : 1;
}

function sortColumnSegment<T extends PositionedAnnotation>(items: T[], splitX: number): T[] {
	return [...items].sort(
		(a, b) => columnOf(a, splitX) - columnOf(b, splitX) || verticalThenHorizontal(a, b)
	);
}

/**
 * Academic two-column order: full-width rows split the page into horizontal
 * bands; inside each band read the left column top-to-bottom, then the right.
 */
export function sortPageAnnotations<T extends PositionedAnnotation>(items: T[], splitX?: number): T[] {
	if (splitX === undefined || !Number.isFinite(splitX)) return [...items].sort(verticalThenHorizontal);

	const spanning = items.filter((item) => spansColumns(item, splitX)).sort(verticalThenHorizontal);
	if (spanning.length === 0) return sortColumnSegment(items, splitX);

	const regular = items.filter((item) => !spansColumns(item, splitX));
	const result: T[] = [];
	let upper = Number.POSITIVE_INFINITY;
	for (const barrier of spanning) {
		const barrierTop = topOf(barrier);
		result.push(
			...sortColumnSegment(
				regular.filter((item) => topOf(item) <= upper && topOf(item) > barrierTop),
				splitX
			)
		);
		result.push(barrier);
		upper = barrierTop;
	}
	result.push(...sortColumnSegment(regular.filter((item) => topOf(item) <= upper), splitX));
	return result;
}

/** Orders pages first, then applies the selected single/double-column order. */
export function sortAnnotationsForReading<T extends PositionedAnnotation>(items: T[], splitX?: number): T[] {
	const byPage = new Map<number, T[]>();
	for (const item of items) (byPage.get(item.page) ?? byPage.set(item.page, []).get(item.page)!).push(item);
	return [...byPage.keys()]
		.sort((a, b) => a - b)
		.flatMap((page) => sortPageAnnotations(byPage.get(page)!, splitX));
}
