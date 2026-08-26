import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { buildAnnotationBox } from "./annotation-box";
import { annotationVisibleInLayer } from "./annotation-layers";
import { filterAnnotations } from "./annotation-search";
import { annotationColorOrder, colorSlot, resolveAnnotationColor } from "./annotation-settings";
import type { PdfAnnotation } from "./annotation-types";
import type { PdfAnnotationsController } from "./controller";
import type { PdfOutlineItem } from "./pdf-outline";

export const ANNOTATION_LIST_VIEW = "margin-notes-hz-annotation-list";

/**
 * Side panel for the current PDF's annotations and its own/inherited outline.
 * Annotation rows reuse the on-page box shell; outline destinations always open
 * in the PDF being read, even when their titles came from another shared member.
 */
export class AnnotationListView extends ItemView {
	/** Which pages are collapsed — resets when the panel is closed, on purpose:
	 * this is view state, not data worth persisting to disk. */
	private collapsedPages = new Set<number>();
	private collapsedColors = new Set<string>();
	private groupMode: "page" | "color" = "page";
	private renderedPath: string | null = null;
	private renderGeneration = 0;
	private searchQuery = "";
	private searchInput: HTMLInputElement | null = null;
	private focusSearchOnNextRender = false;
	private groupSwitchTimer: number | null = null;
	private viewSwitchTimer: number | null = null;
	private panelMode: "annotations" | "outline" = "annotations";
	private collapsedOutlineItems = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private controller: PdfAnnotationsController
	) {
		super(leaf);
	}

	getViewType(): string {
		return ANNOTATION_LIST_VIEW;
	}

	getDisplayText(): string {
		return "PDF 批注与大纲";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		this.register(this.controller.store.onChange(() => this.render()));
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				// Ignore the panel gaining focus — otherwise clicking into it would
				// re-render against "no active PDF" and wipe the list.
				if (leaf?.view === this) return;
				this.render();
			})
		);
		this.render();
	}

	async onClose(): Promise<void> {
		if (this.groupSwitchTimer !== null) window.clearTimeout(this.groupSwitchTimer);
		if (this.viewSwitchTimer !== null) window.clearTimeout(this.viewSwitchTimer);
	}

	/** Used by the command palette entry after the panel has been revealed. */
	focusSearch(): void {
		if (this.panelMode !== "annotations") {
			this.panelMode = "annotations";
			this.focusSearchOnNextRender = true;
			this.render();
			return;
		}
		if (this.searchInput) {
			this.searchInput.focus();
			this.searchInput.select();
			return;
		}
		this.focusSearchOnNextRender = true;
		this.render();
	}

	showOutline(): void {
		if (this.panelMode === "outline") return;
		this.panelMode = "outline";
		this.render();
	}

	private render(): void {
		if (this.groupSwitchTimer !== null) {
			window.clearTimeout(this.groupSwitchTimer);
			this.groupSwitchTimer = null;
		}
		if (this.viewSwitchTimer !== null) {
			window.clearTimeout(this.viewSwitchTimer);
			this.viewSwitchTimer = null;
		}
		const container = this.contentEl;
		const previousScroll = container.scrollTop;
		const previousPath = this.renderedPath;
		const generation = ++this.renderGeneration;
		container.empty();
		container.addClass("margin-notes-pdf-list");
		this.searchInput = null;

		const target = this.controller.currentPdfTarget();
		if (!target) {
			this.renderedPath = null;
			container.createDiv({ cls: "margin-notes-pdf-list-empty", text: "当前没有打开的 PDF" });
			return;
		}
		if (previousPath !== target.path) this.searchQuery = "";
		this.renderedPath = target.path;
		const restoreScroll = previousPath === target.path ? previousScroll : 0;

		const titleRow = container.createDiv("margin-notes-pdf-list-title-row");
		titleRow.createDiv({ cls: "margin-notes-pdf-list-title", text: target.basename });
		this.renderViewSegments(titleRow);

		// Make the shared group visible: otherwise notes appearing across several
		// translations look like unexplained duplication.
		const members = this.controller.sharedMembersOfActive();
		if (members.length > 1) {
			const row = container.createDiv({ cls: "margin-notes-pdf-list-pair" });
			setIcon(row.createSpan({ cls: "margin-notes-pdf-list-pair-icon" }), "arrow-left-right");
			row.createSpan({
				cls: "margin-notes-pdf-list-pair-label",
				text: `共用批注 · ${members.length} 份 PDF`,
			});
			const unlink = row.createEl("button", {
				cls: "margin-notes-pdf-list-unpair clickable-icon",
				attr: { "aria-label": "让当前 PDF 退出共享组并保留批注副本" },
			});
			setIcon(unlink, "unlink");
			unlink.addEventListener("click", (event) => {
				event.stopPropagation();
				this.controller.unpairActive();
			});
			row.setAttribute("aria-label", "点击轮流切换共享组中的 PDF");
			row.addEventListener("click", () => void this.controller.switchToCounterpart());
		}

		if (this.panelMode === "outline") {
			this.renderOutline(container, target.path, restoreScroll, generation);
			return;
		}

		const anns = this.controller.store.forFile(target.path);
		if (anns.length === 0) {
			container.createDiv({ cls: "margin-notes-pdf-list-empty", text: "这份 PDF 还没有批注" });
			this.restoreUi(restoreScroll, generation);
			return;
		}

		const layerAnns = anns.filter((ann) => annotationVisibleInLayer(ann, this.controller.annotationLayerFilter));
		const visibleAnns = filterAnnotations(layerAnns, this.searchQuery);
		this.renderToolbar(container, visibleAnns.length, layerAnns.length);
		if (visibleAnns.length === 0) {
			container.createDiv({
				cls: "margin-notes-pdf-list-empty",
				text: this.searchQuery ? "没有找到匹配批注" : "这个图层还没有批注",
			});
			this.restoreUi(restoreScroll, generation);
			return;
		}

		if (this.groupMode === "page") {
			const byPage = new Map<number, PdfAnnotation[]>();
			for (const ann of this.controller.sortAnnotations(target.path, visibleAnns)) {
				(byPage.get(ann.page) ?? byPage.set(ann.page, []).get(ann.page)!).push(ann);
			}
			for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
				this.renderPageGroup(container, target.path, page, byPage.get(page)!);
			}
		} else {
			const byColor = new Map<string, { color: string; label: string; order: number; anns: PdfAnnotation[] }>();
			for (const ann of this.controller.sortAnnotations(target.path, visibleAnns)) {
				const info = this.colorInfo(ann);
				const group = byColor.get(info.key) ?? {
					color: info.color,
					label: info.label,
					order: annotationColorOrder(ann, this.controller.settings),
					anns: [],
				};
				group.anns.push(ann);
				byColor.set(info.key, group);
			}
			const orderedGroups = [...byColor].sort(
				([, a], [, b]) => a.order - b.order || a.label.localeCompare(b.label, "zh-CN")
			);
			for (const [key, group] of orderedGroups) {
				this.renderColorGroup(container, target.path, key, group.color, group.label, group.anns);
			}
		}
		this.restoreUi(restoreScroll, generation);
	}

	private renderViewSegments(parent: HTMLElement): void {
		const segments = parent.createDiv({
			cls: "margin-notes-pdf-list-view-segments",
			attr: { role: "group", "aria-label": "侧栏内容", "data-mode": this.panelMode },
		});
		this.addViewButton(segments, "annotations", "message-square", "显示批注");
		this.addViewButton(segments, "outline", "list-tree", "显示共享大纲");
	}

	private addViewButton(parent: HTMLElement, mode: "annotations" | "outline", icon: string, label: string): void {
		const button = parent.createEl("button", {
			cls: "margin-notes-pdf-list-view-button clickable-icon",
			attr: { "aria-label": label, "aria-pressed": String(this.panelMode === mode) },
		});
		setIcon(button, icon);
		button.addEventListener("click", () => {
			if (this.panelMode === mode) return;
			this.panelMode = mode;
			parent.dataset.mode = mode;
			for (const item of parent.querySelectorAll<HTMLButtonElement>(".margin-notes-pdf-list-view-button")) {
				item.setAttribute("aria-pressed", String(item === button));
			}
			this.viewSwitchTimer = window.setTimeout(() => {
				this.viewSwitchTimer = null;
				this.render();
			}, 170);
		});
	}

	private renderOutline(parent: HTMLElement, pdfPath: string, restoreScroll: number, generation: number): void {
		const host = parent.createDiv("margin-notes-pdf-outline");
		const loading = host.createDiv({ cls: "margin-notes-pdf-list-empty", text: "正在读取大纲…" });
		this.restoreUi(restoreScroll, generation);
		void this.controller.sharedOutline(pdfPath).then((result) => {
			if (generation !== this.renderGeneration || this.panelMode !== "outline" || this.renderedPath !== pdfPath) return;
			loading.remove();
			if (!result.sourcePath || result.items.length === 0) {
				host.createDiv({
					cls: "margin-notes-pdf-list-empty",
					text: result.error
						? "读取 PDF 大纲失败"
						: this.controller.sharedMembersOfActive().length > 1
							? "共享组中没有可用大纲"
							: "这份 PDF 没有大纲；加入共享组后可继承其他 PDF 的大纲",
				});
				this.restoreUi(restoreScroll, generation);
				return;
			}

			const sourceName = result.sourcePath.split("/").pop() ?? result.sourcePath;
			const source = host.createDiv("margin-notes-pdf-outline-source");
			setIcon(source.createSpan({ cls: "margin-notes-pdf-outline-source-icon" }), "book-open");
			source.createSpan({
				cls: "margin-notes-pdf-outline-source-name",
				text: result.sourcePath === pdfPath ? "当前 PDF 大纲" : `共享大纲 · ${sourceName}`,
			});
			const tree = host.createDiv({ cls: "margin-notes-pdf-outline-tree", attr: { role: "tree" } });
			this.renderOutlineItems(tree, pdfPath, result.sourcePath, result.items, 0, "");
			this.restoreUi(restoreScroll, generation);
		}).catch(() => {
			if (generation !== this.renderGeneration || !loading.isConnected) return;
			loading.setText("读取 PDF 大纲失败");
		});
	}

	private renderOutlineItems(
		parent: HTMLElement,
		pdfPath: string,
		sourcePath: string,
		items: PdfOutlineItem[],
		depth: number,
		prefix: string
	): void {
		items.forEach((item, index) => {
			const trail = prefix ? `${prefix}.${index}` : String(index);
			const key = `${sourcePath}\u0000${trail}`;
			const hasChildren = item.items.length > 0;
			const collapsed = hasChildren && this.collapsedOutlineItems.has(key);
			const row = parent.createDiv({
				cls: "margin-notes-pdf-outline-row",
				attr: { role: "treeitem", "aria-level": String(depth + 1) },
			});
			row.style.setProperty("--margin-notes-pdf-outline-indent", `${3 + depth * 13}px`);
			if (hasChildren) {
				row.setAttribute("aria-expanded", String(!collapsed));
				const chevron = row.createEl("button", {
					cls: "margin-notes-pdf-outline-chevron clickable-icon",
					attr: { "aria-label": collapsed ? "展开子目录" : "折叠子目录" },
				});
				setIcon(chevron, "chevron-down");
				chevron.toggleClass("is-collapsed", collapsed);
				chevron.addEventListener("click", (event) => {
					event.stopPropagation();
					if (collapsed) this.collapsedOutlineItems.delete(key);
					else this.collapsedOutlineItems.add(key);
					this.render();
				});
			} else {
				row.createSpan({ cls: "margin-notes-pdf-outline-chevron-spacer" });
			}
			row.createSpan({ cls: "margin-notes-pdf-outline-title", text: item.title });
			if (item.page !== null) row.createSpan({ cls: "margin-notes-pdf-outline-page", text: String(item.page) });
			row.toggleClass("is-clickable", item.page !== null || hasChildren);
			row.addEventListener("click", () => {
				if (item.page !== null) {
					void this.controller.revealOutlineTarget(pdfPath, item);
					return;
				}
				if (!hasChildren) return;
				if (collapsed) this.collapsedOutlineItems.delete(key);
				else this.collapsedOutlineItems.add(key);
				this.render();
			});

			if (!collapsed && hasChildren) {
				this.renderOutlineItems(parent, pdfPath, sourcePath, item.items, depth + 1, trail);
			}
		});
	}

	private renderToolbar(parent: HTMLElement, visibleCount: number, totalCount: number): void {
		const toolbar = parent.createDiv("margin-notes-pdf-list-toolbar");
		const search = toolbar.createDiv("margin-notes-pdf-list-search");
		setIcon(search.createSpan({ cls: "margin-notes-pdf-list-search-icon" }), "search");
		const input = search.createEl("input", {
			type: "search",
			placeholder: "搜索批注",
			attr: { "aria-label": "搜索当前 PDF 的批注" },
		});
		input.value = this.searchQuery;
		this.searchInput = input;

		let composing = false;
		input.addEventListener("compositionstart", () => (composing = true));
		input.addEventListener("compositionend", () => {
			composing = false;
			this.applySearch(input.value);
		});
		input.addEventListener("input", () => {
			if (!composing) this.applySearch(input.value);
		});

		if (this.searchQuery) {
			search.createSpan({ cls: "margin-notes-pdf-list-search-count", text: `${visibleCount}/${totalCount}` });
			const clear = search.createEl("button", {
				cls: "margin-notes-pdf-list-search-clear clickable-icon",
				attr: { "aria-label": "清除搜索" },
			});
			setIcon(clear, "x");
			clear.addEventListener("click", () => this.applySearch(""));
		}

		const layerButton = toolbar.createEl("button", {
			cls: "margin-notes-pdf-list-layer-button clickable-icon",
			attr: { "aria-label": `显示图层：${this.controller.activeAnnotationLayerName}` },
		});
		setIcon(layerButton.createSpan({ cls: "margin-notes-pdf-list-layer-icon" }), "layers");
		layerButton.createSpan({ cls: "margin-notes-pdf-list-layer-name", text: this.controller.activeAnnotationLayerName });
		layerButton.toggleClass("is-active", this.controller.annotationLayerFilter !== null);
		layerButton.addEventListener("click", () => {
			const rect = layerButton.getBoundingClientRect();
			this.controller.openLayerFilterMenu({ x: rect.left, y: rect.bottom + 2 });
		});

		const segments = toolbar.createDiv({
			cls: "margin-notes-pdf-list-group-segments",
			attr: { role: "group", "aria-label": "批注分组方式", "data-mode": this.groupMode },
		});
		this.addGroupButton(segments, "page", "list-ordered", "按页码分组");
		this.addGroupButton(segments, "color", "palette", "按颜色分组");
	}

	private addGroupButton(parent: HTMLElement, mode: "page" | "color", icon: string, label: string): void {
		const button = parent.createEl("button", {
			cls: "margin-notes-pdf-list-group-button clickable-icon",
			attr: { "aria-label": label, "aria-pressed": String(this.groupMode === mode) },
		});
		setIcon(button, icon);
		button.addEventListener("click", () => {
			if (this.groupMode === mode) return;
			this.groupMode = mode;
			parent.dataset.mode = mode;
			for (const item of parent.querySelectorAll<HTMLButtonElement>(".margin-notes-pdf-list-group-button")) {
				item.setAttribute("aria-pressed", String(item === button));
			}
			this.groupSwitchTimer = window.setTimeout(() => {
				this.groupSwitchTimer = null;
				this.render();
			}, 170);
		});
	}

	private applySearch(value: string): void {
		if (value === this.searchQuery) return;
		this.searchQuery = value;
		this.focusSearchOnNextRender = true;
		this.render();
	}

	private restoreUi(top: number, generation: number): void {
		this.contentEl.scrollTop = top;
		window.requestAnimationFrame(() => {
			if (generation !== this.renderGeneration) return;
			this.contentEl.scrollTop = top;
			if (this.focusSearchOnNextRender && this.searchInput) {
				this.focusSearchOnNextRender = false;
				this.searchInput.focus();
				const end = this.searchInput.value.length;
				this.searchInput.setSelectionRange(end, end);
			}
		});
	}

	private colorOf(ann: PdfAnnotation): string {
		return resolveAnnotationColor(ann, this.controller.settings).toLowerCase();
	}

	private colorInfo(ann: PdfAnnotation): { key: string; color: string; label: string } {
		const slot = colorSlot(this.controller.settings, ann.colorKey);
		if (slot) return { key: `slot:${slot.id}`, color: slot.color, label: slot.name };
		const color = this.colorOf(ann);
		return {
			key: ann.pinned ? "default:rail" : "default:free",
			color,
			label: ann.pinned ? "默认轨道颜色" : "默认自由批注颜色",
		};
	}

	private renderPageGroup(parent: HTMLElement, pdfPath: string, page: number, anns: PdfAnnotation[]): void {
		const group = parent.createDiv("margin-notes-pdf-page-group");
		const collapsed = !this.searchQuery && this.collapsedPages.has(page);
		group.toggleClass("is-collapsed", collapsed);

		const header = group.createDiv("margin-notes-pdf-page-header");
		const chevron = header.createSpan({ cls: "margin-notes-pdf-page-chevron" });
		setIcon(chevron, "chevron-down");
		header.createSpan({ cls: "margin-notes-pdf-page-title", text: `第 ${page} 页` });
		header.createSpan({ cls: "margin-notes-pdf-page-count", text: String(anns.length) });
		header.addEventListener("click", () => {
			if (this.collapsedPages.has(page)) this.collapsedPages.delete(page);
			else this.collapsedPages.add(page);
			this.render();
		});

		if (collapsed) return;

		const rows = group.createDiv("margin-notes-pdf-page-rows");
		for (const ann of anns) this.renderRow(rows, pdfPath, ann);
	}

	private renderColorGroup(
		parent: HTMLElement,
		pdfPath: string,
		key: string,
		color: string,
		label: string,
		anns: PdfAnnotation[]
	): void {
		const group = parent.createDiv("margin-notes-pdf-page-group");
		const collapsed = !this.searchQuery && this.collapsedColors.has(key);
		group.toggleClass("is-collapsed", collapsed);

		const header = group.createDiv("margin-notes-pdf-page-header");
		const chevron = header.createSpan({ cls: "margin-notes-pdf-page-chevron" });
		setIcon(chevron, "chevron-down");
		header.createSpan({ cls: "margin-notes-pdf-color-swatch" }).style.background = color;
		header.createSpan({ cls: "margin-notes-pdf-page-title", text: label });
		header.createSpan({ cls: "margin-notes-pdf-page-count", text: String(anns.length) });
		header.addEventListener("click", () => {
			if (this.collapsedColors.has(key)) this.collapsedColors.delete(key);
			else this.collapsedColors.add(key);
			this.render();
		});

		if (collapsed) return;
		const rows = group.createDiv("margin-notes-pdf-page-rows");
		for (const ann of anns) this.renderRow(rows, pdfPath, ann, true);
	}

	private renderRow(parent: HTMLElement, pdfPath: string, ann: PdfAnnotation, showPage = false): void {
		const handle = buildAnnotationBox(parent, "margin-notes-pdf-list-row", {
			app: this.app,
			component: this,
			sourcePath: pdfPath,
			initialText: ann.text,
			placeholder: "(空批注,点击写点什么)",
			onCommit: (text) => {
				ann.text = text;
				ann.updatedAt = Date.now();
				this.controller.store.upsert(pdfPath, ann);
			},
				actions: [
				{
					icon: "layers",
					title: "设置所属图层",
					onClick: (event) =>
						this.controller.openAnnotationLayerMenu(pdfPath, ann, { x: event.clientX, y: event.clientY }),
				},
				{
					icon: "arrow-up-right",
					title: "跳转到 PDF 里的位置",
					onClick: () => void this.controller.revealAnnotation(pdfPath, ann),
				},
				{
					icon: "x",
					title: "删除批注",
					cls: "margin-notes-pdf-del",
					onClick: () => this.controller.store.remove(pdfPath, ann.id),
				},
			],
		});
		if (showPage) {
			const page = handle.el.createDiv({ cls: "margin-notes-pdf-list-row-page", text: `第 ${ann.page} 页` });
			handle.el.insertBefore(page, handle.bodyEl);
		}
		handle.el.dataset.mode = ann.pinned ? "rail" : "free";
		handle.el.style.setProperty("--margin-notes-pdf-note-color", this.colorOf(ann));
		handle.el.addEventListener("mouseenter", () => this.controller.peekAnnotation(ann));
		handle.el.addEventListener("mouseleave", () => this.controller.clearPeek());
		void handle.render();
	}
}
