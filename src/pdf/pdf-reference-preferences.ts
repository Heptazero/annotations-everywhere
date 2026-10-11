export type PdfReferenceCopyMode = "link" | "inline" | "quote";
export type ReferencedRegionStyle = "none" | "underline" | "box";
export interface PdfReferencePreferences {
	pdfReferenceIndicator: boolean;
	pdfReferencedStyle: ReferencedRegionStyle;
	pdfReferenceCopyMode: PdfReferenceCopyMode;
	pdfReferenceLinkLabel: string;
	pdfReferenceLinkTemplate: string;
	pdfReferenceInlineTemplate: string;
	pdfReferenceQuoteTemplate: string;
}
export const DEFAULT_REFERENCE_PREFERENCES: PdfReferencePreferences = {
	pdfReferenceIndicator: true, pdfReferencedStyle: "none", pdfReferenceCopyMode: "link",
	pdfReferenceLinkLabel: "p. {{page}}", pdfReferenceLinkTemplate: "{{link}}",
	pdfReferenceInlineTemplate: "{{text}} {{link}}", pdfReferenceQuoteTemplate: "> {{text}}\n> {{link}}",
};
export function normalizeReferencePreferences(raw: Partial<PdfReferencePreferences>): PdfReferencePreferences {
	const text = (key: keyof PdfReferencePreferences) => typeof raw[key] === "string" ? String(raw[key]) : String(DEFAULT_REFERENCE_PREFERENCES[key]);
	return {
		pdfReferenceIndicator: raw.pdfReferenceIndicator !== false,
		pdfReferencedStyle: raw.pdfReferencedStyle === "underline" || raw.pdfReferencedStyle === "box" ? raw.pdfReferencedStyle : "none",
		pdfReferenceCopyMode: raw.pdfReferenceCopyMode === "inline" || raw.pdfReferenceCopyMode === "quote" ? raw.pdfReferenceCopyMode : "link",
		pdfReferenceLinkLabel: text("pdfReferenceLinkLabel"), pdfReferenceLinkTemplate: text("pdfReferenceLinkTemplate"),
		pdfReferenceInlineTemplate: text("pdfReferenceInlineTemplate"), pdfReferenceQuoteTemplate: text("pdfReferenceQuoteTemplate"),
	};
}
export function referenceTemplate(settings: PdfReferencePreferences, mode: PdfReferenceCopyMode): string {
	return mode === "link" ? settings.pdfReferenceLinkTemplate : mode === "inline" ? settings.pdfReferenceInlineTemplate : settings.pdfReferenceQuoteTemplate;
}
const VARIABLES = new Set(["text", "link", "file", "page"]);
export function referenceTemplateError(template: string): string | null {
	if (!template.includes("{{link}}")) return "模板必须包含 {{link}}，否则无法返回引用位置";
	for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) if (!VARIABLES.has(match[1])) return `未知变量：{{${match[1]}}}`;
	return null;
}
/** Expand the template once. Never interpret escapes or placeholders inside the quoted PDF text. */
export function renderReferenceTemplate(template: string, vars: Record<string, string>): string {
	const decoded = template.replace(/\\n/g, "\n");
	return decoded.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string, offset: number) => {
		const value = vars[key] ?? "";
		if (key !== "text") return value;
		const line = decoded.slice(decoded.lastIndexOf("\n", offset - 1) + 1, offset);
		const quotePrefix = line.match(/^(\s*(?:>\s*)+)/)?.[1];
		return quotePrefix ? value.replace(/\r?\n/g, `\n${quotePrefix}`) : value;
	});
}
export function configuredReferenceCopy(settings: Partial<PdfReferencePreferences>, mode: PdfReferenceCopyMode, link: string, text: string | undefined, file: string, page: number): string {
	const config = normalizeReferencePreferences(settings);
	const effectiveMode = text?.trim() || mode === "link" ? mode : "link";
	const template = referenceTemplate(config, effectiveMode);
	const error = referenceTemplateError(template);
	if (error) throw new Error(error);
	const quote = effectiveMode === "link" ? "" : text?.trim() ?? "";
	return renderReferenceTemplate(template, { link, file, page: String(page), text: effectiveMode === "inline" ? quote.replace(/\s*\r?\n\s*/g, " ") : quote });
}
