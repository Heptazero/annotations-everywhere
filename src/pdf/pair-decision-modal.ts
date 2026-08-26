import { Modal, Setting, type App } from "obsidian";
import type { PdfLayoutSummary } from "./layout-check";
import type { SharedStrategy } from "./pairing-state";

export interface PairDecision {
	strategy: SharedStrategy;
}

export interface PairDecisionInfo {
	currentPath: string;
	otherPath: string;
	currentCount: number;
	otherCount: number;
	layout: PdfLayoutSummary;
}

export class PairDecisionModal extends Modal {
	constructor(
		app: App,
		private info: PairDecisionInfo,
		private onChoose: (decision: PairDecision) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.renderChoices();
	}

	private renderChoices(): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		titleEl.setText("合并批注并加入共享组");
		contentEl.createEl("p", { text: `当前 PDF／共享组：${this.info.currentCount} 条批注` });
		contentEl.createEl("p", { text: `${fileName(this.info.otherPath)}／其共享组：${this.info.otherCount} 条批注` });
		contentEl.createEl("p", {
			cls: this.info.layout.compatible ? "mod-success" : "mod-warning",
			text: this.info.layout.reason,
		});

		new Setting(contentEl)
			.setName("合并全部批注")
			.setDesc("保留两边全部批注；完全相同的记录自动去重，同 ID 的不同版本会分别保留。")
			.addButton((button) =>
				button.setButtonText("合并并共享").setCta().onClick(() => this.choose({ strategy: "merge" }))
			);

		const details = contentEl.createEl("details");
		details.createEl("summary", { text: "更多选项：只保留一边的批注" });
		details.createEl("p", {
			cls: "setting-item-description",
			text: "以下操作会替换另一边现有批注，只在你明确要把一边作为唯一版本时使用。",
		});
		new Setting(details)
			.setName("以当前 PDF 为准")
			.setDesc(`共享后只保留当前 PDF 的 ${this.info.currentCount} 条批注。`)
			.addButton((button) =>
				button.setButtonText("使用当前").setWarning().onClick(() => this.confirmOverwrite("current"))
			);
		new Setting(details)
			.setName("以另一份 PDF 为准")
			.setDesc(`共享后只保留另一份 PDF 的 ${this.info.otherCount} 条批注。`)
			.addButton((button) =>
				button.setButtonText("使用另一份").setWarning().onClick(() => this.confirmOverwrite("other"))
			);
	}

	private confirmOverwrite(strategy: "current" | "other"): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		titleEl.setText("确认替换批注");
		const source = strategy === "current" ? fileName(this.info.currentPath) : fileName(this.info.otherPath);
		const removed = strategy === "current" ? this.info.otherCount : this.info.currentCount;
		contentEl.createEl("p", {
			text: `将以 ${source} 为准,另一边现有的 ${removed} 条批注不会进入共享结果。`,
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("返回").onClick(() => this.renderChoices()))
			.addButton((button) =>
				button
					.setButtonText("确认替换并共享")
					.setWarning()
					.onClick(() => this.choose({ strategy }))
			);
	}

	private choose(decision: PairDecision): void {
		this.close();
		this.onChoose(decision);
	}
}

function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
