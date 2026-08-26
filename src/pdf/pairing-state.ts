/** Minimal shape needed to merge annotations while moving shared buckets. */
export interface IdentifiedAnnotation {
	id: string;
}

/** Kept only so v5 `linked` data can be migrated without losing annotations. */
export type PairMode = "linked" | "shared";
export type SharedStrategy = "merge" | "current" | "other";

export interface PairingState<T extends IdentifiedAnnotation> {
	pdfAnnotations: Record<string, T[]>;
	pairs: Record<string, string>;
	pairModes: Record<string, PairMode>;
}

function copyList<T extends IdentifiedAnnotation>(list: T[]): T[] {
	return list.map((item) => ({ ...item }));
}

function sameRecord<T extends IdentifiedAnnotation>(a: T, b: T): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Same records in any order means there is nothing for the user to resolve. */
export function annotationListsConflict<T extends IdentifiedAnnotation>(a: T[], b: T[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	if (a.length !== b.length) return true;
	const other = new Map(b.map((item) => [item.id, item]));
	return a.some((item) => {
		const match = other.get(item.id);
		return !match || !sameRecord(item, match);
	});
}

/**
 * Merge without losing independently edited records that happen to share an id.
 * Exact duplicates collapse to one; a different record with the same id is kept
 * under a deterministic `~2`, `~3` suffix.
 */
export function mergeAnnotationLists<T extends IdentifiedAnnotation>(...lists: Array<T[] | undefined>): T[] {
	const byId = new Map<string, T>();
	const merged: T[] = [];
	for (const list of lists) {
		for (const item of list ?? []) {
			const existing = byId.get(item.id);
			if (!existing) {
				const copy = { ...item };
				byId.set(copy.id, copy);
				merged.push(copy);
				continue;
			}
			if (sameRecord(existing, item)) continue;
			let n = 2;
			let id = `${item.id}~${n}`;
			while (byId.has(id)) id = `${item.id}~${++n}`;
			const copy = { ...item, id };
			byId.set(id, copy);
			merged.push(copy);
		}
	}
	return merged;
}

function membersOf(pairs: Record<string, string>, group: string): string[] {
	return Object.keys(pairs).filter((member) => pairs[member] === group);
}

export function groupMembers(pairs: Record<string, string>, pdfPath: string): string[] {
	const group = pairs[pdfPath];
	return group ? membersOf(pairs, group) : [];
}

function sharedAnnotations<T extends IdentifiedAnnotation>(state: PairingState<T>, group: string, members: string[]): T[] {
	return mergeAnnotationLists(
		state.pdfAnnotations[group],
		...members.filter((member) => member !== group).map((member) => state.pdfAnnotations[member])
	);
}

export function relationMode<T extends IdentifiedAnnotation>(state: PairingState<T>, pdfPath: string): PairMode | null {
	const group = state.pairs[pdfPath];
	return group ? (state.pairModes[group] ?? "shared") : null;
}

export function sharedKey<T extends IdentifiedAnnotation>(state: PairingState<T>, pdfPath: string): string {
	const group = state.pairs[pdfPath];
	return group && relationMode(state, pdfPath) === "shared" ? group : pdfPath;
}

/** First other member, retained for compatibility with old callers/tests. */
export function counterpartOf(pairs: Record<string, string>, pdfPath: string): string | null {
	return groupMembers(pairs, pdfPath).find((member) => member !== pdfPath) ?? null;
}

/** Dissolve an entire legacy relation. Shared notes are copied to every member. */
export function unpairFile<T extends IdentifiedAnnotation>(state: PairingState<T>, pdfPath: string): string[] {
	const group = state.pairs[pdfPath];
	if (!group) return [];
	const members = membersOf(state.pairs, group);
	const mode = state.pairModes[group] ?? "shared";
	if (mode === "shared") {
		const shared = sharedAnnotations(state, group, members);
		for (const member of members) {
			if (shared.length > 0) state.pdfAnnotations[member] = copyList(shared);
			else delete state.pdfAnnotations[member];
		}
		if (!members.includes(group)) delete state.pdfAnnotations[group];
	}
	for (const member of members) delete state.pairs[member];
	delete state.pairModes[group];
	return members;
}

function sideOf<T extends IdentifiedAnnotation>(state: PairingState<T>, path: string): { members: string[]; key: string; list: T[] } {
	const group = state.pairs[path];
	if (group && (state.pairModes[group] ?? "shared") === "shared") {
		const members = membersOf(state.pairs, group);
		return { members, key: group, list: sharedAnnotations(state, group, members) };
	}
	// A v5 navigation-only group is obsolete. Dissolve it before this file joins
	// a real shared group; every member's independent annotations stay untouched.
	if (group) unpairFile(state, path);
	return { members: [path], key: path, list: copyList(state.pdfAnnotations[path] ?? []) };
}

/**
 * Join two files/groups into one N-member shared group. Existing shared groups
 * are merged rather than replaced, so adding a third translation keeps the first
 * two. Layout compatibility is checked by the controller before this mutation.
 */
export function joinSharedGroups<T extends IdentifiedAnnotation>(
	state: PairingState<T>,
	a: string,
	b: string,
	strategy: SharedStrategy = "merge"
): string[] {
	if (a === b) return groupMembers(state.pairs, a);
	if (
		state.pairs[a] &&
		state.pairs[a] === state.pairs[b] &&
		(state.pairModes[state.pairs[a]] ?? "shared") === "shared"
	) return groupMembers(state.pairs, a);

	const current = sideOf(state, a);
	const other = sideOf(state, b);
	const members = [...new Set([...current.members, ...other.members])];
	const group = current.key;
	const chosen =
		strategy === "current"
			? copyList(current.list)
			: strategy === "other"
				? copyList(other.list)
				: mergeAnnotationLists(current.list, other.list);

	for (const oldGroup of [current.key, other.key]) {
		delete state.pairModes[oldGroup];
		for (const member of Object.keys(state.pairs)) {
			if (state.pairs[member] === oldGroup) delete state.pairs[member];
		}
	}
	for (const member of members) state.pairs[member] = group;
	state.pairModes[group] = "shared";

	if (chosen.length > 0) state.pdfAnnotations[group] = chosen;
	else delete state.pdfAnnotations[group];
	for (const member of members) if (member !== group) delete state.pdfAnnotations[member];
	return members;
}

/** Old binary API retained as a thin migration/test adapter. */
export function connectFiles<T extends IdentifiedAnnotation>(
	state: PairingState<T>,
	a: string,
	b: string,
	mode: PairMode,
	strategy: SharedStrategy = "merge"
): void {
	if (mode === "shared") {
		joinSharedGroups(state, a, b, strategy);
		return;
	}
	if (a === b) return;
	unpairFile(state, a);
	unpairFile(state, b);
	state.pairs[a] = a;
	state.pairs[b] = a;
	state.pairModes[a] = "linked";
}

/** Materialize a shared group before removing the obsolete shared state. */
export function downgradeToLinked<T extends IdentifiedAnnotation>(state: PairingState<T>, pdfPath: string): boolean {
	const group = state.pairs[pdfPath];
	if (!group || (state.pairModes[group] ?? "shared") !== "shared") return false;
	const members = membersOf(state.pairs, group);
	const shared = sharedAnnotations(state, group, members);
	for (const member of members) {
		if (shared.length > 0) state.pdfAnnotations[member] = copyList(shared);
		else delete state.pdfAnnotations[member];
	}
	state.pairModes[group] = "linked";
	return true;
}

/**
 * Remove one member from a shared group. It receives a private copy; with 3+
 * members the survivors keep sharing, while a two-member group naturally ends.
 */
export function detachDeletedFile<T extends IdentifiedAnnotation>(state: PairingState<T>, pdfPath: string): string[] {
	const group = state.pairs[pdfPath];
	if (!group) return [];
	const members = membersOf(state.pairs, group);
	const mode = state.pairModes[group] ?? "shared";
	const shared = mode === "shared" ? sharedAnnotations(state, group, members) : [];
	for (const member of members) delete state.pairs[member];
	delete state.pairModes[group];

	if (mode === "shared") {
		if (shared.length > 0) state.pdfAnnotations[pdfPath] = copyList(shared);
		else delete state.pdfAnnotations[pdfPath];
	}

	const remaining = members.filter((member) => member !== pdfPath);
	if (remaining.length === 1) {
		const survivor = remaining[0];
		if (mode === "shared") {
			if (shared.length > 0) state.pdfAnnotations[survivor] = copyList(shared);
			else delete state.pdfAnnotations[survivor];
		}
	} else if (remaining.length >= 2) {
		const nextGroup = group !== pdfPath && remaining.includes(group) ? group : remaining[0];
		state.pairModes[nextGroup] = mode;
		for (const member of remaining) state.pairs[member] = nextGroup;
		if (mode === "shared") {
			if (shared.length > 0) state.pdfAnnotations[nextGroup] = copyList(shared);
			else delete state.pdfAnnotations[nextGroup];
			for (const member of remaining) if (member !== nextGroup) delete state.pdfAnnotations[member];
		}
	}

	if (mode === "shared" && group !== pdfPath && !remaining.includes(group)) delete state.pdfAnnotations[group];
	return members;
}
