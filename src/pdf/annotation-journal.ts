import type { DataAdapter } from "obsidian";
import type { PdfAnnotation } from "./annotation-types";
import type { ManualOutlineEntry } from "./manual-outline";
import type { PairMode } from "./pairing-state";

/** v2 stores the migrated records individually; later edits are immutable changes. */
export interface JournalState {
	pdfAnnotations: Record<string, PdfAnnotation[]>;
	pairs: Record<string, string>;
	pairModes: Record<string, PairMode>;
	manualOutlines: Record<string, ManualOutlineEntry[]>;
}

interface AnnotationChange {
	bucket: string;
	id: string;
	parents: string[];
	value: PdfAnnotation | null;
}

interface MetadataChange {
	parents: string[];
	value: Pick<JournalState, "pairs" | "pairModes" | "manualOutlines">;
}

export interface JournalEvent {
	version: 1;
	id: string;
	changes: AnnotationChange[];
	metadata?: MetadataChange;
}

interface JournalManifest {
	version: 2;
	format: "record-journal";
	legacyHash: string;
	recordCount: number;
}

/** A manifest can arrive before all baseline records on another device. */
export class JournalPendingSyncError extends Error {}

interface RecordSnapshot {
	version: 1;
	bucket: string;
	id: string;
	value: PdfAnnotation;
}

interface MetadataSnapshot {
	version: 1;
	value: MetadataChange["value"];
}

export interface JournalConflict {
	key: string;
	versions: Array<{ revision: string; value: PdfAnnotation | null }>;
}

export interface JournalView {
	state: JournalState;
	annotationHeads: Map<string, string[]>;
	metadataHeads: string[];
	metadataVersions: Array<{ revision: string; value: MetadataChange["value"] }>;
	conflicts: JournalConflict[];
	metadataConflict: boolean;
}

const BASE = "base";
const recordKey = (bucket: string, id: string): string => JSON.stringify([bucket, id]);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
	}
	return value;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function journalStatesEqual(a: JournalState, b: JournalState): boolean {
	const normalize = (state: JournalState): JournalState => ({
		...state,
		pdfAnnotations: Object.fromEntries(Object.entries(state.pdfAnnotations).filter(([, list]) => list.length > 0)),
	});
	return same(normalize(a), normalize(b));
}

function metadataOf(state: JournalState): MetadataChange["value"] {
	return { pairs: state.pairs, pairModes: state.pairModes, manualOutlines: state.manualOutlines };
}

function recordsOf(state: JournalState): Map<string, { bucket: string; id: string; value: PdfAnnotation }> {
	const records = new Map<string, { bucket: string; id: string; value: PdfAnnotation }>();
	for (const [bucket, list] of Object.entries(state.pdfAnnotations)) {
		for (const value of list) records.set(recordKey(bucket, value.id), { bucket, id: value.id, value });
	}
	return records;
}

interface Version<T> {
	parents: string[];
	value: T;
}

function heads<T>(versions: Map<string, Version<T>>): string[] {
	const superseded = new Set<string>();
	for (const version of versions.values()) for (const parent of version.parents) superseded.add(parent);
	return [...versions.keys()].filter((id) => !superseded.has(id)).sort();
}

/** Order-independent replay. Concurrent heads are exposed, never discarded. */
export function materializeJournal(base: JournalState, events: Iterable<JournalEvent>): JournalView {
	const recordVersions = new Map<string, Map<string, Version<PdfAnnotation | null>>>();
	for (const [key, record] of recordsOf(base)) {
		recordVersions.set(key, new Map([[BASE, { parents: [], value: record.value }]]));
	}
	const metadataVersions = new Map<string, Version<MetadataChange["value"]>>([
		[BASE, { parents: [], value: metadataOf(base) }],
	]);
	for (const event of events) {
		for (const change of event.changes) {
			const key = recordKey(change.bucket, change.id);
			const versions = recordVersions.get(key) ?? new Map<string, Version<PdfAnnotation | null>>();
			versions.set(event.id, { parents: change.parents, value: change.value });
			recordVersions.set(key, versions);
		}
		if (event.metadata) metadataVersions.set(event.id, event.metadata);
	}
	const next: JournalState = { pdfAnnotations: {}, pairs: {}, pairModes: {}, manualOutlines: {} };
	const annotationHeads = new Map<string, string[]>();
	const conflicts: JournalConflict[] = [];
	for (const [key, versions] of recordVersions) {
		const active = heads(versions);
		annotationHeads.set(key, active);
		const candidates = active.map((revision) => ({ revision, value: versions.get(revision)!.value }));
		if (candidates.length > 1 && candidates.some((candidate) => !same(candidate.value, candidates[0].value))) {
			conflicts.push({ key, versions: copy(candidates) });
		}
		// A conflicting deletion must not make a surviving edit disappear from view.
		const visibleCandidates = candidates.filter((candidate) => candidate.value !== null);
		const visible = visibleCandidates[visibleCandidates.length - 1]?.value;
		if (!visible) continue;
		const [bucket] = JSON.parse(key) as [string, string];
		(next.pdfAnnotations[bucket] ??= []).push(copy(visible));
	}
	const metadataHeads = heads(metadataVersions);
	const activeMetadata = metadataHeads.map((revision) => ({ revision, value: copy(metadataVersions.get(revision)!.value) }));
	const selected = activeMetadata[activeMetadata.length - 1]?.value ?? metadataOf(base);
	next.pairs = copy(selected.pairs);
	next.pairModes = copy(selected.pairModes);
	next.manualOutlines = copy(selected.manualOutlines);
	return { state: next, annotationHeads, metadataHeads, metadataVersions: activeMetadata,
		conflicts, metadataConflict: activeMetadata.length > 1 &&
			activeMetadata.some((candidate) => !same(candidate.value, activeMetadata[0].value)) };
}

function changedEvent(previous: JournalView, next: JournalState): JournalEvent | null {
	const before = recordsOf(previous.state);
	const after = recordsOf(next);
	const changes: AnnotationChange[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const oldValue = before.get(key)?.value ?? null;
		const newValue = after.get(key)?.value ?? null;
		if (same(oldValue, newValue)) continue;
		const active = previous.annotationHeads.get(key) ?? [];
		if (previous.conflicts.some((conflict) => conflict.key === key)) {
			throw new Error("这条批注存在同步冲突；请先处理冲突再修改");
		}
		const [bucket, id] = JSON.parse(key) as [string, string];
		changes.push({ bucket, id, parents: active, value: newValue ? copy(newValue) : null });
	}
	let metadata: MetadataChange | undefined;
	if (!same(metadataOf(previous.state), metadataOf(next))) {
		if (previous.metadataConflict) throw new Error("共享关系存在同步冲突；请先处理冲突");
		metadata = { parents: previous.metadataHeads, value: copy(metadataOf(next)) };
	}
	if (changes.length === 0 && !metadata) return null;
	return { version: 1, id: crypto.randomUUID(), changes, metadata };
}

/** Pure delta generation is also used to verify that undo does not rewrite unrelated notes. */
export function journalDelta(previous: JournalView, next: JournalState): JournalEvent | null {
	return changedEvent(previous, next);
}

export class AnnotationJournal {
	readonly folder: string;
	private base!: JournalState;
	private events = new Map<string, JournalEvent>();
	private persistedIds = new Set<string>();
	private baseRecordPaths = new Set<string>();
	private view!: JournalView;
	private legacyHash = "";

	constructor(private adapter: DataAdapter, dataFolder: string) {
		this.folder = `${dataFolder}/revisions`;
	}

	static async exists(adapter: DataAdapter, dataFolder: string): Promise<boolean> {
		return adapter.exists(`${dataFolder}/revisions/manifest.json`);
	}

	get current(): JournalView { return this.view; }

	private async ensureFolder(path: string): Promise<void> {
		if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
	}

	private async hash(value: string): Promise<string> {
		const bytes = new TextEncoder().encode(value);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}

	private async recordFilePath(bucket: string, id: string): Promise<string> {
		return `${this.folder}/records/${await this.hash(recordKey(bucket, id))}.json`;
	}

	/** Manifest is written last: a partial conversion cannot become active. */
	async create(legacyRaw: string, state: JournalState): Promise<void> {
		if (await this.adapter.exists(`${this.folder}/manifest.json`)) throw new Error("分文件数据已经存在");
		await this.ensureFolder(this.folder);
		await this.ensureFolder(`${this.folder}/changes`);
		await this.ensureFolder(`${this.folder}/records`);
		if ((await this.adapter.list(`${this.folder}/changes`)).files.length > 0 ||
			(await this.adapter.list(`${this.folder}/records`)).files.length > 0 ||
			(await this.adapter.exists(`${this.folder}/metadata.json`))) {
			throw new Error("目标目录已有未完成的分文件迁移，未覆盖");
		}
		const legacyHash = await this.hash(legacyRaw);
		const paths = new Set<string>();
		for (const [bucket, list] of Object.entries(state.pdfAnnotations)) {
			for (const value of list) {
				const path = await this.recordFilePath(bucket, value.id);
				if (paths.has(path)) throw new Error(`批注记录文件名冲突：${path}`);
				paths.add(path);
				const record: RecordSnapshot = { version: 1, bucket, id: value.id, value: copy(value) };
				await this.adapter.write(path, JSON.stringify(record));
			}
		}
		const metadata: MetadataSnapshot = { version: 1, value: copy(metadataOf(state)) };
		await this.adapter.write(`${this.folder}/metadata.json`, JSON.stringify(metadata));
		await this.adapter.write(`${this.folder}/manifest.json`, JSON.stringify({
			version: 2, format: "record-journal", legacyHash, recordCount: paths.size,
		} satisfies JournalManifest));
		this.base = copy(state);
		this.legacyHash = legacyHash;
		this.baseRecordPaths = paths;
		this.events.clear();
		this.persistedIds.clear();
		this.view = materializeJournal(this.base, []);
	}

	async load(): Promise<JournalView> {
		const manifest = JSON.parse(await this.adapter.read(`${this.folder}/manifest.json`)) as JournalManifest;
		if (manifest.version !== 2 || manifest.format !== "record-journal" ||
			!/^[a-f0-9]{64}$/.test(manifest.legacyHash) || !Number.isInteger(manifest.recordCount)) {
			throw new Error("未知的分文件批注格式，已停止读取");
		}
		const metadata = JSON.parse(await this.adapter.read(`${this.folder}/metadata.json`)) as MetadataSnapshot;
		if (metadata.version !== 1 || !metadata.value || typeof metadata.value !== "object") {
			throw new Error("分文件批注元数据格式错误，已停止读取");
		}
		const base: JournalState = {
			pdfAnnotations: {},
			pairs: copy(metadata.value.pairs ?? {}),
			pairModes: copy(metadata.value.pairModes ?? {}),
			manualOutlines: copy(metadata.value.manualOutlines ?? {}),
		};
		this.baseRecordPaths.clear();
		const recordsFolder = `${this.folder}/records`;
		let recordPaths: string[];
		try {
			recordPaths = (await this.adapter.list(recordsFolder)).files;
		} catch (error) {
			if (await this.adapter.exists(recordsFolder)) throw error;
			if (manifest.recordCount > 0) throw new JournalPendingSyncError("分文件批注记录尚未同步完整，已暂停读取和写入");
			recordPaths = [];
		}
		for (const path of recordPaths.filter((file) => file.endsWith(".json"))) {
			let record: RecordSnapshot;
			try { record = JSON.parse(await this.adapter.read(path)) as RecordSnapshot; }
			catch { throw new Error(`批注记录文件损坏，已停止读取：${path}`); }
			if (record.version !== 1 || !record.bucket || !record.id || !record.value || record.value.id !== record.id) {
				throw new Error(`批注记录文件格式错误，已停止读取：${path}`);
			}
			const key = recordKey(record.bucket, record.id);
			if (recordsOf(base).has(key)) throw new Error(`批注记录重复，已停止读取：${path}`);
			(base.pdfAnnotations[record.bucket] ??= []).push(copy(record.value));
			this.baseRecordPaths.add(path);
		}
		if (this.baseRecordPaths.size < manifest.recordCount) {
			throw new JournalPendingSyncError("分文件批注记录尚未同步完整，已暂停读取和写入");
		}
		if (this.baseRecordPaths.size > manifest.recordCount) throw new Error("分文件批注数量校验失败，已停止读取");
		this.legacyHash = manifest.legacyHash;
		this.base = base;
		this.events.clear();
		this.persistedIds.clear();
		await this.ensureFolder(`${this.folder}/changes`);
		await this.refresh();
		return this.view;
	}

	/** Refuse to mix writes from an old plugin with the v2 journal. */
	async legacyChanged(legacyPath: string): Promise<boolean> {
		if (!(await this.adapter.exists(legacyPath))) return false;
		return (await this.hash(await this.adapter.read(legacyPath))) !== this.legacyHash;
	}

	/** Stage synchronously so a second edit always sees the first edit as its parent. */
	stage(next: JournalState): JournalEvent | null {
		const event = changedEvent(this.view, next);
		if (!event) return null;
		this.events.set(event.id, event);
		this.view = materializeJournal(this.base, this.events.values());
		return event;
	}

	async persist(event: JournalEvent): Promise<void> {
		const path = `${this.folder}/changes/${event.id}.json`;
		if (await this.adapter.exists(path)) {
			if ((await this.adapter.read(path)) === JSON.stringify(event)) {
				this.persistedIds.add(event.id);
				return;
			}
			throw new Error(`批注修订 ID 冲突，未覆盖：${path}`);
		}
		await this.adapter.write(path, JSON.stringify(event));
		this.persistedIds.add(event.id);
	}

	async refresh(): Promise<boolean> {
		for (const path of this.baseRecordPaths) {
			if (!(await this.adapter.exists(path))) throw new Error(`批注基线记录文件消失，已停止合并：${path}`);
		}
		if (!(await this.adapter.exists(`${this.folder}/metadata.json`))) {
			throw new Error("批注元数据文件消失，已停止合并");
		}
		const expected = new Set(this.persistedIds);
		const directory = await this.adapter.list(`${this.folder}/changes`);
		const present = new Set(directory.files.filter((file) => file.endsWith(".json"))
			.map((path) => path.slice(path.lastIndexOf("/") + 1, -5)));
		for (const id of expected) if (!present.has(id)) {
			throw new Error(`已载入的批注修订文件消失，已停止合并：${id}`);
		}
		let changed = false;
		for (const path of directory.files.filter((file) => file.endsWith(".json"))) {
			const id = path.slice(path.lastIndexOf("/") + 1, -5);
			if (this.events.has(id)) continue;
			let event: JournalEvent;
			try { event = JSON.parse(await this.adapter.read(path)) as JournalEvent; }
			catch { throw new Error(`批注修订文件损坏，已停止合并：${path}`); }
			if (event.version !== 1 || event.id !== id || !Array.isArray(event.changes)) {
				throw new Error(`批注修订文件格式错误，已停止合并：${path}`);
			}
			this.events.set(id, event);
			this.persistedIds.add(id);
			changed = true;
		}
		if (changed || !this.view) this.view = materializeJournal(this.base, this.events.values());
		return changed;
	}

	async resolveAnnotation(key: string, chosenRevision: string): Promise<JournalView> {
		const conflict = this.view.conflicts.find((item) => item.key === key);
		const selected = conflict?.versions.find((version) => version.revision === chosenRevision);
		if (!conflict || !selected) throw new Error("冲突版本已变化，请重新打开冲突列表");
		const [bucket, id] = JSON.parse(key) as [string, string];
		const event: JournalEvent = {
			version: 1, id: crypto.randomUUID(),
			changes: [{ bucket, id, parents: conflict.versions.map((version) => version.revision), value: selected.value }],
		};
		await this.persist(event);
		this.events.set(event.id, event);
		this.view = materializeJournal(this.base, this.events.values());
		return this.view;
	}

	async preserveBothAnnotations(key: string, primaryRevision: string): Promise<JournalView> {
		const conflict = this.view.conflicts.find((item) => item.key === key);
		if (!conflict || conflict.versions.length !== 2 || conflict.versions.some((version) => !version.value)) {
			throw new Error("只有两份有效批注才能同时保留");
		}
		const primary = conflict.versions.find((version) => version.revision === primaryRevision);
		const other = conflict.versions.find((version) => version.revision !== primaryRevision);
		if (!primary?.value || !other?.value) throw new Error("冲突版本已变化");
		const [bucket, id] = JSON.parse(key) as [string, string];
		const duplicateId = `pa-${crypto.randomUUID()}`;
		const event: JournalEvent = {
			version: 1, id: crypto.randomUUID(),
			changes: [
				{ bucket, id, parents: conflict.versions.map((version) => version.revision), value: primary.value },
				{ bucket, id: duplicateId, parents: [], value: { ...other.value, id: duplicateId } },
			],
		};
		await this.persist(event);
		this.events.set(event.id, event);
		this.view = materializeJournal(this.base, this.events.values());
		return this.view;
	}

	async resolveMetadata(chosenRevision: string): Promise<JournalView> {
		if (!this.view.metadataConflict) throw new Error("共享关系没有待处理冲突");
		const selected = this.view.metadataVersions.find((version) => version.revision === chosenRevision);
		if (!selected) throw new Error("共享关系版本已变化，请重新打开冲突列表");
		const event: JournalEvent = {
			version: 1, id: crypto.randomUUID(), changes: [],
			metadata: { parents: this.view.metadataHeads, value: selected.value },
		};
		await this.persist(event);
		this.events.set(event.id, event);
		this.view = materializeJournal(this.base, this.events.values());
		return this.view;
	}
}
