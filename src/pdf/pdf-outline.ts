import { loadPdfJs, type App, type TFile } from "obsidian";
import type { PDFDocumentProxy } from "./pdfjs-types";

export interface PdfOutlineItem {
	title: string;
	page: number | null;
	/** Present only for a user-authored heading; PDF metadata has no such ID. */
	manualId?: string;
	/** Position measured from the top of the page, 0–1. */
	topRatio: number | null;
	items: PdfOutlineItem[];
}

interface PdfJsOutlineItem {
	title?: string;
	dest?: string | unknown[] | null;
	items?: PdfJsOutlineItem[];
}

interface PdfJsPage {
	view: [number, number, number, number];
}

export interface PdfOutlineDocument {
	getOutline(): Promise<PdfJsOutlineItem[] | null>;
	getDestination(name: string): Promise<unknown[] | null>;
	getPageIndex(ref: unknown): Promise<number>;
	getPage(pageNumber: number): Promise<PdfJsPage>;
	destroy(): Promise<void> | void;
}

interface PdfJsModule {
	getDocument(args: { data: ArrayBuffer }): { promise: Promise<PdfOutlineDocument> };
}

export interface NativePdfOutlineItem {
	title: string;
	dest: unknown[] | null;
	url: null;
	newWindow: false;
	color: Uint8ClampedArray;
	bold: false;
	italic: false;
	items: NativePdfOutlineItem[];
}

interface CachedOutline {
	revision: string;
	promise: Promise<PdfOutlineItem[]>;
}

function cleanTitle(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function destinationTop(dest: unknown[]): number | null {
	const mode = dest[1];
	const name = typeof mode === "object" && mode !== null && "name" in mode ? String(mode.name) : "";
	const value = name === "XYZ" ? dest[3] : name === "FitH" || name === "FitBH" ? dest[2] : name === "FitR" ? dest[5] : null;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function resolveDestination(
	doc: PdfOutlineDocument,
	dest: string | unknown[] | null | undefined,
	pageCache: Map<number, PdfJsPage>
): Promise<{ page: number | null; topRatio: number | null }> {
	try {
		const resolved = typeof dest === "string" ? await doc.getDestination(dest) : dest;
		if (!Array.isArray(resolved) || resolved.length === 0) return { page: null, topRatio: null };
		const ref = resolved[0];
		const pageIndex = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
		if (!Number.isInteger(pageIndex) || pageIndex < 0) return { page: null, topRatio: null };

		const top = destinationTop(resolved);
		if (top === null) return { page: pageIndex + 1, topRatio: null };
		let page = pageCache.get(pageIndex);
		if (!page) {
			page = await doc.getPage(pageIndex + 1);
			pageCache.set(pageIndex, page);
		}
		const [, bottom, , pageTop] = page.view;
		const height = pageTop - bottom;
		const topRatio = height > 0 ? Math.max(0, Math.min(1, (pageTop - top) / height)) : null;
		return { page: pageIndex + 1, topRatio };
	} catch {
		return { page: null, topRatio: null };
	}
}

/** Converts pdf.js's document-reference destinations into portable page positions. */
export async function resolvePdfOutline(
	doc: PdfOutlineDocument,
	raw: PdfJsOutlineItem[] | null
): Promise<PdfOutlineItem[]> {
	const pageCache = new Map<number, PdfJsPage>();
	const walk = async (source: PdfJsOutlineItem[]): Promise<PdfOutlineItem[]> => {
		const groups = await Promise.all(
			source.map(async (item) => {
				const [target, children] = await Promise.all([
					resolveDestination(doc, item.dest, pageCache),
					walk(item.items ?? []),
				]);
				const title = cleanTitle(item.title);
				if (!title) return children;
				return [{ title, ...target, items: children }];
			})
		);
		return groups.flat();
	};
	return walk(raw ?? []);
}

export function outlineHasDestination(items: PdfOutlineItem[]): boolean {
	return items.some((item) => item.page !== null || outlineHasDestination(item.items));
}

/**
 * Re-targets a portable shared outline to the PDF document currently displayed.
 * Numeric page indexes deliberately belong to the target document; copying the
 * source PDF's indirect page references makes pdf.js reject navigation.
 */
export async function toNativePdfOutline(
	items: PdfOutlineItem[],
	target: Pick<PDFDocumentProxy, "getPage" | "numPages">
): Promise<NativePdfOutlineItem[]> {
	const pageCache = new Map<number, PDFPageProxyLike>();
	const destination = async (item: PdfOutlineItem): Promise<unknown[] | null> => {
		if (item.page === null || item.page < 1) return null;
		if (target.numPages !== undefined && item.page > target.numPages) return null;
		const pageIndex = item.page - 1;
		if (item.topRatio === null) return [pageIndex, { name: "FitH" }, null];
		let page = pageCache.get(item.page);
		if (!page) {
			try {
				page = await target.getPage(item.page);
				pageCache.set(item.page, page);
			} catch {
				return [pageIndex, { name: "FitH" }, null];
			}
		}
		const [, bottom, , pageTop] = page.view;
		const top = pageTop - Math.max(0, Math.min(1, item.topRatio)) * (pageTop - bottom);
		return [pageIndex, { name: "XYZ" }, null, top, null];
	};
	const walk = async (source: PdfOutlineItem[]): Promise<NativePdfOutlineItem[]> =>
		Promise.all(
			source.map(async (item) => ({
				title: item.title,
				dest: await destination(item),
				url: null,
				newWindow: false,
				color: new Uint8ClampedArray([0, 0, 0]),
				bold: false,
				italic: false,
				items: await walk(item.items),
			}))
		);
	return walk(items);
}

interface PDFPageProxyLike {
	view: [number, number, number, number];
}

/** Reads each PDF at most once per file revision; no outline data is persisted. */
export class PdfOutlineReader {
	private cache = new Map<string, CachedOutline>();

	constructor(private app: App) {}

	read(file: TFile): Promise<PdfOutlineItem[]> {
		const revision = `${file.stat.mtime}:${file.stat.size}`;
		const cached = this.cache.get(file.path);
		if (cached?.revision === revision) return cached.promise;
		const promise = this.readFresh(file).catch((error) => {
			if (this.cache.get(file.path)?.promise === promise) this.cache.delete(file.path);
			throw error;
		});
		this.cache.set(file.path, { revision, promise });
		return promise;
	}

	private async readFresh(file: TFile): Promise<PdfOutlineItem[]> {
		const pdfjs = (await loadPdfJs()) as unknown as PdfJsModule;
		const data = await this.app.vault.readBinary(file);
		const doc = await pdfjs.getDocument({ data }).promise;
		try {
			return resolvePdfOutline(doc, await doc.getOutline());
		} finally {
			await doc.destroy();
		}
	}
}
