/** A named view over annotations. Identity is stable; the visible name may change. */
export interface AnnotationLayerDefinition {
	id: string;
	name: string;
}

/** Opaque defaults: names may be changed without changing annotation membership. */
export const DEFAULT_ANNOTATION_LAYERS: AnnotationLayerDefinition[] = [
	{ id: "lyr-6f1c9a42", name: "内心 OS" },
	{ id: "lyr-a83d570e", name: "论证骨架" },
	{ id: "lyr-d247be91", name: "知识查阅" },
];

export function makeAnnotationLayerId(existing: Iterable<string> = []): string {
	const used = new Set(existing);
	let id = "";
	do {
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		id = `lyr-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	} while (used.has(id));
	return id;
}

/** Missing settings get the three useful defaults; an explicitly empty list stays empty. */
export function normalizeAnnotationLayers(raw: unknown): AnnotationLayerDefinition[] {
	if (raw === undefined) return DEFAULT_ANNOTATION_LAYERS.map((layer) => ({ ...layer }));
	if (!Array.isArray(raw)) return DEFAULT_ANNOTATION_LAYERS.map((layer) => ({ ...layer }));
	const used = new Set<string>();
	return raw.flatMap((item, index) => {
		if (!item || typeof item !== "object") return [];
		const candidate = item as Partial<AnnotationLayerDefinition>;
		const name = candidate.name?.trim();
		if (!name) return [];
		let id = candidate.id?.trim() || makeAnnotationLayerId(used);
		if (used.has(id)) id = makeAnnotationLayerId(used);
		used.add(id);
		return [{ id, name: name || `图层 ${index + 1}` }];
	});
}

/** Accept hand-edited JSON, remove empty/duplicate ids, and omit an empty membership. */
export function normalizeAnnotationLayerIds(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const ids = [...new Set(raw.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
	return ids.length > 0 ? ids : undefined;
}

export function annotationVisibleInLayer(
	ann: Pick<{ layerIds?: string[] }, "layerIds">,
	activeLayerId: string | null
): boolean {
	return activeLayerId === null || !!ann.layerIds?.includes(activeLayerId);
}

/** Returns a new array so toggling membership never mutates a shared store snapshot. */
export function toggleAnnotationLayer(layerIds: string[] | undefined, layerId: string): string[] | undefined {
	const current = new Set(layerIds ?? []);
	if (current.has(layerId)) current.delete(layerId);
	else current.add(layerId);
	return current.size > 0 ? [...current] : undefined;
}
