import { Modal, Setting, type App } from "obsidian";

export class LayerDeleteModal extends Modal {
	constructor(
		app: App,
		private layerName: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`删除图层「${this.layerName}」？`);
		this.contentEl.createEl("p", { text: "只删除图层归属；批注正文、颜色和位置都会保留。" });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("删除图层")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}
}
