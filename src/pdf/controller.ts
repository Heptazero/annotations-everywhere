import { Component, FileView, Menu, Notice, Platform, TFile, type App, type Plugin } from "obsidian";
import { patchPluginData } from "../plugin-data";
import { anchorFromActiveSelection } from "./annotation-anchor";
import { AnnotationLayer } from "./annotation-layer";
import { appendAnnotationLayerMenuItems, appendLayerFilterMenuItems } from "./annotation-layer-menus";
import { AnnotationLayerPicker } from "./annotation-layer-picker";
import { compatibleRecoverySources, type OrphanedAnnotationSource } from "./annotation-recovery";
import { AnnotationRecoveryPicker } from "./annotation-recovery-picker";
import type { AnnotationStatusSummary } from "./annotation-status";
import {
	prepareAnnotationTransfer,
	type AnnotationSelectionRef,
	type AnnotationTransferMode,
	type PageRangeMapping,
} from "./annotation-batch";
import {
	applyPdfAnnotationStyleSettings,
	clearPdfAnnotationStyleSettings,
	DEFAULT_PDF_ANNOTATION_SETTINGS,
	loadPdfAnnotationSettings,
	type PdfAnnotationSettings,
} from "./annotation-settings";
import { HighlightModePicker } from "./highlight-mode-picker";
import { PdfAnnotationStore, resolveDataFilePath } from "./annotation-store";
import { makeAnnotationId, type MarginSide, type PdfAnnotation } from "./annotation-types";
import { openMarkPopover, type MarkPopoverHandle } from "./mark-popover";
import { comparePdfLayouts, largestCompatibleLayoutCluster, readPdfLayout } from "./layout-check";
import { NativeOutlineBridge, type SharedOutlineResult } from "./native-outline-bridge";
import { combineOutlines, type ManualOutlineEntry } from "./manual-outline";
import { ManualOutlineModal } from "./manual-outline-modal";
import { PairDecisionModal, type PairDecision } from "./pair-decision-modal";
import { isPdf, pairingCandidates as listPairingCandidates } from "./pairing";
import { currentPdfPageInfo, getActivePDFView, onPageReady, onScaleChanging, onTextLayerReady, type PdfRect } from "./pdf-layer";
import { outlineHasDestination, PdfOutlineReader, type PdfOutlineItem } from "./pdf-outline";
import { sortAnnotationsForReading } from "./reading-order";
import { SharedFileLifecycle } from "./shared-file-lifecycle";
import { SourceAnnotationSync } from "./source-annotation-sync";
import type { PDFPageView } from "./pdfjs-types";
import { attachRectSelectListener, type RectSelectController } from "./rect-select";
import { findScrollAncestor } from "./scroll-container";

/** How long to wait for the target page to render before correcting scroll
 * position and fading back in — in the same ballpark as revealAnnotation's
 * own 350ms wait, both guessing at pdf.js's render latency. */
const SWITCH_SETTLE_MS = 380;
/** Let sync/download writes settle before reading the PDF binary. */
const SHARED_LAYOUT_RECHECK_DELAY_MS = 800;

/** How a newly created note should appear. */
export interface NewNoteForm {
	pinned: boolean;
	side: MarginSide;
	collapsed: boolean;
}

type PendingPlacement = { kind: "note"; form: NewNoteForm } | { kind: "mark" };

interface ViewState {
	pages: Map<number, PDFPageView>;
	layer: AnnotationLayer;
	currentPath: () => string | null;
	outlineBridge: NativeOutlineBridge;
}

/**
 * Owns the PDF-annotation feature end to end: scans open PDF views, tracks their
 * pages, places new notes, and keeps each view's annotation layer up to date.
 */
export class PdfAnnotationsController {
	readonly store: PdfAnnotationStore;
	readonly annotationPropertySync: SourceAnnotationSync;
	settings: PdfAnnotationSettings = DEFAULT_PDF_ANNOTATION_SETTINGS;

	private rectSelect: RectSelectController = { armed: false };
	private pendingPlacement: PendingPlacement | null = null;
	private pendingMarkPopover: { handle: MarkPopoverHandle; view: FileView | null } | null = null;
	/** Set while waiting for the user to point at a new highlight for an existing note. */
	private pendingReanchor: { pdfPath: string; id: string } | null = null;
	private states = new WeakMap<FileView, ViewState>();
	private tracked = new WeakSet<FileView>();
	/**
	 * The PDF view to act on. Tracked separately from "the active view" because
	 * the annotation list panel becomes the active view the moment it's clicked —
	 * asking Obsidian for the active PDF at that point returns nothing, which is
	 * why the panel used to blank out and its rows did nothing.
	 */
	private lastPdfView: FileView | null = null;
	/** Session-only view state. Null means no layer filter. */
	private activeLayerId: string | null = null;
	private outlineReader: PdfOutlineReader;
	private layoutRecheckTimers = new Map<string, number>();
	private lateSyncTimer: number | null = null;
	private lastJournalError: string | null = null;
	private fileLifecycle: SharedFileLifecycle;

	constructor(
		private plugin: Plugin,
		private app: App
	) {
		this.store = new PdfAnnotationStore(app, plugin);
		this.annotationPropertySync = new SourceAnnotationSync(app, this.store, () => this.settings);
		this.outlineReader = new PdfOutlineReader(app);
		this.fileLifecycle = new SharedFileLifecycle({
			app,
			plugin,
			store: this.store,
			getDoubleColumnSplits: () => this.settings.doubleColumnSplits,
			setDoubleColumnSplits: (next) => this.patchSettings({ doubleColumnSplits: next }),
			refreshOutlines: () => this.refreshNativeOutlines(),
			onPdfModified: (path) => this.queueSharedLayoutRecheck(path),
		});
	}

	async onload(): Promise<void> {
		this.settings = await loadPdfAnnotationSettings(this.plugin);
		applyPdfAnnotationStyleSettings(this.settings);
		this.plugin.register(() => clearPdfAnnotationStyleSettings());

		try {
			await this.store.load(this.settings.dataPath);
		} catch (e) {
			new Notice(String(e instanceof Error ? e.message : e));
			throw e;
		}
		if (this.store.waitingForRevisionFiles) new Notice("分文件批注仍在同步；基线到达前已暂停写入", 9000);
		this.lastJournalError = this.store.journalError;
		if (resolveDataFilePath(this.settings.dataPath) !== this.store.filePath) {
			this.settings = {
				...this.settings,
				dataPath: this.store.filePath.slice(0, this.store.filePath.lastIndexOf("/")),
			};
		}
		this.store.migrateColorKeys(this.settings.palette);
		// Persist the normalized object palette even when every legacy literal
		// matched an existing slot. This removes the old string[] settings shape,
		// rather than merely normalizing it again on every launch.
		await patchPluginData(this.plugin, { pdfAnnotationSettings: this.settings });
		if (this.store.legacyGroupsDowngraded > 0) {
			new Notice(
				`旧版的 ${this.store.legacyGroupsDowngraded} 组「仅关联」已解除;各文件批注都保留,重新加入共享组即可检查版式后共用。`,
				9000
			);
		}
		// Any mutation from anywhere — including the list panel, which owns no
		// layer of its own — has to reach the on-page rendering. Without this,
		// deleting or editing a note in the panel updated the panel and the file
		// but left the note sitting on the PDF until the next page render.
		// (Layer rebuilds are debounced and skip while a note is being dragged or
		// edited, so the extra churn from in-layer edits is harmless.)
		this.plugin.register(this.store.onChange(() => {
			const error = this.store.journalError;
			if (error && error !== this.lastJournalError) new Notice(`批注保存未完成：${error}`, 12000);
			this.lastJournalError = error;
			this.rebuildAll();
			this.annotationPropertySync.queue();
		}));
		const queueLateSync = (file: { path: string }): void => {
			const oldDefaultReceivingPortableFile = this.store.filePath === ".margin-notes-hz/annotations.json" &&
				file.path === resolveDataFilePath(DEFAULT_PDF_ANNOTATION_SETTINGS.dataPath);
			const dataFolder = this.store.filePath.slice(0, this.store.filePath.lastIndexOf("/"));
			const revisionFile = file.path.startsWith(`${dataFolder}/revisions/`);
			if (file.path !== this.store.filePath && !oldDefaultReceivingPortableFile && !revisionFile) return;
			if (this.lateSyncTimer !== null) window.clearTimeout(this.lateSyncTimer);
			this.lateSyncTimer = window.setTimeout(() => {
				this.lateSyncTimer = null;
				if (revisionFile) {
					void (this.store.usesRevisionFiles
						? this.store.refreshRevisionFiles()
						: this.store.loadLateRevisionFiles()).then((loaded) => {
						if (!loaded) return;
						const conflicts = this.store.journalConflicts.length + Number(this.store.hasJournalMetadataConflict);
						if (conflicts > 0) new Notice(`批注同步有 ${conflicts} 处冲突，请运行「查看批注同步冲突」`, 9000);
					}).catch((error) => new Notice(String(error instanceof Error ? error.message : error)));
					return;
				}
				void this.store.loadLateSyncedFile(file.path).then(async (loaded) => {
					if (!loaded) return;
					if (resolveDataFilePath(this.settings.dataPath) !== this.store.filePath) {
						this.settings = {
							...this.settings,
							dataPath: this.store.filePath.slice(0, this.store.filePath.lastIndexOf("/")),
						};
						await patchPluginData(this.plugin, { pdfAnnotationSettings: this.settings });
					}
					this.store.migrateColorKeys(this.settings.palette);
					new Notice(`已读取同步批注：${this.store.totalAnnotationCount} 条`);
				}).catch((error) => new Notice(String(error instanceof Error ? error.message : error)));
			}, 350);
		};
		this.plugin.registerEvent(this.app.vault.on("create", queueLateSync));
		this.plugin.registerEvent(this.app.vault.on("modify", queueLateSync));
		this.plugin.registerEvent(this.app.vault.on("delete", queueLateSync));
		this.plugin.register(() => {
			if (this.lateSyncTimer !== null) window.clearTimeout(this.lateSyncTimer);
		});
		this.plugin.registerEvent(this.app.metadataCache.on("changed", (file) => {
			if (file.extension === "md") this.annotationPropertySync.queue();
		}));
		this.plugin.register(() => this.annotationPropertySync.dispose());
		this.fileLifecycle.register();

		this.app.workspace.onLayoutReady(() => {
			this.scanPDFViews();
			void this.recheckChangedSharedFiles();
			this.fileLifecycle.onLayoutReady();
			this.annotationPropertySync.queue();
		});
		this.plugin.register(() => {
			for (const timer of this.layoutRecheckTimers.values()) window.clearTimeout(timer);
			this.layoutRecheckTimers.clear();
			this.closePendingMarkPopover();
		});
		this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.scanPDFViews()));
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.scanPDFViews();
				this.targetPdfView(); // refresh the remembered PDF while one has focus
			})
		);
		// The rail is positioned against the visible width of the pane, so a pane
		// resize moves it; pdf.js doesn't necessarily re-render pages for that.
		this.plugin.registerEvent(this.app.workspace.on("resize", () => this.rebuildAll()));
	}

	async saveSettings(next: PdfAnnotationSettings): Promise<void> {
		const previous = this.settings;
		const pathChanged = next.dataPath !== this.settings.dataPath;
		await patchPluginData(this.plugin, { pdfAnnotationSettings: next });
		try {
			if (pathChanged) await this.store.relocate(next.dataPath);
		} catch (error) {
			await patchPluginData(this.plugin, { pdfAnnotationSettings: previous });
			throw error;
		}
		this.settings = next;
		if (this.activeLayerId && !next.layers.some((layer) => layer.id === this.activeLayerId)) {
			this.activeLayerId = null;
		}
		applyPdfAnnotationStyleSettings(this.settings);
		this.store.notifyAppearanceChanged();
	}

	/** Partial update used by in-canvas affordances (e.g. dragging the rail wider). */
	patchSettings(patch: Partial<PdfAnnotationSettings>): void {
		void this.saveSettings({ ...this.settings, ...patch });
	}

	/**
	 * Undo/redo for annotation edits. Reported back so the command can decline
	 * the keystroke when there is nothing to undo — see main.ts for why that
	 * matters for a shortcut as heavily shared as Cmd+Z.
	 */
	undo(): boolean {
		const ok = this.store.undo();
		if (!ok) new Notice("没有可撤销的批注修改");
		return ok;
	}

	redo(): boolean {
		const ok = this.store.redo();
		if (!ok) new Notice("没有可重做的批注修改");
		return ok;
	}

	/** A suggester, not a floating menu — see HighlightModePicker. */
	chooseHighlightMode(): void {
		new HighlightModePicker(this.app, this.settings.highlightMode, (mode) =>
			this.patchSettings({ highlightMode: mode })
		).open();
	}

	get annotationLayerFilter(): string | null {
		return this.activeLayerId;
	}

	get activeAnnotationLayerName(): string {
		return this.settings.layers.find((layer) => layer.id === this.activeLayerId)?.name ?? "全部";
	}

	setAnnotationLayerFilter(layerId: string | null): void {
		const next = layerId && this.settings.layers.some((layer) => layer.id === layerId) ? layerId : null;
		if (next === this.activeLayerId) return;
		this.activeLayerId = next;
		this.store.notifyAppearanceChanged();
	}

	chooseAnnotationLayer(): void {
		new AnnotationLayerPicker(this.app, this.settings.layers, this.activeLayerId, (id) =>
			this.setAnnotationLayerFilter(id)
		).open();
	}

	/** Current PDF and every member sharing its page layout use the same list order. */
	toggleDoubleColumnOrder(): void {
		const file = this.currentPdfTarget();
		if (!file) return;
		const members = this.store.sharedMembers(file.path);
		const paths = members.length > 0 ? members : [file.path];
		const currentSplit = paths.map((path) => this.settings.doubleColumnSplits[path]).find((value) => value !== undefined);
		const next = { ...this.settings.doubleColumnSplits };
		if (currentSplit !== undefined) {
			for (const path of paths) delete next[path];
			this.patchSettings({ doubleColumnSplits: next });
			new Notice("当前论文的批注阅读顺序已设为单栏：从上到下");
			return;
		}

		const split = this.visiblePageMidpoint(file.path);
		if (split === null) {
			new Notice("PDF 页面仍在加载；显示出页面后再运行一次双栏排序命令");
			return;
		}
		for (const path of paths) next[path] = split;
		this.patchSettings({ doubleColumnSplits: next });
		new Notice(paths.length > 1 ? `共享组已设为双栏阅读顺序（${paths.length} 份 PDF）` : "当前论文已设为双栏阅读顺序");
	}

	isDoubleColumnOrder(pdfPath: string): boolean {
		return this.doubleColumnSplit(pdfPath) !== undefined;
	}

	sortAnnotations(pdfPath: string, annotations: PdfAnnotation[]): PdfAnnotation[] {
		return sortAnnotationsForReading(annotations, this.doubleColumnSplit(pdfPath));
	}

	private doubleColumnSplit(pdfPath: string): number | undefined {
		const direct = this.settings.doubleColumnSplits[pdfPath];
		if (direct !== undefined) return direct;
		for (const member of this.store.sharedMembers(pdfPath)) {
			const shared = this.settings.doubleColumnSplits[member];
			if (shared !== undefined) return shared;
		}
		return undefined;
	}

	private visiblePageMidpoint(pdfPath: string): number | null {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const state = this.states.get(leaf.view as FileView);
			if (!state || state.currentPath() !== pdfPath) continue;
			const page = state.pages.values().next().value as PDFPageView | undefined;
			if (!page?.pdfPage?.view) continue;
			const [left, , right] = page.pdfPage.view;
			return (left + right) / 2;
		}
		return null;
	}

	openLayerFilterMenu(at: { x: number; y: number }): void {
		const menu = new Menu();
		appendLayerFilterMenuItems(menu, this.settings.layers, this.activeLayerId, (id) =>
			this.setAnnotationLayerFilter(id)
		);
		menu.showAtPosition(at);
	}

	openAnnotationLayerMenu(pdfPath: string, ann: PdfAnnotation, at: { x: number; y: number }): void {
		const menu = new Menu();
		appendAnnotationLayerMenuItems(menu, this.settings.layers, ann, (next) => {
			const current = this.store.forFile(pdfPath).find((item) => item.id === ann.id);
			if (!current) return;
			current.layerIds = next;
			current.updatedAt = Date.now();
			this.store.upsert(pdfPath, current);
		});
		menu.showAtPosition(at);
	}

	/**
	 * The PDF view to act on: the active one if a PDF has focus, otherwise the
	 * last PDF that did — as long as it's still open somewhere.
	 */
	private targetPdfView(): FileView | null {
		const active = getActivePDFView(this.app);
		if (active) {
			this.lastPdfView = active;
			return active;
		}
		const pdfLeaves = this.app.workspace.getLeavesOfType("pdf");
		const stillOpen = pdfLeaves.some((l) => l.view === this.lastPdfView);
		if (!stillOpen) this.lastPdfView = null;
		// Mobile can open the side panel as the active leaf before any PDF focus
		// event has populated lastPdfView. One open PDF is unambiguous.
		if (!this.lastPdfView && pdfLeaves.length === 1 && pdfLeaves[0].view instanceof FileView) {
			this.lastPdfView = pdfLeaves[0].view;
		}
		return this.lastPdfView;
	}

	/** The PDF the panel should be showing. */
	currentPdfTarget(): TFile | null {
		const file = this.targetPdfView()?.file;
		return file instanceof TFile && file.extension === "pdf" ? file : null;
	}

	hasActivePDFView(): boolean {
		return !!getActivePDFView(this.app);
	}

	/** Also true while the annotation list has focus but its source PDF remains open. */
	hasPdfTarget(): boolean {
		return !!this.currentPdfTarget();
	}

	canLeaveSharedGroup(): boolean {
		const file = this.currentPdfTarget();
		return !!file && this.store.isPaired(file.path);
	}

	/** Deduplicated global overview; a shared group appears only once. */
	annotationStatusSummaries(): AnnotationStatusSummary[] {
		const existingPaths = new Set(
			this.app.vault
				.getFiles()
				.filter((candidate) => candidate.extension.toLowerCase() === "pdf")
				.map((candidate) => candidate.path)
		);
		return this.store.annotationStatusSummaries(existingPaths);
	}

	/** Every live PDF except paths resolving to the selected source bucket. */
	annotationTransferTargets(sourcePath: string): string[] {
		return this.app.vault.getFiles()
			.filter((candidate) => candidate.extension.toLowerCase() === "pdf")
			.map((candidate) => candidate.path)
			.filter((path) => !this.store.sameAnnotationBucket(sourcePath, path))
			.sort((a, b) => a.localeCompare(b, "zh-CN"));
	}

	deleteAnnotations(refs: readonly AnnotationSelectionRef[]): number {
		if (this.store.waitingForRevisionFiles) throw new Error("批注数据仍在等待同步，暂不能批量删除");
		return this.store.deleteAnnotations(refs);
	}

	async transferAnnotations(
		sourcePath: string,
		annotationIds: readonly string[],
		targetPath: string,
		mode: AnnotationTransferMode,
		mappings: readonly PageRangeMapping[]
	): Promise<number> {
		if (this.store.waitingForRevisionFiles) throw new Error("批注数据仍在等待同步，暂不能复制或移动");
		if (this.store.sameAnnotationBucket(sourcePath, targetPath)) {
			throw new Error("来源与目标属于同一个共享批注组");
		}
		const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
		const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
		if (!isPdf(sourceFile)) throw new Error("来源 PDF 已不存在，无法换算批注位置");
		if (!isPdf(targetFile)) throw new Error("目标 PDF 已不存在");

		const [sourceLayout, targetLayout] = await Promise.all([
			readPdfLayout(this.app, sourceFile),
			readPdfLayout(this.app, targetFile),
		]);
		if (!sourceLayout || !targetLayout) throw new Error("无法读取来源或目标 PDF 的页面尺寸");
		const ids = new Set(annotationIds);
		const annotations = this.store.forFile(sourcePath).filter((annotation) => ids.has(annotation.id));
		if (annotations.length !== ids.size) throw new Error("所选批注已经变化，请重新选择");
		const prepared = prepareAnnotationTransfer(annotations, mappings, sourceLayout, targetLayout, Date.now());
		return this.store.applyAnnotationTransfer(
			sourcePath,
			targetPath,
			prepared.sourceIds,
			prepared.annotations,
			mode
		);
	}

	/**
	 * Recovers annotations left under a vanished path after the user reorganised
	 * or restored a PDF outside Obsidian. Page numbers rule out impossible
	 * sources; filename resemblance only ranks the manual choices.
	 */
	async chooseOrphanedAnnotationRecovery(): Promise<void> {
		const file = this.currentPdfTarget();
		if (!file) return;
		const checking = new Notice("正在读取当前 PDF 页数…", 0);
		const layout = await readPdfLayout(this.app, file);
		checking.hide();
		if (!layout) {
			new Notice("无法读取当前 PDF 的页面结构，暂不能筛选旧批注");
			return;
		}

		const existingPaths = new Set(
			this.app.vault
				.getFiles()
				.filter((candidate) => candidate.extension.toLowerCase() === "pdf")
				.map((candidate) => candidate.path)
		);
		const all = this.store.orphanedAnnotationSources(existingPaths);
		const candidates = compatibleRecoverySources(file.path, layout.length, all);
		if (candidates.length === 0) {
			new Notice(
				all.length === 0
					? "没有未挂载的批注记录"
					: `没有页码兼容的旧批注记录（当前 PDF 共 ${layout.length} 页）`
			);
			return;
		}

		new AnnotationRecoveryPicker(this.app, candidates, layout.length, (source) =>
			this.applyOrphanedAnnotationRecovery(file.path, source)
		).open();
	}

	private applyOrphanedAnnotationRecovery(targetPath: string, source: OrphanedAnnotationSource): void {
		if (!isPdf(this.app.vault.getAbstractFileByPath(targetPath))) {
			new Notice("当前 PDF 已移动或删除，请重新打开后再恢复批注");
			return;
		}
		if (this.app.vault.getAbstractFileByPath(source.path)) {
			new Notice("旧路径已经重新出现，未移动其批注");
			return;
		}
		const recovered = this.store.recoverOrphanedAnnotations(source.path, targetPath);
		if (!recovered) {
			new Notice("这份旧批注已经被恢复或重新关联");
			return;
		}

		const split = this.settings.doubleColumnSplits[source.path];
		if (split !== undefined) {
			const next = { ...this.settings.doubleColumnSplits };
			delete next[source.path];
			if (next[targetPath] === undefined) next[targetPath] = split;
			this.patchSettings({ doubleColumnSplits: next });
		}
		const merged = recovered.previousTargetCount > 0;
		new Notice(
			merged
				? `已合并恢复 ${recovered.sourceCount} 条旧批注；当前共有 ${recovered.resultCount} 条`
				: `已恢复 ${recovered.resultCount} 条批注到当前 PDF`
		);
	}

	/**
	 * Starts placing a note: anchors to the active text selection if there is
	 * one, otherwise arms a one-shot drag so the user can box the region the note
	 * refers to.
	 */
	addNote(form: NewNoteForm): void {
		const sel = anchorFromActiveSelection();
		if (sel) {
			const quote = window.getSelection()?.toString().trim();
			this.place(sel.file.path, sel.pageNumber, sel.rect, form, quote || undefined, sel.rects);
			return;
		}
		this.pendingPlacement = { kind: "note", form };
		this.rectSelect.armed = true;
		new Notice("在 PDF 上拖一个框,标出这条批注指的位置");
	}

	/**
	 * Creates a persistent highlight without a note card. A native PDF text
	 * selection wins and supplies searchable quote text; otherwise the same
	 * one-shot rectangle tool handles equations, figures and scanned content
	 * without requiring OCR.
	 */
	addMarkOnly(): void {
		this.pendingPlacement = null;
		this.pendingReanchor = null;
		this.rectSelect.armed = false;
		const sel = anchorFromActiveSelection();
		if (sel) {
			const quote = window.getSelection()?.toString().trim();
			this.showMarkPalette(sel.file.path, sel.pageNumber, sel.pageView, sel.rect, quote || undefined, sel.rects, sel.view);
			return;
		}
		this.pendingPlacement = { kind: "mark" };
		this.rectSelect.armed = true;
		new Notice("在 PDF 上拖框勾画公式、图形或没有可选文字的区域");
	}

	/** Choosing a colour completes creation; dismissing this palette writes nothing. */
	private showMarkPalette(
		pdfPath: string,
		pageNumber: number,
		pageView: PDFPageView,
		rect: PdfRect,
		quote?: string,
		anchorRects?: PdfRect[],
		view: FileView | null = getActivePDFView(this.app)
	): void {
		this.closePendingMarkPopover();
		const anchor = anchorRects?.at(-1) ?? rect;
		const pageBox = pageView.div.getBoundingClientRect();
		const [ax, ay] = pageView.viewport.convertToViewportPoint(anchor[0], anchor[1]);
		const [bx, by] = pageView.viewport.convertToViewportPoint(anchor[2], anchor[3]);
		const handle = openMarkPopover({
			app: this.app,
			mode: "create",
			at: { x: pageBox.left + Math.max(ax, bx) + 6, y: pageBox.top + Math.min(ay, by) },
			swatches: this.settings.palette,
			quote,
			onPickColor: (colorKey) => {
				if (!pageView.div.isConnected || (view && view.file?.path !== pdfPath)) return;
				this.placeMark(pdfPath, pageNumber, rect, quote, anchorRects, colorKey);
			},
			onClose: () => {
				if (this.pendingMarkPopover?.handle === handle) this.pendingMarkPopover = null;
			},
		});
		if (handle) this.pendingMarkPopover = { handle, view };
	}

	private closePendingMarkPopover(view?: FileView): void {
		if (this.pendingMarkPopover && (!view || this.pendingMarkPopover.view === view)) {
			this.pendingMarkPopover.handle.close();
			this.pendingMarkPopover = null;
		}
	}

	/**
	 * Re-points an existing note's highlight, by the same two routes as creating
	 * one: an active text selection wins if there is one, otherwise a one-shot
	 * box drag is armed. Needed because a highlight can end up wrong without the
	 * user having done anything — a quote that never matched the page's text
	 * layer, or one written against the other language of a translation pair —
	 * and until now there was no way to correct it from the UI at all.
	 *
	 * Also clears `quote`: once a human has pointed at the real region, that rect
	 * is the truth, and leaving a stale quote behind would let a later
	 * re-resolution silently overwrite the correction.
	 */
	reanchor(pdfPath: string, ann: PdfAnnotation): void {
		const sel = anchorFromActiveSelection();
		if (sel) {
			// Selected TEXT carries something a dragged box never can: the words
			// themselves. Storing them as `quote` is what lets this highlight be
			// re-found — on a re-flowed render, and above all on the other member
			// of a translation pair, where the coordinates transfer but only if
			// something can still identify the passage. A box has no such handle,
			// so it stays coordinates-only.
			const text = window.getSelection()?.toString().trim();
			this.applyReanchor(pdfPath, ann.id, sel.pageNumber, sel.rect, text || undefined, sel.rects);
			return;
		}
		this.pendingPlacement = null;
		this.pendingReanchor = { pdfPath, id: ann.id };
		this.rectSelect.armed = true;
		new Notice("在 PDF 上选中文字或拖一个框,重新指定这条批注指向的位置");
	}

	private applyReanchor(
		pdfPath: string,
		id: string,
		pageNumber: number,
		rect: PdfRect,
		quote?: string,
		anchorRects?: PdfRect[]
	): void {
		const ann = this.store.forFile(pdfPath).find((a) => a.id === id);
		if (!ann) return;
		ann.page = pageNumber;
		ann.anchor = rect;
		ann.anchorRects = anchorRects;
		// Either way the old quote must go: it described the previous passage, and
		// leaving it would let a later re-resolution drag the highlight back.
		ann.quote = quote;
		// The arrow's attachment point was a fraction of the OLD box.
		ann.leaderAt = undefined;
		ann.updatedAt = Date.now();
		this.store.upsert(pdfPath, ann);
		new Notice(quote ? "已更新高亮位置(记住了选中的文字,可跨译文/原文定位)" : "已更新这条批注的高亮位置");
	}

	/** All PDFs in the active file's shared group, including itself. */
	sharedMembersOfActive(): string[] {
		const file = this.currentPdfTarget();
		return file ? this.store.sharedMembers(file.path) : [];
	}

	/** Current PDF first; otherwise the first shared member with a non-empty outline. */
	async sharedOutline(pdfPath: string): Promise<SharedOutlineResult> {
		const candidates = [pdfPath, ...this.store.sharedMembers(pdfPath).filter((path) => path !== pdfPath)];
		const manual = this.store.manualOutlineForFile(pdfPath);
		let firstError: string | undefined;
		for (const path of candidates) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!isPdf(file)) continue;
			try {
				const items = await this.outlineReader.read(file);
				if (outlineHasDestination(items)) return { sourcePath: path, items: combineOutlines(items, manual), hasManual: manual.length > 0 };
			} catch (error) {
				firstError ??= String(error instanceof Error ? error.message : error);
			}
		}
		return {
			sourcePath: manual.length > 0 ? pdfPath : null,
			items: combineOutlines([], manual),
			hasManual: manual.length > 0,
			error: firstError,
		};
	}

	openManualOutlineEditor(pdfPath?: string, entry?: ManualOutlineEntry): void {
		const path = pdfPath ?? this.currentPdfTarget()?.path;
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!isPdf(file)) return;
		const view = this.app.workspace.getLeavesOfType("pdf")
			.find((leaf) => (leaf.view as FileView).file?.path === path)?.view as FileView | undefined;
		const pageInfo = view ? currentPdfPageInfo(view) : null;
		new ManualOutlineModal(this.app, entry ?? null, pageInfo?.page ?? 1, pageInfo?.count ?? null, (next) => {
			if (!isPdf(this.app.vault.getAbstractFileByPath(path))) return;
			this.store.upsertManualOutline(path, next);
			this.refreshNativeOutlines();
		}).open();
	}

	removeManualOutline(pdfPath: string, id: string): void {
		if (this.store.removeManualOutline(pdfPath, id)) this.refreshNativeOutlines();
	}

	/**
	 * List-panel hover feedback: highlights an annotation's source text without
	 * jumping to it — unlike `revealAnnotation()`, this never opens a file or
	 * scrolls, so it's cheap enough to fire on every row the pointer passes
	 * over. Silently does nothing if the annotation's page isn't currently
	 * rendered in the open PDF (e.g. the row is for a page scrolled out of view).
	 */
	peekAnnotation(ann: PdfAnnotation): void {
		const view = this.targetPdfView();
		const state = view ? this.states.get(view) : null;
		const pageView = state?.pages.get(ann.page);
		if (state && pageView) state.layer.beginHoverHighlight(pageView, ann);
	}

	clearPeek(): void {
		const view = this.targetPdfView();
		const state = view ? this.states.get(view) : null;
		state?.layer.endHoverHighlight();
	}

	private explainNoCounterpart(): string {
		return "当前 PDF 尚未加入共享组。\n请运行「[PDF] 添加 PDF 到共享批注组」。";
	}

	private queueSharedLayoutRecheck(pdfPath: string): void {
		if (!this.store.isPaired(pdfPath)) return;
		const previous = this.layoutRecheckTimers.get(pdfPath);
		if (previous !== undefined) window.clearTimeout(previous);
		const timer = window.setTimeout(() => {
			this.layoutRecheckTimers.delete(pdfPath);
			void this.recheckSharedMember(pdfPath, new Set([pdfPath]), true);
		}, SHARED_LAYOUT_RECHECK_DELAY_MS);
		this.layoutRecheckTimers.set(pdfPath, timer);
	}

	/** Recheck members whose binary revision changed while the plugin was closed. */
	private async recheckChangedSharedFiles(): Promise<void> {
		const changed = this.store.changedSharedMembers();
		if (changed.length === 0) return;
		const changedSet = new Set(changed);
		const processed = new Set<string>();
		let detached = 0;
		for (const path of changed) {
			if (processed.has(path) || !this.store.isPaired(path)) continue;
			const members = this.store.sharedMembers(path);
			for (const member of members) processed.add(member);
			const unchangedReference = members.find((member) => !changedSet.has(member));
			if (unchangedReference) {
				for (const member of members) {
					if (!changedSet.has(member)) continue;
					const result = await this.recheckSharedMember(member, changedSet, false);
					if (result === "detached") detached++;
				}
			} else {
				detached += await this.recheckEntireChangedGroup(members);
			}
		}
		if (detached > 0) {
			new Notice(`有 ${detached} 份 PDF 的页面版式确实发生变化，已退出共享组并保留批注副本。`, 9000);
		}
	}

	/**
	 * When sync rewrites every member, revision markers cannot identify the one
	 * that changed layout. Keep the largest mutually compatible coordinate set;
	 * a binary mismatch or a group with no compatible pair naturally dissolves.
	 */
	private async recheckEntireChangedGroup(members: string[]): Promise<number> {
		const files = members.map((path) => this.app.vault.getAbstractFileByPath(path));
		if (!files.every(isPdf)) return 0;
		const pdfs = files as TFile[];
		const before = pdfs.map((file) => ({ mtime: file.stat.mtime, size: file.stat.size }));
		const layouts = await Promise.all(pdfs.map((file) => readPdfLayout(this.app, file)));
		if (layouts.some((layout) => layout === null)) return 0;
		if (
			pdfs.some(
				(file, index) => file.stat.mtime !== before[index].mtime || file.stat.size !== before[index].size
			)
		) {
			for (const path of members) this.queueSharedLayoutRecheck(path);
			return 0;
		}
		if (!members.every((path) => this.store.sharedMembers(members[0]).includes(path))) return 0;

		const cluster = largestCompatibleLayoutCluster(layouts as NonNullable<(typeof layouts)[number]>[]);
		if (cluster.length === members.length) {
			for (const path of members) this.store.acceptCurrentRevision(path);
			return 0;
		}

		const keep = cluster.length >= 2 ? new Set(cluster.map((index) => members[index])) : new Set<string>();
		let detached = 0;
		for (const path of members) {
			if (keep.has(path) || !this.store.isPaired(path)) continue;
			if (this.store.leaveGroup(path)) detached++;
		}
		for (const path of keep) this.store.acceptCurrentRevision(path);
		if (detached > 0) this.refreshNativeOutlines();
		return detached;
	}

	/**
	 * Compare the changed member with a group peer. An unchanged peer is the
	 * preferred reference after startup; if every member changed, any peer still
	 * proves whether their current coordinate systems remain compatible.
	 */
	private async recheckSharedMember(
		pdfPath: string,
		changedPaths: ReadonlySet<string>,
		announce: boolean
	): Promise<"kept" | "detached" | "skipped"> {
		const file = this.app.vault.getAbstractFileByPath(pdfPath);
		if (!isPdf(file) || !this.store.isPaired(pdfPath)) return "skipped";
		const members = this.store.sharedMembers(pdfPath);
		const otherPath =
			members.find((path) => path !== pdfPath && !changedPaths.has(path)) ??
			members.find((path) => path !== pdfPath);
		if (!otherPath) return "skipped";
		const other = this.app.vault.getAbstractFileByPath(otherPath);
		if (!isPdf(other)) return "skipped";

		const before = {
			fileMtime: file.stat.mtime,
			fileSize: file.stat.size,
			otherMtime: other.stat.mtime,
			otherSize: other.stat.size,
		};
		const layout = await comparePdfLayouts(this.app, file, other);
		if (
			file.stat.mtime !== before.fileMtime ||
			file.stat.size !== before.fileSize ||
			other.stat.mtime !== before.otherMtime ||
			other.stat.size !== before.otherSize
		) {
			this.queueSharedLayoutRecheck(pdfPath);
			return "skipped";
		}
		// The user may have changed the group while pdf.js was reading both files.
		if (!this.store.sharedMembers(pdfPath).includes(otherPath)) return "skipped";
		if (layout.status === "unreadable") return "skipped";
		if (layout.compatible) {
			this.store.acceptCurrentRevision(pdfPath);
			return "kept";
		}

		if (!this.store.leaveGroup(pdfPath)) return "skipped";
		this.refreshNativeOutlines();
		if (announce) {
			new Notice(`PDF 页面版式已变化，已退出共享组并保留批注副本：\n${file.basename}\n${layout.reason}`, 9000);
		}
		return "detached";
	}

	/** Checks layout, then asks only when both sides contain different notes. */
	async pairManually(otherPath: string): Promise<void> {
		const file = this.currentPdfTarget();
		if (!file) return;
		const other = this.app.vault.getAbstractFileByPath(otherPath);
		if (!isPdf(other)) {
			new Notice(`找不到要关联的 PDF:${otherPath}`);
			return;
		}
		const checking = new Notice("正在检查两份 PDF 的页数和页面尺寸…", 0);
		const layout = await comparePdfLayouts(this.app, file, other);
		checking.hide();
		if (!layout.compatible) {
			new Notice(`无法加入共享组：${layout.reason}`, 9000);
			return;
		}
		if (!this.store.annotationConflict(file.path, other.path)) {
			this.applyPairDecision(file.path, other.path, { strategy: "merge" });
			return;
		}
		new PairDecisionModal(
			this.app,
			{
				currentPath: file.path,
				otherPath: other.path,
				currentCount: this.store.annotationCount(file.path),
				otherCount: this.store.annotationCount(other.path),
				layout,
			},
			(decision) => this.applyPairDecision(file.path, other.path, decision)
		).open();
	}

	private applyPairDecision(currentPath: string, otherPath: string, decision: PairDecision): void {
		const inheritedSplit = this.settings.doubleColumnSplits[currentPath] ?? this.settings.doubleColumnSplits[otherPath];
		this.store.joinShared(currentPath, otherPath, decision.strategy);
		if (inheritedSplit !== undefined) {
			const next = { ...this.settings.doubleColumnSplits };
			for (const path of this.store.sharedMembers(currentPath)) next[path] = inheritedSplit;
			this.patchSettings({ doubleColumnSplits: next });
		}
		this.refreshNativeOutlines();
		const count = this.store.sharedMembers(currentPath).length;
		new Notice(`已加入共享批注组（${count} 份 PDF）:\n${otherPath.split("/").pop()}`);
	}

	/** Every other vault PDF, with name-similar choices ranked first. */
	pairingCandidates(): string[] {
		const file = this.currentPdfTarget();
		if (!file) return [];
		const members = new Set(this.store.sharedMembers(file.path));
		return listPairingCandidates(this.app, file.path).filter((path) => !members.has(path));
	}

	unpairActive(): void {
		const file = this.currentPdfTarget();
		if (!file) return;
		if (!this.store.isPaired(file.path)) {
			new Notice("当前 PDF 不在共享批注组中");
			return;
		}
		const before = this.store.sharedMembers(file.path).length;
		this.store.leaveGroup(file.path);
		this.refreshNativeOutlines();
		new Notice(
			before > 2
				? `当前 PDF 已退出共享组并保留批注副本;其余 ${before - 1} 份继续共享`
				: "已解除共享;两份 PDF 都保留当前批注副本"
		);
	}

	/** Next member in insertion order; with two PDFs this is the ordinary flip. */
	private nextSharedMember(pdfPath: string): string | null {
		const members = this.store.sharedMembers(pdfPath);
		if (members.length < 2) return null;
		const index = members.indexOf(pdfPath);
		return members[(index + 1 + members.length) % members.length] ?? null;
	}

	/**
	 * Cycles to the next member at the same page and fraction. Every group member
	 * passed the full layout check when it joined.
	 *
	 * "Smooth" here means two honest things, not a crossfade between the two
	 * documents' actual content — pdf.js tears down and re-renders the page
	 * canvases on a file swap, and there is no supported way to keep both
	 * painted at once to cross-dissolve between them. What IS real:
	 *   1. A brief opacity dip on the pane bridges the moment of the swap
	 *      instead of a hard flash of blank/re-laid-out content.
	 *   2. Landing on the matched position is an animated scroll, not a jump.
	 */
	/**
	 * Opens the paired document beside this one instead of replacing it, for
	 * reading the translation and the original side by side. `switchToCounterpart`
	 * swaps in place and keeps the reading position; this keeps both on screen,
	 * which is the other thing you want a pair for.
	 *
	 * Reuses an existing split already showing the counterpart rather than
	 * stacking a second copy of the same file every time it is run.
	 */
	async openCounterpartInSplit(): Promise<void> {
		const file = this.currentPdfTarget();
		if (!file) return;
		const other = this.nextSharedMember(file.path);
		if (!other) {
			new Notice(this.explainNoCounterpart(), 6000);
			return;
		}
		const target = this.app.vault.getAbstractFileByPath(other);
		if (!(target instanceof TFile)) {
			this.store.detachFile(other);
			new Notice(`共享组成员已不存在，已自动移除:${other}`);
			return;
		}
		const existing = this.app.workspace
			.getLeavesOfType("pdf")
			.find((l) => (l.view as FileView).file?.path === other);
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		await this.app.workspace.getLeaf("split").openFile(target);
	}

	async switchToCounterpart(): Promise<void> {
		const view = this.targetPdfView();
		const file = this.currentPdfTarget();
		if (!view || !file) return;

		const other = this.nextSharedMember(file.path);
		if (!other) {
			new Notice(this.explainNoCounterpart(), 6000);
			return;
		}
		const target = this.app.vault.getAbstractFileByPath(other);
		if (!isPdf(target)) {
			this.store.detachFile(other);
			new Notice(`共享组成员已不存在，已自动移除:${other}`);
			return;
		}

		const state = this.states.get(view);
		const page = this.visiblePage(state) ?? 1;
		const fraction = this.pageScrollFraction(state, page);

		// Captured as a plain element reference, not kept live off `view` or
		// `view.leaf`: Obsidian reuses the same leaf/containerEl DOM node across
		// a same-type file swap, but the View *instance* isn't guaranteed to
		// survive it, so anything read from `view` again after the swap could be
		// stale. The element itself has no such lifecycle problem.
		const container = view.containerEl;
		container.addClass("margin-notes-pdf-switching");

		await this.app.workspace.openLinkText(`${target.path}#page=${page}`, "", false);

		window.setTimeout(() => {
			if (fraction !== null) this.applyPageFraction(page, fraction);
			container.removeClass("margin-notes-pdf-switching");
		}, SWITCH_SETTLE_MS);
	}

	/** Whichever page currently occupies most of the viewport. */
	private visiblePage(state: ViewState | undefined): number | null {
		if (!state) return null;
		let best: { page: number; area: number } | null = null;
		for (const [page, pv] of state.pages) {
			if (!pv.div.isConnected) continue;
			const r = pv.div.getBoundingClientRect();
			const visible = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
			if (!best || visible > best.area) best = { page, area: visible };
		}
		return best?.page ?? null;
	}

	/** How far down the given page the viewport sits, 0–1. */
	private pageScrollFraction(state: ViewState | undefined, page: number): number | null {
		const pv = state?.pages.get(page);
		if (!pv?.div.isConnected) return null;
		const r = pv.div.getBoundingClientRect();
		if (r.height <= 0) return null;
		return Math.max(0, Math.min(1, -r.top / r.height));
	}

	private applyPageFraction(page: number, fraction: number): void {
		const view = this.targetPdfView();
		const pv = view ? this.states.get(view)?.pages.get(page) : null;
		if (!pv?.div.isConnected) return;
		const scroller = findScrollAncestor(pv.div);
		const r = pv.div.getBoundingClientRect();
		const delta = r.top + fraction * r.height - scroller.getBoundingClientRect().top;
		// An animated scroll rather than an instant jump — this is the "smooth"
		// part of switchToCounterpart() that's actually achievable (see its docs
		// for why a true crossfade between the two documents isn't).
		scroller.scrollBy({ top: delta, behavior: "smooth" });
	}

	/**
	 * Opens the PDF at the note's page, then flashes it.
	 *
	 * Reuses the leaf the PDF is already in (the common case — you're browsing
	 * the list panel of a PDF you already have open) rather than opening a
	 * second copy. Navigating an ALREADY-open file to a page/subpath is
	 * `View.setEphemeralState()`, not `setState()` — `setState()`'s shape is
	 * per-view persisted state (`{file, subpath}` isn't a key it understands for
	 * FileView), which is why this silently did nothing before.
	 */
	async revealAnnotation(pdfPath: string, ann: PdfAnnotation, keepSourceView = false): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType("pdf")
			.find((l) => (l.view as FileView).file?.path === pdfPath);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			existing.view.setEphemeralState({ subpath: `#page=${ann.page}` });
		} else {
			await this.app.workspace.openLinkText(`${pdfPath}#page=${ann.page}`, "", keepSourceView);
		}

		// Give pdf.js a beat to render the target page before looking for the element.
		window.setTimeout(() => {
			const view = this.targetPdfView();
			const state = view ? this.states.get(view) : null;
			state?.layer.reveal(state.pages, ann);
		}, 350);
	}

	/** Opens an inherited outline destination in the PDF currently being read. */
	async revealOutlineTarget(pdfPath: string, target: PdfOutlineItem): Promise<void> {
		if (target.page === null) return;
		const existing = this.app.workspace
			.getLeavesOfType("pdf")
			.find((leaf) => (leaf.view as FileView).file?.path === pdfPath);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			existing.view.setEphemeralState({ subpath: `#page=${target.page}` });
		} else {
			await this.app.workspace.openLinkText(`${pdfPath}#page=${target.page}`, "", false);
		}
		if (target.topRatio === null) return;
		const topRatio = target.topRatio;

		const position = (attempt: number) => {
			const view = this.targetPdfView();
			const state = view ? this.states.get(view) : null;
			const pageView = state?.currentPath() === pdfPath ? state.pages.get(target.page!) : null;
			if (!pageView?.div.isConnected) {
				if (attempt < 4) window.setTimeout(() => position(attempt + 1), 180);
				return;
			}
			const scroller = findScrollAncestor(pageView.div);
			const pageRect = pageView.div.getBoundingClientRect();
			const scrollerRect = scroller.getBoundingClientRect();
			const destination = pageRect.top + pageRect.height * topRatio;
			scroller.scrollBy({ top: destination - scrollerRect.top - 36, behavior: "smooth" });
		};
		window.setTimeout(() => position(0), 320);
	}

	private place(pdfPath: string, pageNumber: number, rect: PdfRect, form: NewNoteForm, quote?: string, anchorRects?: PdfRect[]): void {
		const ann: PdfAnnotation = {
			id: makeAnnotationId(),
			page: pageNumber,
			anchor: rect,
			anchorRects,
			quote,
			pinned: form.pinned,
			collapsed: form.collapsed,
			side: form.side,
			layerIds: this.activeLayerId ? [this.activeLayerId] : undefined,
			text: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.store.upsert(pdfPath, ann);

		const view = getActivePDFView(this.app);
		const state = view ? this.states.get(view) : null;
		if (state) state.layer.rebuild(pdfPath, state.pages);
	}

	private placeMark(pdfPath: string, pageNumber: number, rect: PdfRect, quote?: string, anchorRects?: PdfRect[], colorKey?: string): void {
		const ann: PdfAnnotation = {
			id: makeAnnotationId(),
			page: pageNumber,
			anchor: rect,
			anchorRects,
			markOnly: true,
			quote,
			colorKey,
			pinned: false,
			collapsed: true,
			side: "right",
			layerIds: this.activeLayerId ? [this.activeLayerId] : undefined,
			text: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.store.upsert(pdfPath, ann);

		const view = getActivePDFView(this.app);
		const state = view ? this.states.get(view) : null;
		if (state) state.layer.rebuild(pdfPath, state.pages);
	}

	private rebuildAll(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const state = this.states.get(leaf.view as FileView);
			const path = state?.currentPath();
			if (state && path) state.layer.rebuild(path, state.pages);
		}
	}

	private refreshNativeOutlines(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			this.states.get(leaf.view as FileView)?.outlineBridge.refresh();
		}
	}

	private scanPDFViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const view = leaf.view as FileView;
			if (this.tracked.has(view)) continue;
			this.tracked.add(view);
			this.attachPageHandlers(view);
		}
	}

	/**
	 * Undo/redo keys, listening on THIS PDF view's own element.
	 *
	 * They were previously registered as commands with default `Mod+Z` hotkeys.
	 * That is a global registration: it puts an entry in Obsidian's hotkey table
	 * for a chord the editor also uses, and even with a checkCallback that
	 * declines outside a PDF, ordinary text undo in Markdown stopped working —
	 * the keystroke was being consumed before it ever reached the editor. A
	 * listener bound to the PDF view's element cannot have that effect on
	 * anything else, because events elsewhere never reach it. The commands are
	 * still in the palette, just with no default hotkey of their own.
	 *
	 * Typing inside a note still wins: while a contentEditable/input has focus
	 * this bows out so the field's own undo runs.
	 */
	private attachUndoKeys(view: FileView, component: Component): void {
		component.registerDomEvent(view.containerEl, "keydown", (ev: KeyboardEvent) => {
			if (ev.key.toLowerCase() !== "z" || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
			const el = document.activeElement as HTMLElement | null;
			if (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
			if (ev.shiftKey ? !this.store.canRedo : !this.store.canUndo) return;
			ev.preventDefault();
			ev.stopPropagation();
			if (ev.shiftKey) this.redo();
			else this.undo();
		});
	}

	/** Mobile text handles emit many selection changes; offer one palette after they settle. */
	private attachMobileSelectionPalette(view: FileView, component: Component): void {
		if (!Platform.isMobile) return;
		let timer: number | null = null;
		let touching = false;
		let changedDuringTouch = false;
		let lastKey: string | null = null;
		const cancel = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		};
		const schedule = () => {
			cancel();
			if (!this.settings.mobileSelectionPalette) return;
			timer = window.setTimeout(() => {
				timer = null;
				if (touching || !view.containerEl.isConnected || !this.settings.mobileSelectionPalette ||
					this.rectSelect.armed || this.pendingPlacement || this.pendingReanchor || this.pendingMarkPopover ||
					this.store.waitingForRevisionFiles) return;
				const selected = anchorFromActiveSelection();
				if (!selected || selected.view !== view || !selected.pageView.div.isConnected ||
					selected.file.path !== view.file?.path) return;
				const quote = window.getSelection()?.toString().trim();
				if (!quote) return;
				const key = JSON.stringify([selected.file.path, selected.pageNumber, selected.rect, quote]);
				if (key === lastKey) return;
				lastKey = key;
				this.showMarkPalette(selected.file.path, selected.pageNumber, selected.pageView,
					selected.rect, quote, selected.rects, view);
			}, 450);
		};
		component.registerDomEvent(document, "selectionchange", () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) {
				lastKey = null;
				cancel();
				return;
			}
			if (touching) changedDuringTouch = true;
			else schedule();
		});
		component.registerDomEvent(view.containerEl, "touchstart", () => {
			touching = true;
			changedDuringTouch = false;
			lastKey = null;
			cancel();
		});
		component.registerDomEvent(document, "touchend", () => {
			touching = false;
			if (changedDuringTouch) schedule();
		});
		component.registerDomEvent(document, "touchcancel", () => {
			touching = false;
			changedDuringTouch = false;
			cancel();
		});
		component.register(cancel);
	}

	private attachPageHandlers(view: FileView): void {
		const component = new Component();
		this.plugin.addChild(component);

		const pages = new Map<number, PDFPageView>();
		const layer = new AnnotationLayer(
			this.app,
			component,
			this.store,
			() => this.settings,
			() => this.activeLayerId,
			(patch) => this.patchSettings(patch),
			(pdfPath, ann) => this.reanchor(pdfPath, ann)
		);

		// Obsidian reuses the same FileView (and pdf.js viewer) when the user opens a
		// different PDF in the same tab — read view.file fresh each time instead of
		// capturing it, so notes follow the file actually open.
		let lastPath: string | null = null;
		const currentPath = (): string | null => {
			const file = view.file;
			if (!(file instanceof TFile)) return null;
			if (file.path !== lastPath) {
				this.closePendingMarkPopover(view);
				pages.clear();
				lastPath = file.path;
			}
			return file.path;
		};

		const outlineBridge = new NativeOutlineBridge(
			view,
			component,
			currentPath,
			(path) => this.sharedOutline(path),
			(path) => this.store.manualOutlineForFile(path).length > 0
		);
		const state: ViewState = { pages, layer, currentPath, outlineBridge };
		this.states.set(view, state);
		component.register(() => layer.destroy());
		component.register(() => this.closePendingMarkPopover(view));
		this.attachUndoKeys(view, component);
		this.attachMobileSelectionPalette(view, component);
		onScaleChanging(view, component, () => layer.beginZoom());

		const trackedPageDivs = new WeakSet<HTMLDivElement>();

		onPageReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			const path = currentPath();
			pages.set(pageNumber, pageView);

			if (!trackedPageDivs.has(pageView.div)) {
				trackedPageDivs.add(pageView.div);
				const detach = attachRectSelectListener(pageView, this.rectSelect, (rect) => {
					const redo = this.pendingReanchor;
					this.pendingReanchor = null;
					if (redo) {
						this.applyReanchor(redo.pdfPath, redo.id, pageNumber, rect);
						return;
					}
					const pending = this.pendingPlacement;
					this.pendingPlacement = null;
					const p = currentPath();
					if (!pending || !p) return;
					if (pending.kind === "mark") this.showMarkPalette(p, pageNumber, pageView, rect, undefined, undefined, view);
					else this.place(p, pageNumber, rect, pending.form);
				});
				component.register(detach);
			}

			if (path) layer.rebuild(path, pages);
		});

		// Positions depend on each page's rendered box, which can shift slightly
		// once the text layer settles — cheap enough to just redo it.
		onTextLayerReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			pages.set(pageNumber, pageView);
			const path = currentPath();
			if (!path) return;
			layer.rebuild(path, pages);
		});
	}
}
