import type { App, TFile } from "obsidian";

export interface PdfLayoutSummary {
	pages: number;
	compatible: boolean;
	status: "compatible" | "mismatch" | "unreadable";
	reason: string;
	otherPages: number;
}

export interface PageLayout {
	width: number;
	height: number;
	rotation: number;
}

const SIZE_TOLERANCE_PT = 1;

/**
 * Reads geometry only, once, when the user asks to share coordinates. This is
 * not an identity/language fingerprint and is never cached or used to bind
 * files automatically.
 */
export async function comparePdfLayouts(app: App, current: TFile, other: TFile): Promise<PdfLayoutSummary> {
	const [a, b] = await Promise.all([readPdfLayout(app, current), readPdfLayout(app, other)]);
	return comparePageLayouts(a, b);
}

/** Indexes of the largest set compatible with one representative layout. */
export function largestCompatibleLayoutCluster(layouts: PageLayout[][]): number[] {
	let best: number[] = [];
	for (let candidate = 0; candidate < layouts.length; candidate++) {
		const cluster = layouts.flatMap((layout, index) =>
			comparePageLayouts(layouts[candidate], layout).compatible ? [index] : []
		);
		if (cluster.length > best.length) best = cluster;
	}
	return best;
}

export function comparePageLayouts(a: PageLayout[] | null, b: PageLayout[] | null): PdfLayoutSummary {
	if (!a || !b) {
		return {
			pages: a?.length ?? 0,
			otherPages: b?.length ?? 0,
			compatible: false,
			status: "unreadable",
			reason: "无法读取其中一份 PDF 的页面结构，不能加入共享批注组。",
		};
	}
	if (a.length !== b.length) {
		return {
			pages: a.length,
			otherPages: b.length,
			compatible: false,
			status: "mismatch",
			reason: `页数不同（${a.length} vs ${b.length}），不能加入共享批注组。`,
		};
	}
	for (let index = 0; index < a.length; index++) {
		const pa = a[index];
		const pb = b[index];
		if (
			Math.abs(pa.width - pb.width) > SIZE_TOLERANCE_PT ||
			Math.abs(pa.height - pb.height) > SIZE_TOLERANCE_PT ||
			pa.rotation !== pb.rotation
		) {
			return {
				pages: a.length,
				otherPages: b.length,
				compatible: false,
				status: "mismatch",
				reason: `第 ${index + 1} 页的尺寸或旋转方向不同，不能加入共享批注组。`,
			};
		}
	}
	return {
		pages: a.length,
		otherPages: b.length,
		compatible: true,
		status: "compatible",
		reason: `共 ${a.length} 页；每页尺寸和旋转方向一致，可以共享坐标批注。`,
	};
}

export async function readPdfLayout(app: App, file: TFile): Promise<PageLayout[] | null> {
	const pdfjsLib = (window as unknown as { pdfjsLib?: PdfjsLibLike }).pdfjsLib;
	if (!pdfjsLib) return null;
	let doc: PdfjsDocumentLike | null = null;
	try {
		const buffer = await app.vault.readBinary(file);
		doc = await pdfjsLib.getDocument({ data: buffer }).promise;
		const pages: PageLayout[] = [];
		for (let number = 1; number <= doc.numPages; number++) {
			const page = await doc.getPage(number);
			const [x0, y0, x1, y1] = page.view;
			pages.push({
				width: Math.abs(x1 - x0),
				height: Math.abs(y1 - y0),
				rotation: normalizeRotation(page.rotate ?? 0),
			});
		}
		return pages;
	} catch (error) {
		console.warn(`margin-notes-hz: layout check failed for ${file.path}`, error);
		return null;
	} finally {
		void doc?.destroy();
	}
}

function normalizeRotation(value: number): number {
	return ((Math.round(value) % 360) + 360) % 360;
}

interface PdfjsLibLike {
	getDocument(src: { data: ArrayBuffer }): { promise: Promise<PdfjsDocumentLike> };
}

interface PdfjsDocumentLike {
	numPages: number;
	getPage(number: number): Promise<{ view: [number, number, number, number]; rotate?: number }>;
	destroy(): void;
}
