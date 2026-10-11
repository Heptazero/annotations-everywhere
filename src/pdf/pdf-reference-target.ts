import type { PdfRect } from "./pdf-layer";
import type { Selection } from "./selection-geom";

export type PdfReferenceTarget = { page: number; rect?: PdfRect; selection?: Selection };
export interface StoredTextSelection { pdfPath: string; page: number; range: Selection }

function tuple(value: unknown, integers = false): value is PdfRect {
	return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n) && (!integers || Number.isSafeInteger(n) && n >= 0));
}

export function validPdfRect(value: unknown): value is PdfRect {
	return tuple(value) && value[2] > value[0] && value[3] > value[1];
}

export function validPdfSelection(value: unknown): value is Selection {
	return tuple(value, true) && (value[2] > value[0] || value[2] === value[0] && value[3] > value[1]);
}

export function normalizeStoredTextSelection(value: unknown): StoredTextSelection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	return typeof raw.pdfPath === "string" && raw.pdfPath.trim() && Number.isSafeInteger(raw.page) && Number(raw.page) > 0 && validPdfSelection(raw.range)
		? { pdfPath: raw.pdfPath, page: Number(raw.page), range: [...raw.range] } : undefined;
}

/** Native selection= and Bilink/PDF++ rect= stay readable without a custom ID. */
export function parsePdfReferenceSubpath(subpath: string): PdfReferenceTarget | null {
	const params = new URLSearchParams(subpath.replace(/^#/, ""));
	const page = Number(params.get("page"));
	if (!Number.isSafeInteger(page) || page < 1) return null;
	const read = (key: string) => params.get(key)?.split(",").map((n) => n.trim() ? Number(n) : NaN);
	const rect = read("rect");
	const selection = read("selection");
	if (!validPdfRect(rect) && !validPdfSelection(selection)) return null;
	return { page, rect: validPdfRect(rect) ? rect : undefined, selection: validPdfSelection(selection) ? selection : undefined };
}

export function buildPdfReferenceSubpath(target: PdfReferenceTarget): string {
	if (!Number.isSafeInteger(target.page) || target.page < 1) throw new Error("引用页码无效");
	if (validPdfSelection(target.selection)) return `#page=${target.page}&selection=${target.selection.join(",")}`;
	if (!validPdfRect(target.rect)) throw new Error("批注尚未定位，请先打开对应页面再复制");
	// Preserve small regions too: rounding a tiny rectangle to zero width breaks the link.
	const [x0, y0, x1, y1] = target.rect;
	return `#page=${target.page}&rect=${[Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)].join(",")}`;
}

export function referenceTargetKey(target: PdfReferenceTarget): string {
	return buildPdfReferenceSubpath(target);
}

export function samePdfRegion(a: PdfRect, b: PdfRect, tolerance = 1): boolean {
	return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

export function targetForAnnotation(pdfPath: string, ann: { page: number; anchor: PdfRect; textSelection?: StoredTextSelection }): PdfReferenceTarget {
	const saved = ann.textSelection;
	return { page: ann.page, rect: ann.anchor, selection: saved?.pdfPath === pdfPath && saved.page === ann.page ? saved.range : undefined };
}

export function formatPdfReferenceCopy(link: string, quote: string | undefined, mode: "link" | "quote"): string {
	if (mode === "link" || !quote?.trim()) return link;
	// Text stays outside the alias, so Markdown/LaTeX is not turned into literal link text.
	return `${quote.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n")}\n> ${link}`;
}
