import { namesLookRelated } from "./pairing";

/** A persisted annotation list whose original PDF path no longer exists. */
export interface OrphanedAnnotationSource {
	path: string;
	count: number;
	maxPage: number;
}

/**
 * Page numbers can reject an impossible target, but cannot prove identity: an
 * old PDF with ten pages may simply have no annotations after page four. Keep
 * every possible source searchable and use filename resemblance only to rank.
 */
export function compatibleRecoverySources(
	targetPath: string,
	targetPages: number,
	sources: OrphanedAnnotationSource[]
): OrphanedAnnotationSource[] {
	return sources
		.filter((source) => source.maxPage > 0 && source.maxPage <= targetPages)
		.sort((a, b) => {
			const related = Number(namesLookRelated(targetPath, b.path)) - Number(namesLookRelated(targetPath, a.path));
			if (related !== 0) return related;
			const reachesLastPage = Number(b.maxPage === targetPages) - Number(a.maxPage === targetPages);
			if (reachesLastPage !== 0) return reachesLastPage;
			const coverage = b.maxPage / targetPages - a.maxPage / targetPages;
			return coverage || b.count - a.count || a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
		});
}
