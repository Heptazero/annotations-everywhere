import { Modal, Notice, Setting, setIcon, type App } from "obsidian";
import {
	type AnnotationSelectionRef,
	type AnnotationTransferMode,
	type PageRangeMapping,
	validatePageMappings,
} from "./annotation-batch";
import { PdfPathSuggest } from "./pdf-path-suggest";

export interface AnnotationTransferRequest {
	mode: AnnotationTransferMode;
	targetPath: string;
	mappings: PageRangeMapping[];
}

export class AnnotationTransferModal extends Modal {
	private suggest: PdfPathSuggest | null = null;

	constructor(
		app: App,
		private count: number,
		private selectedPages: number[],
		private candidates: string[],
		private onSubmit: (request: AnnotationTransferRequest) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`复制或移动 ${this.count} 条批注`);
		this.contentEl.empty();
		this.contentEl.addClass("margin-notes-manager-transfer-modal");
		let mode: AnnotationTransferMode = "copy";
		let targetPath = "";
		const minPage = Math.min(...this.selectedPages);
		const maxPage = Math.max(...this.selectedPages);
		const mappings: PageRangeMapping[] = [{ sourceFrom: minPage, sourceTo: maxPage, targetFrom: minPage }];

		const modeControl = this.contentEl.createDiv({
			cls: "margin-notes-manager-segments",
			attr: { role: "group", "aria-label": "批注转移方式" },
		});
		const addMode = (value: AnnotationTransferMode, label: string) => {
			const button = modeControl.createEl("button", {
				text: label,
				attr: { type: "button", "aria-pressed": String(mode === value) },
			});
			button.addEventListener("click", () => {
				mode = value;
				for (const item of modeControl.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button));
			});
		};
		addMode("copy", "复制");
		addMode("move", "移动");

		new Setting(this.contentEl)
			.setName("目标 PDF")
			.setDesc("输入文件名或路径并从候选项中选择。")
			.addText((text) => {
				text.setPlaceholder("搜索 PDF").onChange((value) => {
					targetPath = this.candidates.includes(value) ? value : "";
				});
				text.inputEl.setAttribute("aria-label", "搜索目标 PDF");
				this.suggest = new PdfPathSuggest(this.app, text.inputEl, this.candidates, (path) => {
					targetPath = path;
				});
			});

		this.contentEl.createDiv({ cls: "setting-item-name margin-notes-manager-mapping-title", text: "页码对应" });
		this.contentEl.createDiv({
			cls: "margin-notes-manager-mapping-hint",
			text: "原 PDF 起始页 – 结束页 → 目标 PDF 起始页；批注按相对页码平移。",
		});
		const mappingHost = this.contentEl.createDiv("margin-notes-manager-mappings");
		const renderMappings = () => {
			mappingHost.empty();
			mappings.forEach((mapping, index) => {
				const row = mappingHost.createDiv("margin-notes-manager-mapping-row");
				const numberInput = (label: string, value: number, update: (next: number) => void) => {
					const input = row.createEl("input", {
						type: "number",
						value: String(value),
						attr: { min: "1", inputmode: "numeric", "aria-label": label },
					});
					input.addEventListener("input", () => update(Number(input.value)));
				};
				numberInput("原 PDF 起始页", mapping.sourceFrom, (value) => (mapping.sourceFrom = value));
				row.createSpan({ text: "–" });
				numberInput("原 PDF 结束页", mapping.sourceTo, (value) => (mapping.sourceTo = value));
				row.createSpan({ text: "→" });
				numberInput("目标 PDF 起始页", mapping.targetFrom, (value) => (mapping.targetFrom = value));
				const remove = row.createEl("button", {
					cls: "clickable-icon",
					attr: { type: "button", "aria-label": "删除这组页码对应", title: "删除" },
				});
				setIcon(remove, "trash-2");
				remove.disabled = mappings.length === 1;
				remove.addEventListener("click", () => {
					mappings.splice(index, 1);
					renderMappings();
				});
			});
		};
		renderMappings();
		const addMapping = this.contentEl.createEl("button", {
			cls: "margin-notes-manager-add-mapping",
			text: "添加一段页码对应",
			attr: { type: "button" },
		});
		addMapping.addEventListener("click", () => {
			const last = mappings[mappings.length - 1];
			const nextSource = last.sourceTo + 1;
			const nextTarget = last.targetFrom + last.sourceTo - last.sourceFrom + 1;
			mappings.push({ sourceFrom: nextSource, sourceTo: nextSource, targetFrom: nextTarget });
			renderMappings();
		});

		const error = this.contentEl.createDiv("margin-notes-manager-form-error");
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("继续").setCta().onClick(async () => {
				error.empty();
				if (!targetPath) { error.setText("请从候选项中选择目标 PDF"); return; }
				const mappingError = validatePageMappings(mappings);
				if (mappingError) { error.setText(mappingError); return; }
				button.setDisabled(true);
				try {
					await this.onSubmit({ mode, targetPath, mappings: mappings.map((item) => ({ ...item })) });
					this.close();
				} catch (cause) {
					error.setText(String(cause instanceof Error ? cause.message : cause));
					button.setDisabled(false);
				}
			}));
	}

	onClose(): void {
		this.suggest?.close();
		this.suggest = null;
	}
}

export class DeleteAnnotationsModal extends Modal {
	constructor(
		app: App,
		private refs: AnnotationSelectionRef[],
		private sharedGroups: number,
		private onDelete: () => number
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`删除 ${this.refs.length} 条批注？`);
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: this.sharedGroups > 0
				? `将删除底层批注记录；其中 ${this.sharedGroups} 个共享组的所有成员都会同时看不到这些批注。`
				: "将删除底层批注记录。",
		});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("删除批注").setWarning().onClick(() => {
				try {
					const removed = this.onDelete();
					new Notice(removed === this.refs.length
						? `已删除 ${removed} 条批注`
						: `实际删除 ${removed} 条；部分批注已经变化`, 7000);
					this.close();
				} catch (cause) {
					new Notice(String(cause instanceof Error ? cause.message : cause), 7000);
				}
			}));
	}
}
