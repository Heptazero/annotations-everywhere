export interface MarkdownMarginSettings {
	width: number;
	gap: number;
}

export const MIN_MARKDOWN_MARGIN_WIDTH = 120;
export const MAX_MARKDOWN_MARGIN_WIDTH = 480;
export const MIN_MARKDOWN_MARGIN_GAP = 4;
export const DEFAULT_MARKDOWN_MARGIN_SETTINGS: MarkdownMarginSettings = { width: 176, gap: 12 };

export function normalizeMarkdownMarginSettings(value: unknown): MarkdownMarginSettings {
	const raw = value && typeof value === "object" ? (value as Partial<MarkdownMarginSettings>) : {};
	const width =
		typeof raw.width === "number" && Number.isFinite(raw.width)
			? raw.width
			: DEFAULT_MARKDOWN_MARGIN_SETTINGS.width;
	const gap =
		typeof raw.gap === "number" && Number.isFinite(raw.gap) ? raw.gap : DEFAULT_MARKDOWN_MARGIN_SETTINGS.gap;
	return {
		width: Math.max(MIN_MARKDOWN_MARGIN_WIDTH, Math.min(MAX_MARKDOWN_MARGIN_WIDTH, Math.round(width))),
		gap: Math.max(MIN_MARKDOWN_MARGIN_GAP, Math.round(gap)),
	};
}
