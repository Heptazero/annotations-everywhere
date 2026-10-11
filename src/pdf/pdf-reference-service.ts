import { Menu, Notice, TFile, type App, type FileView, type Plugin } from "obsidian";
import type { PdfAnnotation } from "./annotation-types";
import type { PdfAnnotationSettings } from "./annotation-settings";
import { PdfReferenceIndex, type PdfReferenceSource } from "./pdf-reference-index";
import { openPdfReferencePicker } from "./pdf-reference-picker";
import { registerPdfReferenceLinkOpen } from "./pdf-reference-link-open";
import { resolveReferenceRegions, type PdfReferenceRegion } from "./pdf-reference-regions";
import { buildPdfReferenceSubpath, samePdfRegion, targetForAnnotation, validPdfRect, type PdfReferenceTarget } from "./pdf-reference-target";
import { configuredReferenceCopy, normalizeReferencePreferences, renderReferenceTemplate, type PdfReferenceCopyMode } from "./pdf-reference-preferences";
import { referenceSourceCounts } from "./pdf-reference-decoration";
import { computeSelectionRects } from "./selection-geom";
import type { PDFPageView } from "./pdfjs-types";

export class PdfReferenceService {
	private index: PdfReferenceIndex;
	private pickers = new Set<() => void>();
	private flashTimers = new Map<FileView, number>();
	constructor(private app: App, private owner: Plugin, private host: {
		settings(): PdfAnnotationSettings;
		invalidate(): void;
		page(pdfPath: string, page: number): PDFPageView | undefined;
		reveal(view: FileView, target: PdfReferenceTarget): boolean;
	}) { this.index = new PdfReferenceIndex(app); }

	register(): void {
		const invalidate = () => { this.index.invalidate(); this.host.invalidate(); };
		this.owner.registerEvent(this.app.metadataCache.on("changed", invalidate));
		this.owner.registerEvent(this.app.metadataCache.on("resolved", invalidate));
		this.owner.registerEvent(this.app.vault.on("delete", invalidate));
		this.owner.registerEvent(this.app.vault.on("rename", invalidate));
		registerPdfReferenceLinkOpen(this.app, this.owner, (view, target) => this.flash(view, target));
		this.owner.register(() => {
			for (const close of [...this.pickers]) close();
			for (const timer of this.flashTimers.values()) window.clearTimeout(timer);
			this.flashTimers.clear(); this.index.invalidate();
		});
	}

	regions(pdfPath: string, page: number, pageView: PDFPageView): PdfReferenceRegion[] {
		if (!this.host.settings().pdfReferenceHighlights) return [];
		return resolveReferenceRegions(this.index.forPdf(pdfPath).filter((ref) => ref.target.page === page),
			(range) => computeSelectionRects(pageView, range).map((line) => line.rect));
	}

	sources(pdfPath: string, ann: PdfAnnotation): PdfReferenceSource[] {
		const target = targetForAnnotation(pdfPath, ann);
		const pageView = this.host.page(pdfPath, ann.page);
		return this.index.forPdf(pdfPath).filter((ref) => {
			if (ref.target.page !== ann.page) return false;
			if (target.selection && ref.target.selection?.every((n, i) => n === target.selection?.[i])) return true;
			if (ref.target.rect && validPdfRect(ann.anchor) && samePdfRegion(ref.target.rect, ann.anchor)) return true;
			if (!pageView || !validPdfRect(ann.anchor)) return false;
			return resolveReferenceRegions([ref], (range) => computeSelectionRects(pageView, range).map((line) => line.rect))
				.some((region) => samePdfRegion(region.rect, ann.anchor));
		});
	}

	async copy(pdfPath: string, target: PdfReferenceTarget, quote?: string, mode?: PdfReferenceCopyMode): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(pdfPath);
			if (!(file instanceof TFile) || file.extension !== "pdf") throw new Error("引用的 PDF 不存在");
			const subpath = buildPdfReferenceSubpath(target);
			const preferences = normalizeReferencePreferences(this.host.settings());
			const chosenMode = mode ?? preferences.pdfReferenceCopyMode;
			const label = renderReferenceTemplate(preferences.pdfReferenceLinkLabel, { file: file.basename, page: String(target.page) });
			const link = this.app.fileManager.generateMarkdownLink(file, "", subpath, label || undefined);
			await navigator.clipboard.writeText(configuredReferenceCopy(preferences, chosenMode, link, quote, file.basename, target.page));
			new Notice(chosenMode !== "link" && quote?.trim() ? "已复制引文及引用链接" : "已复制引用链接");
		} catch (error) { new Notice(error instanceof Error ? error.message : "复制失败，请检查剪贴板权限"); }
	}

	copyAnnotation(pdfPath: string, ann: PdfAnnotation, mode?: PdfReferenceCopyMode): void {
		void this.copy(pdfPath, targetForAnnotation(pdfPath, ann), ann.quote, mode);
	}

	appendMenu(menu: Menu, pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		menu.addItem((item) => item.setTitle("复制引用链接").setIcon("link").onClick(() => this.copyAnnotation(pdfPath, ann, "link")));
		menu.addItem((item) => item.setTitle("复制单行引文及链接").setIcon("text").setDisabled(!ann.quote?.trim()).onClick(() => this.copyAnnotation(pdfPath, ann, "inline")));
		menu.addItem((item) => item.setTitle("复制引文及链接").setIcon("quote").setDisabled(!ann.quote?.trim()).onClick(() => this.copyAnnotation(pdfPath, ann, "quote")));
		const counts = referenceSourceCounts(this.sources(pdfPath, ann));
		if (counts.references) menu.addItem((item) => item.setTitle(`引用情况（${counts.notes} 篇笔记 · ${counts.references} 处）`).setIcon("corner-up-left").onClick(() => this.showSources(pdfPath, ann, at)));
	}

	openMenu(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		const menu = new Menu(); this.appendMenu(menu, pdfPath, ann, at); menu.showAtPosition(at);
	}

	showSources(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		const refs = this.sources(pdfPath, ann);
		if (!refs.length) { new Notice("没有笔记引用此处；粘贴链接后等待索引更新"); return; }
		for (const close of [...this.pickers]) close();
		const close = openPdfReferencePicker(this.app, refs, at, (ref) => void this.openSource(pdfPath, ref), () => this.pickers.delete(close));
		this.pickers.add(close);
	}

	async openSource(pdfPath: string, ref: PdfReferenceSource): Promise<void> {
		const current = this.index.forPdf(pdfPath).filter((item) => item.sourcePath === ref.sourcePath && item.link === ref.link)
			.sort((a, b) => Math.abs(a.line - ref.line) - Math.abs(b.line - ref.line))[0];
		const file = current ? this.app.vault.getAbstractFileByPath(current.sourcePath) : null;
		if (!(file instanceof TFile) || !current) { new Notice("这处引用已移除或笔记尚未同步"); return; }
		try {
			const existing = this.app.workspace.getLeavesOfType("markdown").find((leaf) => (leaf.view as FileView).file?.path === file.path);
			const leaf = existing ?? this.app.workspace.getLeaf("tab");
			await leaf.openFile(file, { eState: { line: current.line } });
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		} catch (error) { new Notice(error instanceof Error ? error.message : "无法打开引用笔记"); }
	}

	private flash(view: FileView, target: PdfReferenceTarget): void {
		const previous = this.flashTimers.get(view);
		if (previous !== undefined) window.clearTimeout(previous);
		const path = view.file?.path;
		let attempts = 0;
		const attempt = () => {
			this.flashTimers.delete(view);
			if (!view.containerEl.isConnected || view.file?.path !== path || ++attempts > 20) return;
			if (!this.host.reveal(view, target)) this.flashTimers.set(view, window.setTimeout(attempt, 150));
		};
		this.flashTimers.set(view, window.setTimeout(attempt, 150));
	}
}
