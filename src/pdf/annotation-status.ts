import { normalizePath } from "obsidian";
import type { PdfAnnotation } from "./annotation-types";
import type { PairMode } from "./pairing-state";

export type AnnotationStatusKind = "standalone" | "shared" | "orphaned";

export interface AnnotationStatusSummary {
	/** Canonical bucket key used in annotations.json. */
	key: string;
	/** Existing PDF paths in this bucket, if any. */
	livePaths: string[];
	/** Every PDF member path recorded for this bucket. */
	memberPaths: string[];
	/** Path shown as the primary label and used when opening the PDF. */
	representativePath: string;
	count: number;
	firstCreatedAt: number | null;
	lastUpdatedAt: number | null;
	status: AnnotationStatusKind;
}

function validTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function compareNewestFirst(a: AnnotationStatusSummary, b: AnnotationStatusSummary): number {
	const aTime = a.lastUpdatedAt ?? -Infinity;
	const bTime = b.lastUpdatedAt ?? -Infinity;
	return bTime - aTime || a.representativePath.localeCompare(b.representativePath, undefined, { sensitivity: "base" });
}

/**
 * Builds a read-only, de-duplicated overview of every non-empty annotation
 * bucket. Shared members are represented by their canonical group bucket once.
 */
export function buildAnnotationStatusSummaries(
	data: Record<string, PdfAnnotation[]>,
	pairs: Record<string, string>,
	pairModes: Record<string, PairMode>,
	existingPaths: ReadonlySet<string>
): AnnotationStatusSummary[] {
	const existing = new Set([...existingPaths].map((path) => normalizePath(path)));
	const membersByGroup = new Map<string, string[]>();
	for (const [member, group] of Object.entries(pairs)) {
		const list = membersByGroup.get(group) ?? [];
		list.push(normalizePath(member));
		membersByGroup.set(group, list);
	}

	const canonicalKeys = new Set<string>();
	for (const path of Object.keys(data)) {
		const group = pairs[path];
		if (!group || data[group] === undefined) canonicalKeys.add(path);
	}
	for (const group of membersByGroup.keys()) {
		if (data[group] !== undefined) canonicalKeys.add(group);
	}

	const summaries: AnnotationStatusSummary[] = [];
	for (const key of canonicalKeys) {
		const annotations = data[key] ?? [];
		if (annotations.length === 0) continue;
		const groupMembers = membersByGroup.get(key);
		const memberPaths = groupMembers?.length ? [...new Set(groupMembers)] : [normalizePath(key)];
		const livePaths = memberPaths.filter((path) => existing.has(path));
		const shared = Boolean(groupMembers && groupMembers.length > 1 && (pairModes[key] ?? "shared") === "shared");
		const firstCreatedAt = annotations.reduce<number | null>((minimum, annotation) => {
			if (!validTimestamp(annotation.createdAt)) return minimum;
			return minimum === null ? annotation.createdAt : Math.min(minimum, annotation.createdAt);
		}, null);
		const lastUpdatedAt = annotations.reduce<number | null>((maximum, annotation) => {
			if (!validTimestamp(annotation.updatedAt)) return maximum;
			return maximum === null ? annotation.updatedAt : Math.max(maximum, annotation.updatedAt);
		}, null);
		const status: AnnotationStatusKind =
			livePaths.length === 0 ? "orphaned" : shared ? "shared" : "standalone";
		summaries.push({
			key: normalizePath(key),
			livePaths,
			memberPaths,
			representativePath: livePaths[0] ?? memberPaths[0] ?? normalizePath(key),
			count: annotations.length,
			firstCreatedAt,
			lastUpdatedAt,
			status,
		});
	}

	return summaries.sort(compareNewestFirst);
}
