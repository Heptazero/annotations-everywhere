import { Notice, TFile, TFolder, type App, type Plugin } from "obsidian";
import type { PdfAnnotationStore } from "./annotation-store";

const MISSING_MEMBER_GRACE_MS = 3000;

export interface SharedFileLifecycleOptions {
	app: App;
	plugin: Plugin;
	store: PdfAnnotationStore;
	getDoubleColumnSplits: () => Record<string, number>;
	setDoubleColumnSplits: (next: Record<string, number>) => void;
	refreshOutlines: () => void;
	onPdfModified: (path: string) => void;
}

/**
 * Owns only vault-file events for shared PDFs. Layout compatibility, annotation
 * rendering and persistence remain outside this class.
 */
export class SharedFileLifecycle {
	private missingTimers = new Map<string, number>();
	private startupTimer = 0;

	constructor(private options: SharedFileLifecycleOptions) {}

	register(): void {
		const { app, plugin } = this.options;
		plugin.register(() => this.destroy());
		plugin.registerEvent(app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		plugin.registerEvent(app.vault.on("delete", (file) => this.onDelete(file)));
		plugin.registerEvent(
			app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension.toLowerCase() === "pdf") this.options.onPdfModified(file.path);
			})
		);
	}

	onLayoutReady(): void {
		window.clearTimeout(this.startupTimer);
		this.startupTimer = window.setTimeout(() => this.detachConfirmedMissing(), MISSING_MEMBER_GRACE_MS);
	}

	private onRename(file: unknown, oldPath: string): void {
		if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
			this.cancelMissing(oldPath);
			this.options.store.renameFile(oldPath, file.path);
			this.remapDoubleColumnPaths(oldPath, file.path, false);
			this.options.refreshOutlines();
			return;
		}
		if (!(file instanceof TFolder)) return;
		this.cancelMissingPrefix(oldPath);
		const changed = this.options.store.renameFolder(oldPath, file.path);
		const settingsChanged = this.remapDoubleColumnPaths(oldPath, file.path, true);
		if (changed > 0 || settingsChanged) this.options.refreshOutlines();
	}

	private onDelete(file: unknown): void {
		if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
			this.queueMissing(file.path);
			return;
		}
		if (!(file instanceof TFolder)) return;
		for (const path of this.options.store.pairedPaths()) {
			if (path === file.path || path.startsWith(`${file.path}/`)) this.queueMissing(path);
		}
	}

	private remapDoubleColumnPaths(oldPath: string, newPath: string, descendants: boolean): boolean {
		const current = this.options.getDoubleColumnSplits();
		let changed = false;
		const next: Record<string, number> = {};
		for (const [path, split] of Object.entries(current)) {
			const moved = path === oldPath || (descendants && path.startsWith(`${oldPath}/`));
			const nextPath = moved ? `${newPath}${path.slice(oldPath.length)}` : path;
			if (nextPath !== path) changed = true;
			next[nextPath] = split;
		}
		if (changed) this.options.setDoubleColumnSplits(next);
		return changed;
	}

	private cancelMissing(path: string): void {
		const timer = this.missingTimers.get(path);
		if (timer !== undefined) window.clearTimeout(timer);
		this.missingTimers.delete(path);
	}

	private cancelMissingPrefix(prefix: string): void {
		for (const path of [...this.missingTimers.keys()]) {
			if (path === prefix || path.startsWith(`${prefix}/`)) this.cancelMissing(path);
		}
	}

	private queueMissing(path: string): void {
		this.cancelMissing(path);
		const timer = window.setTimeout(() => {
			this.missingTimers.delete(path);
			if (this.options.app.vault.getAbstractFileByPath(path) instanceof TFile) return;
			if (!this.options.store.detachFile(path)) return;
			const splits = this.options.getDoubleColumnSplits();
			if (splits[path] !== undefined) {
				const next = { ...splits };
				delete next[path];
				this.options.setDoubleColumnSplits(next);
			}
			this.options.refreshOutlines();
		}, MISSING_MEMBER_GRACE_MS);
		this.missingTimers.set(path, timer);
	}

	private detachConfirmedMissing(): void {
		const existing = new Set(
			this.options.app.vault
				.getFiles()
				.filter((file) => file.extension.toLowerCase() === "pdf")
				.map((file) => file.path)
		);
		const detached = this.options.store.detachMissingFiles(existing);
		if (detached > 0) new Notice(`已清理 ${detached} 个失效的 PDF 关联成员;批注仍保留`, 6000);
	}

	destroy(): void {
		for (const timer of this.missingTimers.values()) window.clearTimeout(timer);
		this.missingTimers.clear();
		window.clearTimeout(this.startupTimer);
	}
}
