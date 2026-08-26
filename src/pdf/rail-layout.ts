import type { PdfAnnotationSettings } from "./annotation-settings";
import type { MarginSide } from "./annotation-types";
import type { PageBox } from "./page-geometry";

export const MIN_RAIL_WIDTH_PT = 50;
export const MIN_RAIL_GAP_PT = 8;

export function railWidthPt(settings: PdfAnnotationSettings, side: MarginSide): number {
	return Math.max(MIN_RAIL_WIDTH_PT, side === "right" ? settings.railWidthRight : settings.railWidthLeft);
}

export function railGapPt(settings: PdfAnnotationSettings, side: MarginSide): number {
	return side === "right" ? settings.railGapRight : settings.railGapLeft;
}

export function railLeft(side: MarginSide, box: PageBox, widthPx: number, gapPx: number): number {
	return side === "right" ? box.left + box.width + gapPx : box.left - widthPx - gapPx;
}

export function railCollisionGapPx(unit: number): number {
	return MIN_RAIL_GAP_PT * unit;
}
