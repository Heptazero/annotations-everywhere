import { Modal, Setting, type App } from "obsidian";
import type { OrphanedAnnotationSource } from "./annotation-recovery";
import { PdfPathSuggest } from "./pdf-path-suggest";

/** Starts at one orphan bucket and searches for the live PDF that should own it. */
export class AnnotationRecoveryTargetModal extends Modal {
	private suggest: PdfPathSuggest | null = null;

	constructor(
		app: App,
		private source: OrphanedAnnotationSource,
		private candidates: string[],
		private onSubmit: (targetPath: string) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`挂载 ${this.source.count} 条批注`);
		this.contentEl.empty();
		this.contentEl.createDiv({ cls: "setting-item-name", text: "原路径（文件已不存在）" });
		this.contentEl.createDiv({ cls: "margin-notes-manager-recovery-path", text: this.source.path });
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `旧批注最远到第 ${this.source.maxPage} 页。插件会确认目标 PDF 至少包含这些页；页数只能排除不可能的目标，不能证明它就是原文件。`,
		});

		let targetPath = "";
		new Setting(this.contentEl)
			.setName("目标 PDF")
			.setDesc("输入文件名或路径并从候选项中选择。相似文件名会优先显示。")
			.addText((text) => {
				text.setPlaceholder("搜索现存 PDF").onChange((value) => {
					targetPath = this.candidates.includes(value) ? value : "";
				});
				text.inputEl.setAttribute("aria-label", "搜索批注要挂载到的 PDF");
				this.suggest = new PdfPathSuggest(this.app, text.inputEl, this.candidates, (path) => {
					targetPath = path;
				});
			});

		const error = this.contentEl.createDiv("margin-notes-manager-form-error");
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("挂载").setCta().onClick(async () => {
				error.empty();
				if (!targetPath) { error.setText("请从候选项中选择目标 PDF"); return; }
				button.setDisabled(true);
				try {
					await this.onSubmit(targetPath);
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
