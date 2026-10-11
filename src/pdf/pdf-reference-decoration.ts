import { setIcon } from "obsidian";
import type { PdfReferencePreferences } from "./pdf-reference-preferences";
import type { PdfReferenceSource } from "./pdf-reference-index";

export function referenceSourceCounts(refs: readonly PdfReferenceSource[]): { notes: number; references: number } {
	return { notes: new Set(refs.map((ref) => ref.sourcePath)).size, references: refs.length };
}
export function decorateReferenceBands(bands: HTMLElement[], settings: PdfReferencePreferences): void {
	if (settings.pdfReferencedStyle !== "none") for (const band of bands) band.addClass(`is-referenced-${settings.pdfReferencedStyle}`);
}
/** One small pointer-enabled control, outside the pointer-inert highlight itself. */
export function renderReferenceIndicator(parent: HTMLElement, rect: { x1: number; y0: number; y1: number }, refs: PdfReferenceSource[], open: (at: { x: number; y: number }) => void): HTMLElement {
	const { notes, references } = referenceSourceCounts(refs);
	const label = `${notes} 篇笔记 · ${references} 处引用`;
	const button = parent.createEl("button", { cls: "margin-notes-pdf-reference-indicator", attr: { type: "button", "aria-label": `查看引用：${label}`, title: label } });
	setIcon(button, "corner-up-left");
	button.setCssStyles({ left: `${rect.x1 + 4}px`, top: `${(rect.y0 + rect.y1) / 2}px` });
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault(); event.stopPropagation();
		const bounds = button.getBoundingClientRect();
		open({ x: bounds.left, y: bounds.bottom });
	});
	return button;
}
