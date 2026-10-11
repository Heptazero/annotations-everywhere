import { TFile, parseLinktext, type App } from "obsidian";
import { parsePdfReferenceSubpath, type PdfReferenceTarget } from "./pdf-reference-target";

export interface PdfReferenceSource {
	sourcePath: string;
	line: number;
	ch: number;
	link: string;
	target: PdfReferenceTarget;
}

/** In-memory derived index. Never writes links, annotations or block markers. */
export class PdfReferenceIndex {
	private cache = new Map<string, PdfReferenceSource[]>();
	constructor(private app: App) {}
	invalidate(): void { this.cache.clear(); }
	forPdf(pdfPath: string): PdfReferenceSource[] {
		const cached = this.cache.get(pdfPath);
		if (cached) return cached;
		const refs: PdfReferenceSource[] = [];
		const seen = new Set<string>();
		for (const [sourcePath, destinations] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (!destinations[pdfPath]) continue;
			const file = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(file instanceof TFile) || file.extension !== "md") continue;
			const metadata = this.app.metadataCache.getFileCache(file);
			for (const link of [...metadata?.links ?? [], ...metadata?.embeds ?? []]) {
				const parsed = parseLinktext(link.link);
				const target = parsePdfReferenceSubpath(parsed.subpath);
				if (!target || this.app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath)?.path !== pdfPath) continue;
				const { line, col: ch } = link.position.start;
				const key = JSON.stringify([sourcePath, line, ch, link.link]);
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push({ sourcePath, line, ch, link: link.link, target });
			}
		}
		refs.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line || a.ch - b.ch);
		this.cache.set(pdfPath, refs);
		return refs;
	}
}
