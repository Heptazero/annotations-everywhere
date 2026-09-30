import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { resolveAnnotationColor } from "./annotation-settings";
import type { AnnotationStatusKind, AnnotationStatusSummary } from "./annotation-status";
import type { PdfAnnotation } from "./annotation-types";
import type { PdfAnnotationsController } from "./controller";
import { AnnotationTransferModal, DeleteAnnotationsModal } from "./annotation-batch-modal";
import type { AnnotationSelectionRef } from "./annotation-batch";
import { AnnotationFolderSuggest } from "./annotation-folder-suggest";

export const ANNOTATION_MANAGER_VIEW = "margin-notes-hz-annotation-manager";

type StatusFilter = "all" | AnnotationStatusKind;
type TimeOrder = "newest" | "oldest";
interface VisibleGroup {
	summary: AnnotationStatusSummary;
	annotations: PdfAnnotation[];
}

function selectionKey(bucket: string, id: string): string {
	return `${bucket}\u0000${id}`;
}

function displayName(path: string): string {
	const leaf = path.split("/").pop() ?? path;
	return leaf.replace(/\.pdf$/i, "");
}

function annotationExcerpt(annotation: PdfAnnotation): string {
	return annotation.text.trim() || annotation.quote?.trim() || (annotation.markOnly ? "仅勾画" : "空批注");
}

function statusLabel(status: AnnotationStatusKind): string {
	if (status === "shared") return "共享";
	if (status === "orphaned") return "未挂载";
	return "独立";
}

function groupFolderPaths(groups: VisibleGroup[]): string[] {
	const folders = new Set<string>();
	for (const { summary } of groups) {
		for (const path of summary.memberPaths) {
			const parts = path.split("/").slice(0, -1);
			for (let depth = 1; depth <= parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
		}
	}
	return [...folders].sort((a, b) => {
		const depth = a.split("/").length - b.split("/").length;
		return depth || a.localeCompare(b, "zh-CN");
	});
}

function groupIsInFolder(summary: AnnotationStatusSummary, folder: string): boolean {
	return !folder || summary.memberPaths.some((path) => path.startsWith(`${folder}/`));
}

/** Global, multi-select annotation workspace. The current-PDF sidebar stays intentionally separate. */
export class AnnotationManagerView extends ItemView {
	private query = "";
	private status: StatusFilter = "all";
	private timeOrder: TimeOrder = "newest";
	private folderPrefix = "";
	private selected = new Set<string>();
	private collapsed = new Set<string>();
	private searchInput: HTMLInputElement | null = null;
	private folderSuggest: AnnotationFolderSuggest | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private controller: PdfAnnotationsController
	) {
		super(leaf);
	}

	getViewType(): string {
		return ANNOTATION_MANAGER_VIEW;
	}

	getDisplayText(): string {
		return "PDF 批注管理";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.register(this.controller.store.onChange(() => this.render()));
		this.render();
	}

	async onClose(): Promise<void> {
		this.folderSuggest?.close();
		this.folderSuggest = null;
	}

	private readGroups(): { all: VisibleGroup[]; visible: VisibleGroup[] } {
		const all = this.controller.annotationStatusSummaries().map((summary) => ({
			summary,
			annotations: this.controller.store.forFile(summary.key).sort((a, b) => {
				const timeDelta = a.updatedAt - b.updatedAt;
				if (timeDelta !== 0) return this.timeOrder === "newest" ? -timeDelta : timeDelta;
				return a.page - b.page || a.id.localeCompare(b.id);
			}),
		})).sort((a, b) => {
			const aTime = a.summary.lastUpdatedAt ?? 0;
			const bTime = b.summary.lastUpdatedAt ?? 0;
			const timeDelta = aTime - bTime;
			if (timeDelta !== 0) return this.timeOrder === "newest" ? -timeDelta : timeDelta;
			return a.summary.representativePath.localeCompare(b.summary.representativePath, "zh-CN");
		});
		const validKeys = new Set(all.flatMap(({ summary, annotations }) =>
			annotations.map((annotation) => selectionKey(summary.key, annotation.id))));
		for (const key of this.selected) if (!validKeys.has(key)) this.selected.delete(key);

		const query = this.query.trim().normalize("NFKC").toLocaleLowerCase();
		const visible = all.flatMap(({ summary, annotations }) => {
			if (this.status !== "all" && summary.status !== this.status) return [];
			if (!groupIsInFolder(summary, this.folderPrefix)) return [];
			if (!query) return [{ summary, annotations }];
			const groupText = [summary.representativePath, ...summary.memberPaths, statusLabel(summary.status)]
				.join(" ").normalize("NFKC").toLocaleLowerCase();
			if (groupText.includes(query)) return [{ summary, annotations }];
			const matches = annotations.filter((annotation) =>
				[annotation.text, annotation.quote ?? "", `第 ${annotation.page} 页`, String(annotation.page)]
					.join(" ").normalize("NFKC").toLocaleLowerCase().includes(query));
			return matches.length > 0 ? [{ summary, annotations: matches }] : [];
		});
		return { all, visible };
	}

	private render(): void {
		const previousScroll = this.contentEl.scrollTop;
		const hadSearchFocus = document.activeElement === this.searchInput;
		const { all, visible } = this.readGroups();
		this.folderSuggest?.close();
		this.folderSuggest = null;
		this.contentEl.empty();
		this.contentEl.addClass("margin-notes-manager");

		const header = this.contentEl.createDiv("margin-notes-manager-header");
		const title = header.createDiv();
		title.createEl("h2", { text: "批注管理" });
		const total = all.reduce((sum, group) => sum + group.annotations.length, 0);
		const visibleTotal = visible.reduce((sum, group) => sum + group.annotations.length, 0);
		const filtered = this.query.trim() !== "" || this.status !== "all" || this.folderPrefix !== "";
		title.createDiv({
			cls: "margin-notes-manager-summary",
			text: filtered
				? `${visible.length}/${all.length} 组 PDF · ${visibleTotal}/${total} 条批注`
				: `${all.length} 组 PDF · ${total} 条批注`,
		});

		const toolbar = this.contentEl.createDiv("margin-notes-manager-toolbar");
		const searchWrap = toolbar.createDiv("margin-notes-manager-search");
		const searchIcon = searchWrap.createSpan("margin-notes-manager-search-icon");
		setIcon(searchIcon, "search");
		this.searchInput = searchWrap.createEl("input", {
			type: "search",
			value: this.query,
			attr: { placeholder: "搜索批注、引文或 PDF", "aria-label": "搜索全库批注" },
		});
		this.searchInput.addEventListener("input", () => {
			this.query = this.searchInput?.value ?? "";
			this.contentEl.scrollTop = 0;
			this.render();
		});

		const segments = toolbar.createDiv({
			cls: "margin-notes-manager-segments",
			attr: { role: "group", "aria-label": "批注状态筛选" },
		});
		const filters: Array<[StatusFilter, string]> = [
			["all", "全部"], ["standalone", "独立"], ["shared", "共享"], ["orphaned", "未挂载"],
		];
		for (const [value, label] of filters) {
			const button = segments.createEl("button", {
				text: label,
				attr: { type: "button", "aria-pressed": String(this.status === value) },
			});
			button.addEventListener("click", () => {
				this.status = value;
				this.contentEl.scrollTop = 0;
				this.render();
			});
		}

		const filterBar = this.contentEl.createDiv("margin-notes-manager-filterbar");
		const folderCandidates = groupFolderPaths(all);
		const folderControl = filterBar.createDiv("margin-notes-manager-folder-filter");
		const folderIcon = folderControl.createSpan("margin-notes-manager-filter-icon");
		setIcon(folderIcon, "folder");
		const folderInput = folderControl.createEl("input", {
			type: "text",
			value: this.folderPrefix,
			attr: {
				placeholder: "全部文件夹",
				"aria-label": "按文件夹筛选批注",
				spellcheck: "false",
			},
		});
		this.folderSuggest = new AnnotationFolderSuggest(this.app, folderInput, folderCandidates, (path) => {
			this.folderPrefix = path;
			this.contentEl.scrollTop = 0;
			this.render();
		});
		folderInput.addEventListener("blur", () => window.setTimeout(() => {
			if (folderInput.isConnected && folderInput.value !== this.folderPrefix) folderInput.value = this.folderPrefix;
		}, 150));
		if (this.folderPrefix) {
			const clearFolder = folderControl.createEl("button", {
				cls: "clickable-icon margin-notes-manager-filter-clear",
				attr: { type: "button", "aria-label": "清除文件夹筛选", title: "清除文件夹筛选" },
			});
			setIcon(clearFolder, "x");
			clearFolder.addEventListener("click", () => {
				this.folderPrefix = "";
				this.contentEl.scrollTop = 0;
				this.render();
			});
		}

		const timeSegments = filterBar.createDiv({
			cls: "margin-notes-manager-segments margin-notes-manager-time-order",
			attr: { role: "group", "aria-label": "按修改时间排序" },
		});
		const timeOptions: Array<[TimeOrder, string]> = [["newest", "新 → 旧"], ["oldest", "旧 → 新"]];
		for (const [value, label] of timeOptions) {
			const button = timeSegments.createEl("button", {
				text: label,
				attr: { type: "button", "aria-pressed": String(this.timeOrder === value) },
			});
			button.addEventListener("click", () => {
				this.timeOrder = value;
				this.contentEl.scrollTop = 0;
				this.render();
			});
		}

		const visibleGroupKeys = visible.map(({ summary }) => summary.key);
		const allVisibleCollapsed = visibleGroupKeys.length > 0 && visibleGroupKeys.every((key) => this.collapsed.has(key));
		const collapseAll = filterBar.createEl("button", {
			cls: "margin-notes-manager-collapse-all",
			text: allVisibleCollapsed ? "全部展开" : "全部折叠",
			attr: { type: "button" },
		});
		collapseAll.disabled = visibleGroupKeys.length === 0;
		collapseAll.addEventListener("click", () => {
			for (const key of visibleGroupKeys) {
				if (allVisibleCollapsed) this.collapsed.delete(key);
				else this.collapsed.add(key);
			}
			this.render();
		});

		const visibleKeys = visible.flatMap(({ summary, annotations }) =>
			annotations.map((annotation) => selectionKey(summary.key, annotation.id)));
		this.renderSelectionBar(all, visibleKeys);

		const groupsHost = this.contentEl.createDiv("margin-notes-manager-groups");
		if (visible.length === 0) {
			groupsHost.createDiv({
				cls: "margin-notes-manager-empty",
				text: total === 0 ? "还没有 PDF 批注" : "没有符合当前筛选的批注",
			});
		} else {
			for (const group of visible) this.renderGroup(groupsHost, group);
		}

		this.contentEl.scrollTop = previousScroll;
		if (hadSearchFocus) window.requestAnimationFrame(() => {
			this.searchInput?.focus();
			const length = this.searchInput?.value.length ?? 0;
			this.searchInput?.setSelectionRange(length, length);
		});
	}

	private renderSelectionBar(all: VisibleGroup[], visibleKeys: string[]): void {
		const bar = this.contentEl.createDiv("margin-notes-manager-selection-bar");
		bar.toggleClass("is-active", this.selected.size > 0);
		bar.createSpan({
			cls: "margin-notes-manager-selection-count",
			text: this.selected.size > 0 ? `已选 ${this.selected.size} 条` : "选择批注后可批量处理",
		});

		const selectVisible = bar.createEl("button", {
			text: visibleKeys.length > 0 && visibleKeys.every((key) => this.selected.has(key)) ? "取消当前结果" : "选择当前结果",
			attr: { type: "button" },
		});
		selectVisible.disabled = visibleKeys.length === 0;
		selectVisible.addEventListener("click", () => {
			const allSelected = visibleKeys.every((key) => this.selected.has(key));
			for (const key of visibleKeys) allSelected ? this.selected.delete(key) : this.selected.add(key);
			this.render();
		});

		if (this.selected.size > 0) {
			const clear = bar.createEl("button", { text: "清空", attr: { type: "button" } });
			clear.addEventListener("click", () => { this.selected.clear(); this.render(); });

			const transfer = bar.createEl("button", {
				cls: "mod-cta",
				text: "复制 / 移动",
				attr: { type: "button", title: "一次只能处理一个来源 PDF 或共享组" },
			});
			const sourceGroups = all.filter(({ summary, annotations }) =>
				annotations.some((annotation) => this.selected.has(selectionKey(summary.key, annotation.id))));
			transfer.disabled = sourceGroups.length !== 1 || sourceGroups[0]?.summary.livePaths.length === 0 ||
				this.controller.store.waitingForRevisionFiles;
			transfer.addEventListener("click", () => this.openTransfer(sourceGroups[0]));

			const remove = bar.createEl("button", {
				cls: "mod-warning",
				text: "删除",
				attr: { type: "button" },
			});
			remove.disabled = this.controller.store.waitingForRevisionFiles;
			remove.addEventListener("click", () => this.openDelete(all));
		}
	}

	private renderGroup(host: HTMLElement, group: VisibleGroup): void {
		const { summary, annotations } = group;
		const section = host.createDiv("margin-notes-manager-group");
		const header = section.createDiv("margin-notes-manager-group-header");
		const groupKeys = annotations.map((annotation) => selectionKey(summary.key, annotation.id));
		const checkedCount = groupKeys.filter((key) => this.selected.has(key)).length;
		const checkbox = header.createEl("input", { type: "checkbox", attr: { "aria-label": `选择 ${displayName(summary.representativePath)}` } });
		checkbox.checked = checkedCount > 0 && checkedCount === groupKeys.length;
		checkbox.indeterminate = checkedCount > 0 && checkedCount < groupKeys.length;
		checkbox.addEventListener("change", () => {
			for (const key of groupKeys) checkbox.checked ? this.selected.add(key) : this.selected.delete(key);
			this.render();
		});

		const collapse = header.createEl("button", {
			cls: "clickable-icon margin-notes-manager-collapse",
			attr: { type: "button", "aria-label": "折叠或展开批注", "aria-expanded": String(!this.collapsed.has(summary.key)) },
		});
		setIcon(collapse, "chevron-down");
		collapse.toggleClass("is-collapsed", this.collapsed.has(summary.key));
		collapse.addEventListener("click", () => {
			this.collapsed.has(summary.key) ? this.collapsed.delete(summary.key) : this.collapsed.add(summary.key);
			this.render();
		});

		const identity = header.createDiv("margin-notes-manager-group-identity");
		const nameRow = identity.createDiv("margin-notes-manager-group-name-row");
		nameRow.createSpan({ cls: "margin-notes-manager-group-name", text: displayName(summary.representativePath) });
		nameRow.createSpan({ cls: `margin-notes-manager-status is-${summary.status}`, text: statusLabel(summary.status) });
		identity.createDiv({ cls: "margin-notes-manager-group-path", text: summary.representativePath });
		if (summary.status === "shared") {
			identity.createDiv({ cls: "margin-notes-manager-members", text: summary.memberPaths.join(" · ") });
		}
		const stats = header.createDiv("margin-notes-manager-group-stats");
		stats.createSpan({ cls: "margin-notes-manager-group-count", text: `${annotations.length} 条` });
		if (summary.lastUpdatedAt) {
			stats.createSpan({
				cls: "margin-notes-manager-group-updated",
				text: `最近 ${new Date(summary.lastUpdatedAt).toLocaleDateString("zh-CN")}`,
			});
		}

		if (this.collapsed.has(summary.key)) return;
		const list = section.createDiv("margin-notes-manager-rows");
		for (const annotation of annotations) this.renderAnnotationRow(list, summary, annotation);
	}

	private renderAnnotationRow(host: HTMLElement, summary: AnnotationStatusSummary, annotation: PdfAnnotation): void {
		const row = host.createDiv("margin-notes-manager-row");
		const key = selectionKey(summary.key, annotation.id);
		const checkbox = row.createEl("input", { type: "checkbox", attr: { "aria-label": `选择第 ${annotation.page} 页批注` } });
		checkbox.checked = this.selected.has(key);
		checkbox.addEventListener("change", () => {
			checkbox.checked ? this.selected.add(key) : this.selected.delete(key);
			this.render();
		});

		row.createSpan({ cls: "margin-notes-manager-page", text: `P.${annotation.page}` });
		const color = row.createSpan("margin-notes-manager-color");
		color.style.setProperty("--annotation-color", resolveAnnotationColor(annotation, this.controller.settings));
		const content = row.createDiv("margin-notes-manager-row-content");
		content.createDiv({ cls: "margin-notes-manager-excerpt", text: annotationExcerpt(annotation) });
		if (annotation.text.trim() && annotation.quote?.trim()) {
			content.createDiv({ cls: "margin-notes-manager-quote", text: annotation.quote.trim() });
		}
		row.createSpan({
			cls: "margin-notes-manager-updated",
			text: new Date(annotation.updatedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }),
		});
		const open = row.createEl("button", {
			cls: "clickable-icon margin-notes-manager-open",
			attr: { type: "button", "aria-label": "跳到 PDF 中的这条批注", title: "跳到批注" },
		});
		setIcon(open, "arrow-up-right");
		open.disabled = summary.livePaths.length === 0;
		open.addEventListener("click", () => this.openAnnotation(summary, annotation));
		row.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("button, input")) return;
			this.openAnnotation(summary, annotation);
		});
	}

	private openAnnotation(summary: AnnotationStatusSummary, annotation: PdfAnnotation): void {
		const path = summary.livePaths[0];
		if (!path) {
			new Notice("这组批注未挂载到现存 PDF；请先恢复到目标 PDF");
			return;
		}
		void this.controller.revealAnnotation(path, annotation, true);
	}

	private openTransfer(group: VisibleGroup | undefined): void {
		if (!group) return;
		const sourcePath = group.summary.livePaths[0];
		if (!sourcePath) { new Notice("来源 PDF 已不存在，无法换算位置"); return; }
		const selected = group.annotations.filter((annotation) =>
			this.selected.has(selectionKey(group.summary.key, annotation.id)));
		const pages = [...new Set(selected.map((annotation) => annotation.page))].sort((a, b) => a - b);
		new AnnotationTransferModal(
			this.app,
			selected.length,
			pages,
			this.controller.annotationTransferTargets(sourcePath),
			async (request) => {
				const count = await this.controller.transferAnnotations(
					sourcePath,
					selected.map((annotation) => annotation.id),
					request.targetPath,
					request.mode,
					request.mappings
				);
				this.selected.clear();
				this.render();
				new Notice(`${request.mode === "move" ? "已移动" : "已复制"} ${count} 条批注`);
			}
		).open();
	}

	private openDelete(all: VisibleGroup[]): void {
		const refs: AnnotationSelectionRef[] = [];
		const sharedGroups = new Set<string>();
		for (const { summary, annotations } of all) {
			for (const annotation of annotations) {
				if (!this.selected.has(selectionKey(summary.key, annotation.id))) continue;
				refs.push({ pdfPath: summary.key, id: annotation.id });
				if (summary.status === "shared") sharedGroups.add(summary.key);
			}
		}
		new DeleteAnnotationsModal(this.app, refs, sharedGroups.size, () => {
			const removed = this.controller.deleteAnnotations(refs);
			this.selected.clear();
			return removed;
		}).open();
	}
}
