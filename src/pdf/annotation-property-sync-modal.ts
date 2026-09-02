import { Modal, Notice, Setting, type App } from "obsidian";
import type { AnnotationPropertyChange, AnnotationPropertyApplyResult } from "./source-annotation-sync";

export class AnnotationPropertySyncModal extends Modal {
	constructor(
		app: App,
		private changes: AnnotationPropertyChange[],
		private onApply: (changes: AnnotationPropertyChange[]) => Promise<AnnotationPropertyApplyResult>,
		private onComplete: (result: AnnotationPropertyApplyResult) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("margin-notes-annotation-property-preview");
		contentEl.createEl("h3", { text: "确认批注属性同步" });
		contentEl.createEl("p", {
			text: `以下 ${this.changes.length} 篇笔记会被修改。确认前不会写入任何笔记。`,
		});

		const table = contentEl.createEl("table");
		const header = table.createEl("thead").createEl("tr");
		header.createEl("th", { text: "笔记" });
		header.createEl("th", { text: "改动" });
		const body = table.createEl("tbody");
		for (const change of this.changes) {
			const row = body.createEl("tr");
			row.createEl("td", { text: change.note.path });
			row.createEl("td", {
				text: change.after === true
					? `${change.property}: true`
					: `删除 ${change.property}`,
			});
		}

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("确认并同步")
					.setCta()
					.onClick(() => {
						button.setDisabled(true);
						this.onApply(this.changes)
							.then((result) => {
								this.onComplete(result);
								this.close();
							})
							.catch(() => {
								button.setDisabled(false);
								new Notice("同步中断；已完成的修改保留，剩余笔记未继续处理");
							});
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
