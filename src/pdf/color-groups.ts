import type { AnnotationColorSlot, PdfAnnotationSettings } from "./annotation-settings";

/** Groups reference a global catalog: switching groups never reinterprets a note's key. */
export interface AnnotationColorGroup {
	id: string;
	name: string;
	colorKeys: string[];
	/** Removed from choices, retained to describe older notes. */
	archived?: boolean;
}

export const DEFAULT_COLOR_GROUP_ID = "grp-default";

export function makeColorGroupId(): string {
	return `grp-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function normalizeColorGroups(raw: unknown, palette: AnnotationColorSlot[]): AnnotationColorGroup[] {
	const groups: AnnotationColorGroup[] = [];
	const usedIds = new Set<string>();
	const usedKeys = new Set<string>();
	const validKeys = new Set(palette.map((slot) => slot.id));
	if (Array.isArray(raw)) for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.id !== "string" || !candidate.id.trim() || usedIds.has(candidate.id)) continue;
		if (typeof candidate.name !== "string" || !candidate.name.trim()) continue;
		const colorKeys = Array.isArray(candidate.colorKeys) ? candidate.colorKeys.filter((key): key is string => {
			if (typeof key !== "string" || !validKeys.has(key) || usedKeys.has(key)) return false;
			usedKeys.add(key);
			return true;
		}) : [];
		usedIds.add(candidate.id);
		groups.push({ id: candidate.id, name: candidate.name.trim(), colorKeys, archived: candidate.archived === true || undefined });
	}
	if (!groups.some((group) => !group.archived)) {
		let id = DEFAULT_COLOR_GROUP_ID;
		while (usedIds.has(id)) id += "-new";
		groups.push({ id, name: "默认", colorKeys: palette.filter((slot) => !usedKeys.has(slot.id)).map((slot) => slot.id) });
	}
	return groups;
}

export function visibleColorGroups(settings: Pick<PdfAnnotationSettings, "colorGroups">): AnnotationColorGroup[] {
	return settings.colorGroups.filter((group) => !group.archived);
}

export function activeColorGroup(settings: Pick<PdfAnnotationSettings, "colorGroups" | "activeColorGroupId">): AnnotationColorGroup {
	return visibleColorGroups(settings).find((group) => group.id === settings.activeColorGroupId) ?? visibleColorGroups(settings)[0];
}

export function activeColorSlots(settings: PdfAnnotationSettings): AnnotationColorSlot[] {
	return activeColorGroup(settings).colorKeys.flatMap((key) => {
		const slot = settings.palette.find((item) => item.id === key);
		return slot ? [slot] : [];
	});
}

export function colorSlotLabel(settings: PdfAnnotationSettings, key: string): string | undefined {
	const slot = settings.palette.find((item) => item.id === key);
	if (!slot) return undefined;
	const group = settings.colorGroups.find((item) => item.colorKeys.includes(key));
	return group && settings.colorGroups.length > 1 ? `${group.name} · ${slot.name}` : slot.name;
}

export function orderedColorKeys(settings: PdfAnnotationSettings): string[] {
	return [...new Set([...settings.colorGroups.flatMap((group) => group.colorKeys), ...settings.palette.map((slot) => slot.id)])];
}

/** Last visible group cannot be removed. No catalog entry or annotation is deleted. */
export function archiveColorGroup(settings: PdfAnnotationSettings, id: string): boolean {
	const group = visibleColorGroups(settings).find((item) => item.id === id);
	if (!group || visibleColorGroups(settings).length < 2) return false;
	group.archived = true;
	if (settings.activeColorGroupId === id) settings.activeColorGroupId = visibleColorGroups(settings)[0].id;
	return true;
}
