import type { PdfAnnotation } from "./annotation-types";
import type { PdfOutlineItem } from "./pdf-outline";

export interface ManualOutlineEntry {
	id: string;
	title: string;
	level: number;
	page: number;
}

export function normalizeManualOutline(value: unknown): ManualOutlineEntry[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	return value.flatMap((raw): ManualOutlineEntry[] => {
		if (!raw || typeof raw !== "object") return [];
		const item = raw as Partial<ManualOutlineEntry>;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
		if (!id || !title || seen.has(id) || !Number.isInteger(item.page) || !Number.isInteger(item.level)) return [];
		if (item.page! < 1 || item.level! < 1 || item.level! > 6) return [];
		seen.add(id);
		return [{ id, title, page: item.page!, level: item.level! }];
	});
}

/** Losslessly combines separately authored headings when PDF groups are joined. */
export function mergeManualOutlines(...lists: ManualOutlineEntry[][]): ManualOutlineEntry[] {
	const combined: ManualOutlineEntry[] = [];
	const byId = new Map<string, ManualOutlineEntry>();
	const byContent = new Set<string>();
	for (const list of lists) {
		for (const item of list) {
			const content = JSON.stringify([item.title, item.level, item.page]);
			if (byContent.has(content)) continue;
			let id = item.id;
			if (byId.has(id)) {
				let suffix = 2;
				while (byId.has(`${id}~${suffix}`)) suffix++;
				id = `${id}~${suffix}`;
			}
			const copy = { ...item, id };
			combined.push(copy);
			byId.set(id, copy);
			byContent.add(content);
		}
	}
	return combined;
}

interface FlatItem {
	item: PdfOutlineItem;
	level: number;
	order: number;
	sortPage: number;
}

function firstOutlinePage(item: PdfOutlineItem): number | null {
	if (item.page !== null) return item.page;
	for (const child of item.items) {
		const page = firstOutlinePage(child);
		if (page !== null) return page;
	}
	return null;
}

/** Manual entries supplement PDF metadata; neither source is modified. */
export function combineOutlines(native: PdfOutlineItem[], manual: ManualOutlineEntry[]): PdfOutlineItem[] {
	if (manual.length === 0) return native;
	const flat: FlatItem[] = [];
	const walk = (items: PdfOutlineItem[], level: number): void => {
		for (const item of items) {
			flat.push({ item, level, order: flat.length, sortPage: firstOutlinePage(item) ?? flat.at(-1)?.sortPage ?? 1 });
			walk(item.items, level + 1);
		}
	};
	walk(native, 1);
	const manualItems: FlatItem[] = manual.map((entry, index) => ({
		item: { title: entry.title, page: entry.page, topRatio: null, items: [], manualId: entry.id },
		level: entry.level,
		order: flat.length + index,
		sortPage: entry.page,
	}));
	// The PDF's own outline order/hierarchy is authoritative. Insert a manual
	// heading only at a same-or-higher-level boundary, never midway through an
	// existing native subtree (which would silently reparent its children).
	const ordered = [...flat];
	for (const entry of manualItems.sort((a, b) => a.sortPage - b.sortPage || a.order - b.order)) {
		const nextBoundary = ordered.findIndex((candidate) =>
			candidate.level <= entry.level && candidate.sortPage > entry.sortPage
		);
		ordered.splice(nextBoundary < 0 ? ordered.length : nextBoundary, 0, entry);
	}
	const roots: PdfOutlineItem[] = [];
	const stack: Array<{ level: number; item: PdfOutlineItem }> = [];
	for (const entry of ordered) {
		const item: PdfOutlineItem = { ...entry.item, items: [] };
		while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) stack.pop();
		if (stack.length > 0) stack[stack.length - 1].item.items.push(item);
		else roots.push(item);
		stack.push({ level: entry.level, item });
	}
	return roots;
}

export interface OutlineAnnotationGroups {
	byHeading: Map<PdfOutlineItem, PdfAnnotation[]>;
	beforeFirst: PdfAnnotation[];
	counts: Map<PdfOutlineItem, number>;
}

/** Page-only boundaries: a section ends at the next same/higher-level heading. */
export function groupAnnotationsByOutline(items: PdfOutlineItem[], annotations: PdfAnnotation[]): OutlineAnnotationGroups {
	const headings: Array<{ item: PdfOutlineItem; level: number }> = [];
	const walk = (nodes: PdfOutlineItem[], level: number): void => {
		for (const node of nodes) {
			headings.push({ item: node, level });
			walk(node.items, level + 1);
		}
	};
	walk(items, 1);
	const ends = headings.map((heading, index) => {
		for (let next = index + 1; next < headings.length; next++) {
			if (headings[next].level <= heading.level) return firstOutlinePage(headings[next].item) ?? Number.POSITIVE_INFINITY;
		}
		return Number.POSITIVE_INFINITY;
	});
	const byHeading = new Map<PdfOutlineItem, PdfAnnotation[]>();
	const beforeFirst: PdfAnnotation[] = [];
	for (const ann of annotations) {
		let selected: { item: PdfOutlineItem; level: number } | null = null;
		for (let index = 0; index < headings.length; index++) {
			const heading = headings[index];
			if (heading.item.page === null || heading.item.page > ann.page) continue;
			if (ann.page >= ends[index]) continue;
			if (!selected || heading.level >= selected.level) selected = heading;
		}
		if (selected) {
			const list = byHeading.get(selected.item) ?? [];
			list.push(ann);
			byHeading.set(selected.item, list);
		} else beforeFirst.push(ann);
	}
	const counts = new Map<PdfOutlineItem, number>();
	const count = (nodes: PdfOutlineItem[]): void => {
		for (const node of nodes) {
			count(node.items);
			counts.set(node, (byHeading.get(node)?.length ?? 0) + node.items.reduce((n, child) => n + (counts.get(child) ?? 0), 0));
		}
	};
	count(items);
	return { byHeading, beforeFirst, counts };
}
