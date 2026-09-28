import { Component, FileView } from "obsidian";
import { onPdfViewerReady } from "./pdf-layer";
import { outlineHasDestination, toNativePdfOutline, type PdfOutlineItem } from "./pdf-outline";
import type { ObsidianViewer, PDFDocumentProxy, PDFOutlineViewer } from "./pdfjs-types";

export interface SharedOutlineResult {
	sourcePath: string | null;
	items: PdfOutlineItem[];
	hasManual?: boolean;
	error?: string;
}

/**
 * Supplies a shared outline when this PDF has none, or a combined native/manual
 * outline when user headings exist. Nothing is written to the PDF; only the
 * reader's in-session outline tree is replaced.
 */
export class NativeOutlineBridge {
	private viewer: ObsidianViewer | null = null;
	private outlineViewer: PDFOutlineViewer | null = null;
	private request = 0;
	private rendering = false;
	private injectedDocument: PDFDocumentProxy | null = null;

	constructor(
		view: FileView,
		owner: Component,
		private currentPath: () => string | null,
		private lookup: (pdfPath: string) => Promise<SharedOutlineResult>,
		private hasManual: (pdfPath: string) => boolean = () => false
	) {
		onPdfViewerReady(view, owner, (viewer) => this.attach(viewer, owner));
	}

	refresh(): void {
		void this.apply(++this.request);
	}

	private attach(viewer: ObsidianViewer, owner: Component): void {
		this.viewer = viewer;
		this.outlineViewer = viewer.pdfOutlineViewer ?? null;
		const onOutlineLoaded = (event: { source?: PDFOutlineViewer; outlineCount?: number }) => {
			if (this.rendering || ((event.outlineCount ?? 0) > 0 && !this.hasManual(this.currentPath() ?? ""))) return;
			if (event.source) this.outlineViewer = event.source;
			this.refresh();
		};
		viewer.eventBus?.on("outlineloaded", onOutlineLoaded);
		owner.register(() => viewer.eventBus?.off("outlineloaded", onOutlineLoaded));
		// The native event can precede plugin attachment when a PDF tab was already
		// open. A direct check makes existing tabs and post-bind refresh deterministic.
		this.refresh();
	}

	private document(): PDFDocumentProxy | null {
		return this.viewer?.pdfViewer?.pdfDocument ?? this.viewer?.pdfDocument ?? null;
	}

	private stillCurrent(token: number, path: string, doc: PDFDocumentProxy): boolean {
		return token === this.request && path === this.currentPath() && doc === this.document();
	}

	private render(outline: unknown[] | null, doc: PDFDocumentProxy): void {
		if (!this.outlineViewer) return;
		this.rendering = true;
		try {
			const args = { outline, pdfDocument: doc };
			if (this.outlineViewer.renderTree) this.outlineViewer.renderTree(args);
			else this.outlineViewer.render?.(args);
		} finally {
			this.rendering = false;
		}
	}

	private async apply(token: number): Promise<void> {
		const path = this.currentPath();
		const doc = this.document();
		if (!path || !doc || !this.outlineViewer) return;

		let nativeOutline: unknown[] | null;
		try {
			nativeOutline = await doc.getOutline();
		} catch {
			return;
		}
		if (!this.stillCurrent(token, path, doc)) return;

		if (nativeOutline && nativeOutline.length > 0 && !this.hasManual(path)) {
			if (this.injectedDocument === doc) {
				this.injectedDocument = null;
				this.render(nativeOutline, doc);
			}
			return;
		}
		const shared = await this.lookup(path);
		if (!this.stillCurrent(token, path, doc)) return;

		if (shared.sourcePath && outlineHasDestination(shared.items) && (shared.hasManual || shared.sourcePath !== path)) {
			const outline = await toNativePdfOutline(shared.items, doc);
			if (!this.stillCurrent(token, path, doc)) return;
			this.injectedDocument = doc;
			this.render(outline, doc);
			return;
		}

		// Unbinding must remove an outline injected earlier in this same open tab.
		if (this.injectedDocument === doc) {
			this.injectedDocument = null;
			this.render(nativeOutline, doc);
		}
	}
}
