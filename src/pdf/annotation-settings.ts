import type { PdfAnnotation } from "./annotation-types";
import {
	DEFAULT_ANNOTATION_LAYERS,
	normalizeAnnotationLayers,
	type AnnotationLayerDefinition,
} from "./annotation-layers";
import { DEFAULT_ANNOTATION_PROPERTY, normalizeAnnotationPropertyName } from "./source-annotation-sync";

export interface AnnotationColorSlot {
	/** Stable storage key. Names and colour values may change without touching notes. */
	id: string;
	name: string;
	color: string;
}

export interface PdfAnnotationSettings {
	/**
	 * Where the annotations JSON lives, vault-relative. A path with no `.json`
	 * suffix is treated as a FOLDER and the file goes inside it — that's what a
	 * bare name like `99_assets/plugin-data/margin-note` obviously means, and
	 * silently writing a file with that exact name instead left annotations
	 * stranded at the old location.
	 *
	 * Inside the vault (not the plugin folder) so it travels with git /
	 * Obsidian Sync / iCloud — this vault's .gitignore excludes
	 * `/.obsidian/plugins/` wholesale.
	 */
	dataPath: string;
	/** Mirror whether a source-linked PDF has annotations into its Markdown note. */
	syncAnnotationProperty: boolean;
	/** Boolean frontmatter key written only as true; absence means no annotations. */
	annotationPropertyName: string;
	/** On mobile, offer the existing mark palette after PDF text selection settles. */
	mobileSelectionPalette: boolean;
	/** Dot + border colour for free notes. */
	freeColor: string;
	/** Dot + border colour for rail notes. */
	railColor: string;
	/** 0-100. */
	opacity: number;
	/**
	 * Reference width of a side rail, in PDF points (i.e. px at 100% pdf.js
	 * zoom — the same unit `anchor` rects use). A rail note is attached to the
	 * page like any other note, so its lane has to scale with zoom too, or the
	 * two would visibly drift apart; storing it in points instead of px is what
	 * makes that automatic. Left and right are independent settings — they used
	 * to be one shared value, which meant resizing the left rail silently moved
	 * the right one too. Drag a rail note's outer edge to change it.
	 */
	railWidthLeft: number;
	railWidthRight: number;
	/**
	 * Distance from the page's edge to a rail's inner edge, in PDF points.
	 * May be negative, which parks the rail over the page instead of beside it.
	 * Independent per side, same reasoning as `railWidthLeft`/`railWidthRight`.
	 * Drag a rail note's page-facing edge to change it.
	 */
	railGapLeft: number;
	railGapRight: number;
	/** Base font size in px at 100% zoom. Every note scales this with the page's zoom. */
	fontSize: number;
	/** Collapsed annotation dot diameter in screen px. It stays fixed while the PDF zoom changes. */
	dotSize: number;
	/** How the link between a note and the text it refers to is shown. */
	highlightMode: HighlightMode;
	/** 0-100, applied to the highlight band only (notes have their own `opacity`). */
	highlightOpacity: number;
	/**
	 * Preset colours offered when recolouring a note. Replaces the OS colour
	 * panel: that panel opens next to the invisible input that triggered it,
	 * which never reliably lands near the note, and picking a free-form colour
	 * every time produces a set of highlights that don't read as a system. A
	 * short fixed palette is faster to use and keeps a document's annotations
	 * visually coherent.
	 */
	palette: AnnotationColorSlot[];
	/** Named annotation views. Membership is stored on each annotation by opaque id. */
	layers: AnnotationLayerDefinition[];
	/** PDF path → page-centre X in PDF points. Absence means ordinary single-column order. */
	doubleColumnSplits: Record<string, number>;
}

/**
 * What is drawn without any pointer involved. The REVERSE direction (pointing
 * at the text lights up its note) is not a mode of its own — it is on for
 * everything except `note`, because a highlight you cannot trace back to its
 * note is only half a link: seeing a band on the page and having no idea which
 * note it belongs to is exactly as useless as the note-only direction was.
 */
export type HighlightMode = "note" | "both" | "always" | "line";

export const HIGHLIGHT_MODE_LABELS: Record<HighlightMode, string> = {
	note: "单向 —— 只有悬浮批注时才高亮原文",
	both: "双向 —— 悬浮批注或悬浮原文,两边互相点亮",
	line: "箭头 —— 细线一直指向原文,悬浮仍然互相点亮",
	always: "常亮 —— 所有高亮一直显示,悬浮仍然互相点亮",
};

/**
 * A darker shade of `hex`, used for the emphasis outline on a highlighted note.
 * Derived from the note's OWN colour rather than the theme accent, so the
 * outline says which note lit up instead of looking identical for all of them.
 * Computed here rather than with CSS `color-mix` so it does not depend on the
 * renderer's colour-function support.
 */
export function darken(hex: string, amount = 0.4): string {
	const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const f = Math.max(0, Math.min(1, 1 - amount));
	const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c * f));
	return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** True for every mode where pointing at the TEXT should light up its note. */
export function highlightsBothWays(mode: HighlightMode): boolean {
	return mode !== "note";
}

/** Pre-v0.33 semantic keys, accepted only for one-time migration. */
export const LEGACY_COLOR_KEY_MAP: Readonly<Record<string, string>> = {
	general: "clr-2f6a1c9d",
	concept: "clr-7b84e205",
	evidence: "clr-a3d9f671",
	question: "clr-c54e8b20",
	connection: "clr-1d7fa693",
	method: "clr-e8264c5b",
	history: "clr-49bc72a1",
	secondary: "clr-935de4f8",
};

export const DEFAULT_COLOR_SLOTS: AnnotationColorSlot[] = [
	{ id: LEGACY_COLOR_KEY_MAP.general, name: "论述作用", color: "#eed37c" },
	{ id: LEGACY_COLOR_KEY_MAP.concept, name: "定义与建模", color: "#7d94ca" },
	{ id: LEGACY_COLOR_KEY_MAP.evidence, name: "机制与结论", color: "#8fbf8f" },
	{ id: LEGACY_COLOR_KEY_MAP.question, name: "边界与疑问", color: "#d98f8f" },
	{ id: LEGACY_COLOR_KEY_MAP.connection, name: "类比与拓展", color: "#b998d4" },
	{ id: LEGACY_COLOR_KEY_MAP.method, name: "推导步骤", color: "#7fbfc4" },
	{ id: LEGACY_COLOR_KEY_MAP.history, name: "文献与来源", color: "#c9a37a" },
	{ id: LEGACY_COLOR_KEY_MAP.secondary, name: "实验与结果", color: "#9aa0a6" },
];

export const DEFAULT_PDF_ANNOTATION_SETTINGS: PdfAnnotationSettings = {
	dataPath: "99_assets/plugin-data/margin-note",
	syncAnnotationProperty: false,
	annotationPropertyName: DEFAULT_ANNOTATION_PROPERTY,
	mobileSelectionPalette: false,
	freeColor: "#7d94ca",
	railColor: "#eed37c",
	opacity: 92,
	railWidthLeft: 220,
	railWidthRight: 220,
	railGapLeft: 10,
	railGapRight: 10,
	fontSize: 12,
	dotSize: 12,
	highlightMode: "note",
	highlightOpacity: 30,
	palette: DEFAULT_COLOR_SLOTS,
	layers: DEFAULT_ANNOTATION_LAYERS,
	doubleColumnSplits: {},
};

interface StoredShape {
	pdfAnnotationSettings?: Omit<Partial<PdfAnnotationSettings>, "palette" | "layers"> & {
		palette?: unknown[];
		layers?: unknown;
		// pre-0.4 names
		marginWidth?: number;
		marginColor?: string;
		floatingColor?: string;
		marginOpacity?: number;
		// pre-0.10 names: one shared value for both rails
		railWidth?: number;
		railGap?: number;
	};
}

export async function loadPdfAnnotationSettings(plugin: { loadData(): Promise<unknown> }): Promise<PdfAnnotationSettings> {
	const data = (await plugin.loadData()) as StoredShape | null;
	const raw = data?.pdfAnnotationSettings ?? {};
	// A user coming from a single shared railWidth/railGap gets that same value
	// on both sides rather than snapping back to the default — the split itself
	// shouldn't visibly move anything on first load after the upgrade.
	const legacyWidth = raw.railWidth ?? raw.marginWidth;
	const legacyGap = raw.railGap;
	return {
		...DEFAULT_PDF_ANNOTATION_SETTINGS,
		...raw,
		syncAnnotationProperty: raw.syncAnnotationProperty === true,
		annotationPropertyName: normalizeAnnotationPropertyName(raw.annotationPropertyName),
		mobileSelectionPalette: raw.mobileSelectionPalette === true,
		railWidthLeft: raw.railWidthLeft ?? legacyWidth ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railWidthLeft,
		railWidthRight: raw.railWidthRight ?? legacyWidth ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railWidthRight,
		railGapLeft: raw.railGapLeft ?? legacyGap ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railGapLeft,
		railGapRight: raw.railGapRight ?? legacyGap ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railGapRight,
		railColor: raw.railColor ?? raw.marginColor ?? DEFAULT_PDF_ANNOTATION_SETTINGS.railColor,
		freeColor: raw.freeColor ?? raw.floatingColor ?? DEFAULT_PDF_ANNOTATION_SETTINGS.freeColor,
		opacity: raw.opacity ?? raw.marginOpacity ?? DEFAULT_PDF_ANNOTATION_SETTINGS.opacity,
		dotSize: normalizeDotSize(raw.dotSize),
		palette: normalizeColorSlots(raw.palette),
		layers: normalizeAnnotationLayers(raw.layers),
		doubleColumnSplits: normalizeDoubleColumnSplits(raw.doubleColumnSplits),
	};
}

function normalizeDoubleColumnSplits(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [path, split] of Object.entries(value)) {
		if (path.trim() && typeof split === "number" && Number.isFinite(split)) normalized[path] = split;
	}
	return normalized;
}

/** Keep the dot visible and draggable without letting malformed saved data break layout. */
function normalizeDotSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PDF_ANNOTATION_SETTINGS.dotSize;
	return Math.max(6, Math.min(18, Math.round(value)));
}

function normalizeColorSlots(raw: unknown[] | undefined): AnnotationColorSlot[] {
	if (!raw || raw.length === 0) return DEFAULT_COLOR_SLOTS.map((slot) => ({ ...slot }));
	const used = new Set<string>();
	const slots = raw.flatMap((item, index) => {
		if (typeof item === "string" && /^#[\da-f]{6}$/i.test(item)) {
			const byValue = DEFAULT_COLOR_SLOTS.find((slot) => slot.color.toLowerCase() === item.toLowerCase());
			const known = byValue && !used.has(byValue.id) ? byValue : DEFAULT_COLOR_SLOTS[index];
			const id = uniqueSlotId(known?.id ?? `legacy-${index + 1}`, used);
			return [{ id, name: known?.name ?? `颜色 ${index + 1}`, color: item.toLowerCase() }];
		}
		if (!item || typeof item !== "object") return [];
		const candidate = item as Partial<AnnotationColorSlot>;
		if (!candidate.color || !/^#[\da-f]{6}$/i.test(candidate.color)) return [];
		const storedId = candidate.id?.trim();
		const id = uniqueSlotId((storedId && LEGACY_COLOR_KEY_MAP[storedId]) || storedId || makeColorSlotId(used), used);
		return [{ id, name: candidate.name?.trim() || `颜色 ${index + 1}`, color: candidate.color.toLowerCase() }];
	});
	return slots.length > 0 ? slots : DEFAULT_COLOR_SLOTS.map((slot) => ({ ...slot }));
}

/** Opaque identity: generated once, then persisted; no name/colour meaning. */
export function makeColorSlotId(existing: Iterable<string> = []): string {
	const used = new Set(existing);
	let id = "";
	do {
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		id = `clr-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	} while (used.has(id));
	return id;
}

function uniqueSlotId(base: string, used: Set<string>): string {
	const root = base.replace(/[^a-zA-Z0-9_-]+/g, "-") || "color";
	let id = root;
	let suffix = 2;
	while (used.has(id)) id = `${root}-${suffix++}`;
	used.add(id);
	return id;
}

export function colorSlot(settings: PdfAnnotationSettings, key: string | undefined): AnnotationColorSlot | undefined {
	return key ? settings.palette.find((slot) => slot.id === key) : undefined;
}

/**
 * Display rank shared by every colour-oriented UI. Named slots follow the
 * exact order chosen in Settings; notes using the rail/free defaults follow
 * afterwards because those defaults are not reorderable palette entries.
 */
export function annotationColorOrder(
	ann: Pick<PdfAnnotation, "colorKey" | "pinned">,
	settings: PdfAnnotationSettings
): number {
	const slotIndex = ann.colorKey ? settings.palette.findIndex((slot) => slot.id === ann.colorKey) : -1;
	if (slotIndex >= 0) return slotIndex;
	return settings.palette.length + (ann.pinned ? 0 : 1);
}

/** Named slot wins; legacy/custom literal colour remains a supported fallback. */
export function resolveAnnotationColor(ann: Pick<PdfAnnotation, "colorKey" | "pinned">, settings: PdfAnnotationSettings): string {
	return colorSlot(settings, ann.colorKey)?.color ?? (ann.pinned ? settings.railColor : settings.freeColor);
}

/**
 * Pushes settings onto `document.body` as CSS custom properties, which
 * styles.css keys off — a style change repaints instantly without touching any
 * already-rendered annotation DOM.
 */
export function applyPdfAnnotationStyleSettings(settings: PdfAnnotationSettings): void {
	const body = document.body;
	body.style.setProperty("--margin-notes-pdf-free-color", settings.freeColor);
	body.style.setProperty("--margin-notes-pdf-rail-color", settings.railColor);
	body.style.setProperty("--margin-notes-pdf-opacity", String(settings.opacity / 100));
	body.style.setProperty("--margin-notes-pdf-highlight-opacity", String(settings.highlightOpacity / 100));
}

export function clearPdfAnnotationStyleSettings(): void {
	const body = document.body;
	body.style.removeProperty("--margin-notes-pdf-free-color");
	body.style.removeProperty("--margin-notes-pdf-rail-color");
	body.style.removeProperty("--margin-notes-pdf-opacity");
	body.style.removeProperty("--margin-notes-pdf-highlight-opacity");
}
