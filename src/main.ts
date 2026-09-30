import { type Editor, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import {
	createMarginNotesExtension,
} from "./margin-view-plugin";
import { scanFootnotes } from "./footnote-scan";
import { normalizeMarkdownMarginSettings, type MarkdownMarginSettings } from "./markdown-margin-settings";
import { patchPluginData } from "./plugin-data";
import { ANNOTATION_LIST_VIEW, AnnotationListView } from "./pdf/annotation-list-view";
import { PdfAnnotationSettingTab } from "./pdf/annotation-settings-tab";
import { PdfAnnotationsController, type NewNoteForm } from "./pdf/controller";
import { PairPickerModal } from "./pdf/pair-picker";
import { AnnotationRevisionConflictModal, AnnotationRevisionMigrationModal } from "./pdf/annotation-revision-modal";

export default class MarginNotesPlugin extends Plugin {
	private pdfAnnotations!: PdfAnnotationsController;
	private markdownMargin = normalizeMarkdownMarginSettings(undefined);
	private markdownMarginListeners = new Set<(settings: MarkdownMarginSettings) => void>();

	async onload() {
		const pluginData = (await this.loadData()) as { markdownMargin?: unknown } | null;
		this.markdownMargin = normalizeMarkdownMarginSettings(pluginData?.markdownMargin);
		this.registerEditorExtension(
			createMarginNotesExtension(this.app, {
				get: () => ({ ...this.markdownMargin }),
				save: (settings) => this.saveMarkdownMargin(settings),
				onChange: (listener) => {
					this.markdownMarginListeners.add(listener);
					return () => this.markdownMarginListeners.delete(listener);
				},
			})
		);

		this.addCommand({
			id: "clean-orphan-footnotes",
			name: "清理无引用的脚注定义 (Clean orphan footnote definitions)",
			editorCallback: (editor) => this.cleanOrphans(editor),
		});

		this.pdfAnnotations = new PdfAnnotationsController(this, this.app);
		await this.pdfAnnotations.onload();
		this.addSettingTab(new PdfAnnotationSettingTab(this.app, this, this.pdfAnnotations));

		// One note type, three entry points that differ only in its initial form —
		// every one of these can be switched to any other afterwards, from the
		// note's own toolbar or right-click menu.
		this.addPdfNoteCommand("pdf-add-note-right", "[PDF] 加批注:右侧轨道", { pinned: true, side: "right", collapsed: false });
		this.addPdfNoteCommand("pdf-add-note-left", "[PDF] 加批注:左侧轨道", { pinned: true, side: "left", collapsed: false });
		this.addPdfNoteCommand("pdf-add-note-free", "[PDF] 加批注:自由摆放(便利贴)", { pinned: false, side: "right", collapsed: false });
		this.addCommand({
			id: "pdf-add-mark-only",
			name: "[PDF] 仅勾画选区（无批注框）",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasActivePDFView();
				if (!checking && active) this.pdfAnnotations.addMarkOnly();
				return active;
			},
		});

		// Deliberately NO default hotkey: Cmd+Z is handled by a listener on the PDF
		// view itself (controller.attachUndoKeys), which cannot interfere with the
		// editor. Declaring it here put an entry in the global hotkey table for a
		// chord the editor needs, and broke undo in Markdown even though the
		// checkCallback declined there.
		this.addCommand({
			id: "pdf-undo",
			name: "[PDF] 撤销批注修改",
			checkCallback: (checking) => {
				const can = this.pdfAnnotations.hasActivePDFView() && this.pdfAnnotations.store.canUndo;
				if (!checking && can) this.pdfAnnotations.undo();
				return can;
			},
		});

		this.addCommand({
			id: "pdf-redo",
			name: "[PDF] 重做批注修改",
			checkCallback: (checking) => {
				const can = this.pdfAnnotations.hasActivePDFView() && this.pdfAnnotations.store.canRedo;
				if (!checking && can) this.pdfAnnotations.redo();
				return can;
			},
		});

		this.addCommand({
			id: "pdf-highlight-mode",
			name: "[PDF] 切换高亮显示方式",
			callback: () => this.pdfAnnotations.chooseHighlightMode(),
		});

		this.addCommand({
			id: "pdf-annotation-layer",
			name: "[PDF] 切换批注图层",
			callback: () => this.pdfAnnotations.chooseAnnotationLayer(),
		});

		this.addCommand({
			id: "pdf-open-counterpart-split",
			name: "[PDF] 在右侧打开共享组中的下一份 PDF",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.pdfAnnotations.openCounterpartInSplit();
				return active;
			},
		});

		this.addCommand({
			id: "pdf-switch-counterpart",
			name: "[PDF] 轮流切换共享组中的 PDF(保持页码和位置)",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.pdfAnnotations.switchToCounterpart();
				return active;
			},
		});

		this.addCommand({
			id: "pdf-pair-counterpart",
			name: "[PDF] 添加 PDF 到共享批注组",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) {
					const candidates = this.pdfAnnotations.pairingCandidates();
					new PairPickerModal(this.app, candidates, (p) => void this.pdfAnnotations.pairManually(p)).open();
				}
				return active;
			},
		});
		this.addCommand({
			id: "pdf-unpair-counterpart",
			name: "[PDF] 解除共享绑定(当前 PDF 保留批注副本)",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.canLeaveSharedGroup();
				if (!checking && active) this.pdfAnnotations.unpairActive();
				return active;
			},
		});
		this.addCommand({
			id: "pdf-recover-orphaned-annotations",
			name: "[PDF] 恢复未挂载批注到当前 PDF",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.pdfAnnotations.chooseOrphanedAnnotationRecovery();
				return active;
			},
		});

		this.registerView(ANNOTATION_LIST_VIEW, (leaf) => new AnnotationListView(leaf, this.pdfAnnotations));
		this.addCommand({
			id: "pdf-open-annotation-list",
			name: "[PDF] 打开批注列表面板",
			callback: () => void this.openAnnotationList(),
		});
		this.addCommand({
			id: "pdf-show-all-annotation-status",
			name: "[PDF] 查看全库批注状态",
			callback: () => this.pdfAnnotations.openAnnotationStatusPicker(),
		});
		this.addCommand({
			id: "pdf-migrate-annotation-revisions",
			name: "[PDF] 改用可同步的分文件批注",
			checkCallback: (checking) => {
				const available = !this.pdfAnnotations.store.usesRevisionFiles;
				if (!checking && available) new AnnotationRevisionMigrationModal(this.app, this.pdfAnnotations.store).open();
				return available;
			},
		});
		this.addCommand({
			id: "pdf-show-annotation-revision-conflicts",
			name: "[PDF] 查看批注同步冲突",
			callback: () => new AnnotationRevisionConflictModal(this.app, this.pdfAnnotations.store).open(),
		});
		this.addCommand({
			id: "pdf-export-legacy-annotations",
			name: "[PDF] 导出旧格式批注副本（用于回退）",
			checkCallback: (checking) => {
				const available = this.pdfAnnotations.store.usesRevisionFiles;
				if (!checking && available) void this.pdfAnnotations.store.exportLegacySnapshot()
					.then((path) => new Notice(`已导出 ${path}；没有切换存储格式`, 9000))
					.catch((error) => new Notice(String(error instanceof Error ? error.message : error), 9000));
				return available;
			},
		});
		this.addCommand({
			id: "pdf-retry-annotation-revision-writes",
			name: "[PDF] 重试保存未写入的批注修订",
			checkCallback: (checking) => {
				const available = this.pdfAnnotations.store.usesRevisionFiles;
				if (!checking && available) void this.pdfAnnotations.store.retryPendingRevisionWrites()
					.then((saved) => new Notice(saved ? "批注修订已写入磁盘" : "仍未写入；请检查磁盘空间与数据目录", 9000));
				return available;
			},
		});
		this.addCommand({
			id: "pdf-search-annotations",
			name: "[PDF] 搜索当前 PDF 的批注",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.openAnnotationList("search");
				return active;
			},
		});
		this.addCommand({
			id: "pdf-open-shared-outline",
			name: "[PDF] 打开共享大纲",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.openAnnotationList("outline");
				return active;
			},
		});
		this.addCommand({
			id: "pdf-add-manual-outline-heading",
			name: "[PDF] 添加手动大纲标题",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) void this.openAnnotationList("outline").then(() => this.pdfAnnotations.openManualOutlineEditor());
				return active;
			},
		});
		this.addCommand({
			id: "pdf-toggle-double-column-order",
			name: "[PDF] 切换批注阅读顺序（单栏 / 双栏）",
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasPdfTarget();
				if (!checking && active) this.pdfAnnotations.toggleDoubleColumnOrder();
				return active;
			},
		});
		this.addRibbonIcon("message-square", "PDF 批注列表", () => void this.openAnnotationList());
	}

	private saveMarkdownMargin(value: MarkdownMarginSettings): void {
		const next = normalizeMarkdownMarginSettings(value);
		if (next.width === this.markdownMargin.width && next.gap === this.markdownMargin.gap) return;
		this.markdownMargin = next;
		for (const listener of this.markdownMarginListeners) listener({ ...next });
		void patchPluginData(this, { markdownMargin: next });
	}

	private addPdfNoteCommand(id: string, name: string, form: NewNoteForm): void {
		this.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const active = this.pdfAnnotations.hasActivePDFView();
				if (!checking && active) this.pdfAnnotations.addNote(form);
				return active;
			},
		});
	}

	/** Reveals the list panel in the right sidebar, reusing an existing one if open. */
	private async openAnnotationList(action?: "search" | "outline"): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(ANNOTATION_LIST_VIEW);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			const rightLeaf: WorkspaceLeaf | null = this.app.workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({ type: ANNOTATION_LIST_VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof AnnotationListView) {
			if (action === "search") leaf.view.focusSearch();
			else if (action === "outline") leaf.view.showOutline();
		}
	}

	/**
	 * Deletes every `[^id]: ...` definition block whose id no longer has any
	 * `[^id]` reference in the body text.
	 */
	private cleanOrphans(editor: Editor): void {
		const text = editor.getValue();
		const { refs, defs } = scanFootnotes(text);
		const referenced = new Set(refs.map((r) => r.id));
		const orphans = defs.filter((d) => !referenced.has(d.id));

		if (orphans.length === 0) {
			new Notice("没有无引用的脚注定义");
			return;
		}

		// Delete bottom-up so earlier offsets stay valid across replacements.
		for (const def of [...orphans].reverse()) {
			let from = def.from;
			let to = def.to;
			if (text[to] === "\n") to++; // swallow the block's trailing newline
			else if (from > 0 && text[from - 1] === "\n") from--; // block at EOF: swallow leading one
			editor.replaceRange("", editor.offsetToPos(from), editor.offsetToPos(to));
		}

		new Notice(`已清理 ${orphans.length} 条无引用的脚注定义`);
	}
}
