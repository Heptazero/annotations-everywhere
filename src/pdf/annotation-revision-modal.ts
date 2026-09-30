import { Modal, Notice, Setting, type App } from "obsidian";
import type { PdfAnnotationStore } from "./annotation-store";

export class AnnotationRevisionMigrationModal extends Modal {
	constructor(app: App, private store: PdfAnnotationStore) { super(app); }

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: "改用分文件批注" });
		this.contentEl.createEl("p", { text: `当前载入 ${this.store.totalAnnotationCount} 条批注。迁移会把现有批注拆成独立记录文件，并在校验成功后删除旧 annotations.json。之后每次修改各写一份独立修订。` });
		this.contentEl.createEl("p", { text: "请先让电脑和手机同步完成，并在另一设备关闭旧版 Margin Notes。旧版插件若继续写 annotations.json，会造成两个数据源分叉。迁移后不要直接用旧版插件编辑。" });
		let confirmed = false;
		let migrateButton: HTMLButtonElement;
		new Setting(this.contentEl)
			.setName("两端已同步，另一设备旧版插件已停用")
			.addToggle((toggle) => toggle.setValue(false).onChange((value) => {
				confirmed = value;
				migrateButton.disabled = !value;
			}));
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("开始迁移").setCta().onClick(async () => {
				if (!confirmed) return;
				button.setDisabled(true);
				try {
					await this.store.migrateToRevisionFiles();
					new Notice(`已启用分文件批注；原有 ${this.store.totalAnnotationCount} 条仍保留`);
					this.close();
				} catch (error) {
					button.setDisabled(false);
					new Notice(`迁移未完成：${String(error instanceof Error ? error.message : error)}`, 9000);
				}
			}));
		migrateButton = this.contentEl.querySelector(".mod-cta") as HTMLButtonElement;
		migrateButton.disabled = true;
	}

	onClose(): void { this.contentEl.empty(); }
}

function preview(text: string): string {
	return text.replace(/\s+/g, " ").slice(0, 120) || "（无正文）";
}

export class AnnotationRevisionConflictModal extends Modal {
	constructor(app: App, private store: PdfAnnotationStore) { super(app); }

	onOpen(): void { this.render(); }

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: "批注同步冲突" });
		const conflicts = this.store.journalConflicts;
		if (conflicts.length === 0 && !this.store.hasJournalMetadataConflict) {
			this.contentEl.createEl("p", { text: "没有待处理的同步冲突。" });
			return;
		}
		this.contentEl.createEl("p", { text: "两端都改动了同一项。所有版本仍保存在修订文件中；请选择要显示的版本，或把两份批注都留下。" });
		for (const conflict of conflicts) {
			const [bucket] = JSON.parse(conflict.key) as [string, string];
			this.contentEl.createEl("h4", { text: bucket });
			for (const [index, version] of conflict.versions.entries()) {
				const label = version.value
					? `版本 ${index + 1} · 第 ${version.value.page} 页 · ${preview(version.value.text)}`
					: `版本 ${index + 1} · 已删除`;
				new Setting(this.contentEl).setName(label)
					.addButton((button) => button.setButtonText("保留此版本").onClick(async () => {
						try { await this.store.resolveRevisionConflict(conflict.key, version.revision); this.render(); }
						catch (error) { new Notice(String(error instanceof Error ? error.message : error)); }
					}));
			}
			if (conflict.versions.length === 2 && conflict.versions.every((version) => version.value !== null)) {
				new Setting(this.contentEl).setName("两份都保留为独立批注")
					.addButton((button) => button.setButtonText("保留两份").onClick(async () => {
						try { await this.store.preserveBothRevisionConflicts(conflict.key, conflict.versions[0].revision); this.render(); }
						catch (error) { new Notice(String(error instanceof Error ? error.message : error)); }
					}));
			}
		}
		if (this.store.hasJournalMetadataConflict) {
			this.contentEl.createEl("h4", { text: "共享绑定或手动大纲冲突" });
			this.contentEl.createEl("p", { text: "这类结构变更不能自动合并。选择一版后，请检查另一版中是否有需要重新添加的绑定或标题。" });
			for (const [index, version] of this.store.journalMetadataVersions.entries()) {
				const members = Object.keys(version.value.pairs).length;
				const headings = Object.values(version.value.manualOutlines).reduce((sum, list) => sum + list.length, 0);
				new Setting(this.contentEl).setName(`版本 ${index + 1} · ${members} 个绑定成员 · ${headings} 个标题记录`)
					.addButton((button) => button.setButtonText("保留此版本").onClick(async () => {
						try { await this.store.resolveRevisionMetadataConflict(version.revision); this.render(); }
						catch (error) { new Notice(String(error instanceof Error ? error.message : error)); }
					}));
			}
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
