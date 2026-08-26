// Mirrored from everything-bilink/src/pdfjs-types.ts (undocumented Obsidian/pdf.js
// internals — if a future Obsidian upgrade breaks this chain, fix both copies).
//
// Minimal ambient types for Obsidian's bundled PDF.js integration. These are
// undocumented internals (not published as a types package); shapes below are the
// subset this plugin actually touches, confirmed against pdf.js's own
// PDFPageView/PDFViewer/EventBus behavior.

export interface PDFPageViewport {
	width: number;
	height: number;
	scale: number;
	rotation: number;
}

export interface PDFPageProxy {
	// [x0, y0, x1, y1] in PDF points, unrotated page box — origin bottom-left.
	view: [number, number, number, number];
}

export interface PDFDocumentProxy {
	numPages?: number;
	getOutline(): Promise<unknown[] | null>;
	getPage(pageNumber: number): Promise<PDFPageProxy>;
}

export interface TextLayerInfo {
	textDivs: HTMLElement[];
	textContentItems: { str: string }[];
}

export interface PDFPageView {
	div: HTMLDivElement;
	pdfPage: PDFPageProxy;
	viewport: PDFPageViewport;
	// Screen-pixel (page-relative) -> PDF point coordinates.
	getPagePoint(x: number, y: number): [number, number];
	// Obsidian's TextLayerBuilder; shape differs across Obsidian/pdf.js versions —
	// always unwrap via getTextLayerInfo() rather than reading fields directly.
	textLayer?: unknown;
}

export interface PDFEventBus {
	on(name: string, cb: (data: any) => void): void;
	off(name: string, cb: (data: any) => void): void;
}

export interface PDFViewer {
	_pages: PDFPageView[];
	eventBus: PDFEventBus;
	pdfDocument?: PDFDocumentProxy;
	getPageView(index: number): PDFPageView | undefined;
	currentPageNumber: number;
}

export interface PDFOutlineViewer {
	/** pdf.js 4/5 and current Obsidian (1.13.x). */
	renderTree?(args: { outline: unknown[] | null; pdfDocument: PDFDocumentProxy }): void;
	/** Older pdf.js bundled by earlier Obsidian releases. */
	render?(args: { outline: unknown[] | null; pdfDocument: PDFDocumentProxy }): void;
}

// Obsidian's wrapper around the real pdf.js PDFViewerApplication-like object.
export interface ObsidianViewer {
	pdfViewer: PDFViewer;
	pdfDocument?: PDFDocumentProxy;
	pdfOutlineViewer?: PDFOutlineViewer;
	eventBus: PDFEventBus;
}

export interface PDFViewerChild {
	pdfViewer: ObsidianViewer;
	file: unknown;
}

export interface PDFViewerComponent {
	child?: PDFViewerChild;
	then(cb: (child: PDFViewerChild) => void): void;
}
