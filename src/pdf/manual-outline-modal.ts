import { Modal, Setting, type App } from "obsidian";
import type { ManualOutlineEntry } from "./manual-outline";

/** Only the start page is required; chapter endings are derived from following headings. */
export class ManualOutlineModal extends Modal {
	constructor(
		app: App,
		private initial: ManualOutlineEntry | null,
		private initialPage: number,
		private pageCount: number | null,
		private onSave: (entry: ManualOutlineEntry) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.initial ? "编辑手动大纲标题" : "添加手动大纲标题");
		const content = this.contentEl;
		content.empty();
		let title = this.initial?.title ?? "";
		let page = String(this.initial?.page ?? this.initialPage);
		let level = this.initial?.level ?? 1;
		let focusTitle: (() => void) | null = null;
		new Setting(content).setName("标题").addText((input) => {
			input.setPlaceholder("例如：方法").setValue(title).onChange((value) => (title = value));
			focusTitle = () => input.inputEl.focus();
			input.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") save();
			});
		});
		new Setting(content)
			.setName("起始页")
			.setDesc("只填开始的 PDF 页码；本标题持续到下一个同级或更高层级标题。")
			.addText((input) => {
				input.setValue(page).onChange((value) => (page = value));
				input.inputEl.type = "number";
				input.inputEl.min = "1";
				if (this.pageCount !== null) input.inputEl.max = String(this.pageCount);
			});
		new Setting(content).setName("层级").addDropdown((dropdown) => {
			for (let value = 1; value <= 6; value++) dropdown.addOption(String(value), `第 ${value} 级`);
			dropdown.setValue(String(level)).onChange((value) => (level = Number(value)));
		});
		const error = content.createDiv({ cls: "margin-notes-outline-form-error" });
		const save = () => {
			const cleanTitle = title.replace(/\s+/g, " ").trim();
			const startPage = Number(page);
			if (!cleanTitle) { error.setText("请填写标题"); return; }
			if (!Number.isInteger(startPage) || startPage < 1 || (this.pageCount !== null && startPage > this.pageCount)) {
				error.setText(this.pageCount === null ? "请输入有效的 PDF 页码" : `页码应在 1–${this.pageCount} 之间`);
				return;
			}
			this.onSave({ id: this.initial?.id ?? `outline-${crypto.randomUUID()}`, title: cleanTitle, page: startPage, level });
			this.close();
		};
		new Setting(content).addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("保存标题").setCta().onClick(save));
		window.setTimeout(() => focusTitle?.(), 0);
	}
}

export class DeleteManualOutlineModal extends Modal {
	constructor(app: App, private headingTitle: string, private onDelete: () => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText("删除手动大纲标题？");
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: `只删除「${this.headingTitle}」这个手动标题；批注和 PDF 文件不受影响。` });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("删除标题").setWarning().onClick(() => {
				this.close();
				this.onDelete();
			}));
	}
}
