import { normalizePath, TFile, type App } from "obsidian";
import type { PdfAnnotationSettings } from "./annotation-settings";

const SOURCE_PROPERTY = "source";
export const DEFAULT_ANNOTATION_PROPERTY = "has_annotations";
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

export interface AnnotationCountReader {
	annotationCount(pdfPath: string): number;
}

export interface AnnotationPropertyChange {
	note: TFile;
	property: string;
	before: boolean | undefined;
	after: true | undefined;
}

export interface AnnotationPropertyApplyResult {
	updated: number;
	skipped: number;
}

export function sourceLinkTargets(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value];
	const targets: string[] = [];
	for (const entry of values) {
		if (typeof entry !== "string") continue;
		for (const match of entry.matchAll(WIKI_LINK_RE)) {
			const target = match[1]?.trim();
			if (target && !targets.includes(target)) targets.push(target);
		}
	}
	return targets;
}

export function normalizeAnnotationPropertyName(value: unknown): string {
	if (typeof value !== "string") return DEFAULT_ANNOTATION_PROPERTY;
	const property = value.trim();
	if (!property || property.toLowerCase() === SOURCE_PROPERTY || /[\r\n\0]/.test(property)) {
		return DEFAULT_ANNOTATION_PROPERTY;
	}
	return property;
}

/**
 * Projects annotation state onto Markdown through one stable, file-first
 * contract: the note's source property. Folder, basename and backlinks are not
 * evidence of a relation.
 */
export class SourceAnnotationSync {
	private timer: number | null = null;
	private running = false;
	private rerun = false;

	constructor(
		private app: App,
		private counts: AnnotationCountReader,
		private getSettings: () => PdfAnnotationSettings
	) {}

	plan(propertyName = this.getSettings().annotationPropertyName): AnnotationPropertyChange[] {
		const property = normalizeAnnotationPropertyName(propertyName);
		return this.app.vault.getMarkdownFiles().flatMap((note) => {
			const change = this.changeFor(note, property);
			return change ? [change] : [];
		});
	}

	async apply(changes: AnnotationPropertyChange[]): Promise<AnnotationPropertyApplyResult> {
		let updated = 0;
		let skipped = 0;
		for (const preview of changes) {
			const current = this.changeFor(preview.note, preview.property);
			if (!current || current.before !== preview.before || current.after !== preview.after) {
				skipped++;
				continue;
			}

			await this.app.fileManager.processFrontMatter(preview.note, (frontmatter) => {
				if (preview.after === true) frontmatter[preview.property] = true;
				else delete frontmatter[preview.property];
			});
			updated++;
		}
		return { updated, skipped };
	}

	queue(): void {
		if (!this.getSettings().syncAnnotationProperty) return;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.run();
		}, 600);
	}

	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private run(): void {
		if (this.running) {
			this.rerun = true;
			return;
		}
		this.running = true;
		this.apply(this.plan())
			.catch(() => undefined)
			.finally(() => {
				this.running = false;
				if (this.rerun) {
					this.rerun = false;
					this.queue();
				}
			});
	}

	private changeFor(note: TFile, property: string): AnnotationPropertyChange | null {
		const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
		const targets = sourceLinkTargets(frontmatter?.[SOURCE_PROPERTY]);
		if (targets.length === 0) return null;

		const hasAnnotations = targets.some((target) => {
			const file = this.app.metadataCache.getFirstLinkpathDest(target, note.path);
			return Boolean(
				file instanceof TFile &&
				file.extension.toLowerCase() === "pdf" &&
				this.counts.annotationCount(normalizePath(file.path)) > 0
			);
		});
		const after = hasAnnotations ? true : undefined;
		const rawBefore: unknown = frontmatter?.[property];
		if (rawBefore !== undefined && typeof rawBefore !== "boolean") return null;
		const before = rawBefore as boolean | undefined;
		if (before === after) return null;
		return { note, property, before, after };
	}
}
