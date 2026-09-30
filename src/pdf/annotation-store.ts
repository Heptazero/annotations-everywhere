import { debounce, normalizePath, TFile, type App, type Plugin } from "obsidian";
import {
	DEFAULT_COLOR_SLOTS,
	LEGACY_COLOR_KEY_MAP,
	makeColorSlotId,
	type AnnotationColorSlot,
} from "./annotation-settings";
import { normalizeAnnotation, type PdfAnnotation } from "./annotation-types";
import {
	annotationListsConflict,
	detachDeletedFile,
	downgradeToLinked,
	groupMembers,
	joinSharedGroups,
	mergeAnnotationLists,
	relationMode,
	sharedKey,
	unpairFile,
	type PairMode,
	type SharedStrategy,
} from "./pairing-state";
import type { OrphanedAnnotationSource } from "./annotation-recovery";
import { mergeManualOutlines, normalizeManualOutline, type ManualOutlineEntry } from "./manual-outline";
import { buildAnnotationStatusSummaries, type AnnotationStatusSummary } from "./annotation-status";
import { AnnotationJournal, journalStatesEqual, type JournalEvent, type JournalState, type JournalView } from "./annotation-journal";

interface FileShape {
	version: number;
	/**
	 * Annotations, keyed by GROUP rather than by path — a paper and its
	 * layout-preserving translation resolve to the same key, so annotating
	 * either side is literally the same data rather than two copies kept in
	 * sync. See `pairs`.
	 */
	pdfAnnotations: Record<string, PdfAnnotation[]>;
	/** member path → group key (the PDF from which manual pairing was started). */
	pairs: Record<string, string>;
	/** v6 groups are always shared; `linked` is accepted only for v5 migration. */
	pairModes: Record<string, PairMode>;
	/** File revision markers used only to decide when a layout must be rechecked. */
	pairRevisions: Record<string, Record<string, FileRevision>>;
	/** User-authored PDF headings, mirrored to each member of a shared group. */
	manualOutlines: Record<string, ManualOutlineEntry[]>;
	/** Present only in v3 input and deliberately discarded during migration. */
	fingerprints?: unknown;
}

interface FileRevision {
	mtime: number;
	size: number;
}

const FILE_NAME = "annotations.json";
const PREVIOUS_DEFAULT_FILE = ".margin-notes-hz/annotations.json";
const PORTABLE_DEFAULT_FILE = "99_assets/plugin-data/margin-note/annotations.json";

/**
 * Resolves the user's configured path to an actual file path. A value ending in
 * `.json` is used as-is; anything else is treated as a folder to put the file
 * in — writing a literal extension-less file is never what someone typing
 * `99_assets/plugin-data/margin-note` means.
 */
export function resolveDataFilePath(configured: string): string {
	const p = normalizePath(configured.trim().replace(/\/+$/, ""));
	return p.toLowerCase().endsWith(".json") ? p : `${p}/${FILE_NAME}`;
}

export type StoreListener = () => void;

export interface ColorKeyMigration {
	annotations: number;
	addedSlots: number;
}

/**
 * Owns the persisted PDF annotations, stored as one plain JSON file inside the
 * vault so it travels with whatever already syncs the notes.
 *
 * Written through `vault.adapter` rather than the `TFile` API because a
 * dot-prefixed folder isn't part of Obsidian's indexed file tree.
 */
/** Enough to cover a working session's worth of edits without holding a vault's
 * annotation history in memory forever. */
const MAX_HISTORY = 100;

function cloneAnnotation(ann: PdfAnnotation): PdfAnnotation {
	return {
		...ann,
		anchor: [...ann.anchor] as PdfAnnotation["anchor"],
		anchorRects: ann.anchorRects?.map((rect) => [...rect] as PdfAnnotation["anchor"]),
		layerIds: ann.layerIds ? [...ann.layerIds] : undefined,
	};
}

export class PdfAnnotationStore {
	private data: Record<string, PdfAnnotation[]> = {};
	private pairs: Record<string, string> = {};
	private pairModes: Record<string, PairMode> = {};
	private pairRevisions: Record<string, Record<string, FileRevision>> = {};
	private manualOutlines: Record<string, ManualOutlineEntry[]> = {};
	private migratedLegacyGroups = 0;
	private path = "";
	private listeners = new Set<StoreListener>();
	private editedSinceLoad = false;
	private scheduleSave = debounce(() => void this.flush(), 500, true);
	private journal: AnnotationJournal | null = null;
	private journalWriteFailure: string | null = null;
	private pendingRevision = false;
	private quarantinePath: string | null = null;
	private quarantineWrites: Promise<void> = Promise.resolve();
	private pendingJournalWrites: JournalEvent[] = [];
	private writingJournal = false;
	/**
	 * Undo history of whole-annotation-map snapshots.
	 *
	 * Snapshots rather than inverse operations: the mutations here are few and
	 * the data is small (a vault's worth of annotations is kilobytes), so the
	 * simplest thing that cannot get out of step with the live data is to keep
	 * copies. An operation log would need an exact inverse for every future
	 * mutation, and one missing inverse corrupts everything after it.
	 *
	 * `pairs` are deliberately NOT covered: they describe which
	 * files belong together, not the user's writing, and silently un-pairing two
	 * documents because someone pressed Cmd+Z after deleting a note would be a
	 * surprise rather than an undo.
	 */
	private undoStack: Record<string, PdfAnnotation[]>[] = [];
	private redoStack: Record<string, PdfAnnotation[]>[] = [];

	constructor(
		private app: App,
		private plugin: Plugin
	) {}

	get filePath(): string {
		return this.path;
	}

	get totalAnnotationCount(): number {
		return Object.values(this.data).reduce((total, annotations) => total + annotations.length, 0);
	}

	get usesRevisionFiles(): boolean { return this.journal !== null; }
	get waitingForRevisionFiles(): boolean { return this.pendingRevision; }
	get journalConflicts() { return this.journal?.current.conflicts ?? []; }
	get hasJournalMetadataConflict(): boolean { return this.journal?.current.metadataConflict ?? false; }
	get journalMetadataVersions() { return this.journal?.current.metadataVersions ?? []; }
	get journalError(): string | null { return this.journalWriteFailure; }
	get revisionFolder(): string | null { return this.journal?.folder ?? null; }

	private journalState(): JournalState {
		return {
			pdfAnnotations: this.data,
			pairs: this.pairs,
			pairModes: this.pairModes,
			manualOutlines: this.manualOutlines,
		};
	}

	private applyJournalView(view: JournalView): void {
		this.data = view.state.pdfAnnotations;
		this.pairs = view.state.pairs;
		this.pairModes = view.state.pairModes;
		this.manualOutlines = view.state.manualOutlines;
		// PDF mtime is device-specific. A new device rechecks layout locally.
		this.pairRevisions = {};
	}

	private save(): void {
		if (this.pendingRevision) {
			this.editedSinceLoad = true;
			void this.saveQuarantinedSnapshot().catch((error) => {
				this.journalWriteFailure = `本地待合并副本保存失败：${String(error instanceof Error ? error.message : error)}`;
				this.notify();
			});
			this.journalWriteFailure = `分文件数据尚未合并；当前修改仅保存为待合并副本 ${this.quarantinePath}`;
			this.notify();
			return;
		}
		this.editedSinceLoad = true;
		if (this.journal) {
			let event;
			try { event = this.journal.stage(this.journalState()); }
			catch (error) {
				this.applyJournalView(this.journal.current);
				this.journalWriteFailure = String(error instanceof Error ? error.message : error);
				this.notify();
				return;
			}
			if (event) {
				this.pendingJournalWrites.push(event);
				void this.drainJournalWrites();
			}
			return;
		}
		this.scheduleSave();
	}

	private saveQuarantinedSnapshot(): Promise<void> {
		const folder = this.path.slice(0, this.path.lastIndexOf("/"));
		this.quarantinePath ??= `${folder}/annotations-unmerged-${crypto.randomUUID()}.json`;
		const payload: FileShape = {
			version: 10, pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes,
			manualOutlines: this.manualOutlines, pairRevisions: this.pairRevisions,
		};
		const raw = JSON.stringify(payload, null, 2);
		this.quarantineWrites = this.quarantineWrites.catch(() => undefined)
			.then(() => this.app.vault.adapter.write(this.quarantinePath!, raw));
		return this.quarantineWrites;
	}

	private async drainJournalWrites(): Promise<void> {
		if (this.writingJournal || !this.journal) return;
		this.writingJournal = true;
		try {
			while (this.pendingJournalWrites.length > 0) {
				try { await this.journal.persist(this.pendingJournalWrites[0]); }
				catch (error) {
					this.journalWriteFailure = String(error instanceof Error ? error.message : error);
					this.notify();
					return;
				}
				this.pendingJournalWrites.shift();
			}
			if (this.journalWriteFailure) {
				this.journalWriteFailure = null;
				this.notify();
			}
		} finally { this.writingJournal = false; }
	}

	async retryPendingRevisionWrites(): Promise<boolean> {
		if (!this.journal || this.pendingJournalWrites.length === 0) return true;
		await this.drainJournalWrites();
		return this.pendingJournalWrites.length === 0;
	}

	get legacyGroupsDowngraded(): number {
		return this.migratedLegacyGroups;
	}

	onChange(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const l of this.listeners) l();
	}

	/** Repaint store consumers after settings-only changes such as a named colour. */
	notifyAppearanceChanged(): void {
		this.notify();
	}

	private snapshot(): Record<string, PdfAnnotation[]> {
		const copy: Record<string, PdfAnnotation[]> = {};
		for (const [k, list] of Object.entries(this.data)) copy[k] = list.map(cloneAnnotation);
		return copy;
	}

	/** Call immediately BEFORE mutating `data`. Any new edit invalidates redo. */
	private pushHistory(): void {
		this.undoStack.push(this.snapshot());
		if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
		this.redoStack.length = 0;
	}

	private clearHistory(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): boolean {
		const prev = this.undoStack.pop();
		if (!prev) return false;
		this.redoStack.push(this.snapshot());
		this.data = prev;
		this.save();
		this.notify();
		return true;
	}

	redo(): boolean {
		const next = this.redoStack.pop();
		if (!next) return false;
		this.undoStack.push(this.snapshot());
		this.data = next;
		this.save();
		this.notify();
		return true;
	}

	private adopt(parsed: Partial<FileShape>): boolean {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.data = {};
		for (const [key, list] of Object.entries(parsed?.pdfAnnotations ?? {})) {
			this.data[key] = ((list ?? []) as unknown[]).map((a) => normalizeAnnotation(a as never));
		}
		// Absent in v1/v2 files — an unpaired library is just an empty map.
		this.pairs = { ...(parsed?.pairs ?? {}) };
		this.pairModes = {};
		this.pairRevisions = parsed.pairRevisions ?? {};
		this.manualOutlines = {};
		for (const [path, entries] of Object.entries(parsed.manualOutlines ?? {})) {
			const normalized = normalizeManualOutline(entries);
			if (normalized.length > 0) this.manualOutlines[normalizePath(path)] = normalized;
		}
		this.migratedLegacyGroups = 0;
		for (const group of new Set(Object.values(this.pairs))) {
			this.pairModes[group] = parsed.pairModes?.[group] ?? "shared";
		}

		// v6 has one user-facing relation: a verified shared group. Old navigation-
		// only (`linked`) groups are dissolved while their independent annotations
		// remain untouched. Pre-v5 shared buckets were never fully layout-checked,
		// so first materialize them to every member, then dissolve them as well.
		for (const group of [...new Set(Object.values(this.pairs))]) {
			const member = Object.keys(this.pairs).find((path) => this.pairs[path] === group);
			if (!member) continue;
			if ((parsed.version ?? 0) < 5 && (this.pairModes[group] ?? "shared") === "shared") {
				downgradeToLinked({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, member);
			}
			if ((this.pairModes[group] ?? "shared") === "linked") {
				unpairFile({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, member);
				this.migratedLegacyGroups++;
			}
		}
		if ((parsed.version ?? 0) < 5) this.pairRevisions = {};
		this.prunePairRevisions();
		return parsed.version !== 10 || parsed.fingerprints !== undefined || this.migratedLegacyGroups > 0;
	}

	/** Loads from `configuredPath`, migrating anything left at older locations. */
	async load(configuredPath: string): Promise<void> {
		this.path = resolveDataFilePath(configuredPath);
		this.editedSinceLoad = false;
		this.pendingRevision = false;
		const adapter = this.app.vault.adapter;
		// Plugin settings may not have reached a second device yet. Only upgrade
		// the old default when its own file is absent; never override an explicit
		// custom path or a real file at the old location.
		if (this.path === PREVIOUS_DEFAULT_FILE && !(await adapter.exists(this.path)) &&
			(await adapter.exists(PORTABLE_DEFAULT_FILE))) this.path = PORTABLE_DEFAULT_FILE;
		const folder = this.path.slice(0, this.path.lastIndexOf("/"));
		if (await AnnotationJournal.exists(adapter, folder)) {
			if (!(await adapter.exists(`${folder}/revisions/metadata.json`))) {
				this.adopt({});
				this.pendingRevision = true;
				this.journalWriteFailure = "分文件迁移标记已到达，正在等待批注基线同步";
				return;
			}
			const journal = new AnnotationJournal(adapter, folder);
			const view = await journal.load();
			if (await journal.legacyChanged(this.path)) {
				throw new Error("旧版 annotations.json 在分文件迁移后发生变化；请先检查另一设备，插件已停止载入以防覆盖");
			}
			this.journal = journal;
			this.journalWriteFailure = null;
			this.applyJournalView(view);
			return;
		}

		if (await adapter.exists(this.path)) {
			let parsed: Partial<FileShape>;
			try {
				parsed = JSON.parse(await adapter.read(this.path)) as Partial<FileShape>;
			} catch {
				// A corrupt/hand-edited file must not silently wipe itself on the next
				// save — refuse to load rather than starting from an empty object.
				throw new Error(`margin-notes-hz: 批注文件解析失败,请检查 ${this.path}`);
			}
			const migrated = this.adopt(parsed);
			if (migrated) await this.flush();
			return;
		}

		// Older locations, newest first: the default folder used before the path
		// became configurable, then the plugin's own data.json (v0.2.0).
		const legacyFile = PREVIOUS_DEFAULT_FILE;
		if (legacyFile !== this.path && (await adapter.exists(legacyFile))) {
			try {
				const parsed = JSON.parse(await adapter.read(legacyFile)) as Partial<FileShape>;
				this.adopt(parsed);
				await this.flush();
				return;
			} catch {
				/* fall through to the plugin-data check */
			}
		}

		const legacy = (await this.plugin.loadData()) as { pdfAnnotations?: Record<string, unknown[]> } | null;
		if (legacy?.pdfAnnotations && Object.keys(legacy.pdfAnnotations).length > 0) {
			this.adopt(legacy as Partial<FileShape>);
			await this.flush();
		} else {
			this.adopt({});
		}
	}

	/** A sync client may deliver the vault file after the plugin has started. Never
	 * replace annotations created locally in this session with a late arrival. */
	async loadLateSyncedFile(candidatePath = this.path): Promise<boolean> {
		if (this.journal || this.pendingRevision) return false;
		if (this.editedSinceLoad || this.totalAnnotationCount > 0 || Object.keys(this.pairs).length > 0 ||
			Object.keys(this.manualOutlines).length > 0) return false;
		const adapter = this.app.vault.adapter;
		const portableFallback = this.path === PREVIOUS_DEFAULT_FILE && candidatePath === PORTABLE_DEFAULT_FILE;
		if (candidatePath !== this.path && !portableFallback) return false;
		if (portableFallback && (await adapter.exists(this.path))) return false;
		if (!candidatePath || !(await adapter.exists(candidatePath))) return false;
		let parsed: Partial<FileShape>;
		try {
			parsed = JSON.parse(await adapter.read(candidatePath)) as Partial<FileShape>;
		} catch {
			throw new Error(`margin-notes-hz: 同步的批注文件解析失败,请检查 ${candidatePath}`);
		}
		if (this.editedSinceLoad || this.totalAnnotationCount > 0) return false;
		if (!parsed.pdfAnnotations || typeof parsed.pdfAnnotations !== "object") return false;
		this.path = candidatePath;
		const migrated = this.adopt(parsed);
		if (migrated) await this.flush();
		this.notify();
		return true;
	}

	/** Moves the backing file when the configured path changes. */
	async relocate(configuredPath: string): Promise<void> {
		if (this.pendingRevision) throw new Error("批注基线尚未同步完成，暂不能移动数据目录");
		if (this.journal) throw new Error("分文件批注启用后暂不支持直接移动目录；请先完成双端同步，避免拆散修订记录");
		const next = resolveDataFilePath(configuredPath);
		if (next === this.path) return;
		const oldPath = this.path;
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(next)) {
			// A second device may already have synced the requested file. Switching
			// an empty session to it is safe; writing that empty session over it is not.
			if (this.editedSinceLoad || this.totalAnnotationCount > 0 || Object.keys(this.pairs).length > 0 ||
				Object.keys(this.manualOutlines).length > 0) {
				throw new Error(`目标位置已有批注文件，未覆盖：${next}`);
			}
			let parsed: Partial<FileShape>;
			try {
				parsed = JSON.parse(await adapter.read(next)) as Partial<FileShape>;
			} catch {
				throw new Error(`目标批注文件解析失败，未覆盖：${next}`);
			}
			if (!parsed.pdfAnnotations || typeof parsed.pdfAnnotations !== "object") {
				throw new Error(`目标不是 Margin Notes 批注文件，未覆盖：${next}`);
			}
			this.path = next;
			const migrated = this.adopt(parsed);
			if (migrated) await this.flush();
			this.notify();
			return;
		}
		this.path = next;
		try {
			await this.flush();
		} catch (error) {
			this.path = oldPath;
			throw error;
		}
		if (oldPath && (await adapter.exists(oldPath))) await adapter.remove(oldPath);
	}

	private async flush(): Promise<void> {
		if (this.journal || this.pendingRevision) return;
		if (!this.path) return;
		const adapter = this.app.vault.adapter;
		const dir = this.path.includes("/") ? this.path.slice(0, this.path.lastIndexOf("/")) : "";
		if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
		const payload: FileShape = {
			version: 10,
			pdfAnnotations: this.data,
			manualOutlines: this.manualOutlines,
			pairs: this.pairs,
			pairModes: this.pairModes,
			pairRevisions: this.pairRevisions,
		};
		await adapter.write(this.path, JSON.stringify(payload, null, 2));
	}

	/** Explicit cutover only. The original file is kept unchanged for audit and export. */
	async migrateToRevisionFiles(): Promise<void> {
		if (this.pendingRevision) throw new Error("分文件数据仍在同步，请等待完成");
		if (this.journal) return;
		const adapter = this.app.vault.adapter;
		if (!this.path || !(await adapter.exists(this.path))) throw new Error("请先确认旧批注文件已同步到当前设备");
		// A palette migration or a just-finished edit may still be waiting in the
		// old debounced writer. Make the baseline reflect the current in-memory view
		// before taking its immutable copy.
		if (this.editedSinceLoad) await this.flush();
		const raw = await adapter.read(this.path);
		let parsed: Partial<FileShape>;
		try { parsed = JSON.parse(raw) as Partial<FileShape>; }
		catch { throw new Error("旧批注文件无法解析，未迁移"); }
		if (parsed.version !== 10 || !parsed.pdfAnnotations || typeof parsed.pdfAnnotations !== "object") {
			throw new Error("请先用当前插件载入并升级旧批注文件，未迁移");
		}
		for (const [bucket, list] of Object.entries(parsed.pdfAnnotations)) {
			if (!Array.isArray(list) || list.some((item) => !item || typeof item.id !== "string" || !item.id ||
				typeof item.createdAt !== "number" || typeof item.updatedAt !== "number")) {
				throw new Error(`批注桶格式不完整，未迁移：${bucket}`);
			}
			if (new Set(list.map((item) => item.id)).size !== list.length) {
				throw new Error(`批注桶内有重复 ID，未迁移：${bucket}`);
			}
		}
		const onDisk: JournalState = {
			pdfAnnotations: Object.fromEntries(Object.entries(parsed.pdfAnnotations ?? {}).map(([key, list]) => [
				key, (list ?? []).map((annotation) => normalizeAnnotation(annotation)),
			])),
			pairs: parsed.pairs ?? {},
			pairModes: parsed.pairModes ?? {},
			manualOutlines: Object.fromEntries(Object.entries(parsed.manualOutlines ?? {}).map(([key, list]) => [
				key, normalizeManualOutline(list),
			])),
		};
		if (!journalStatesEqual(onDisk, this.journalState())) {
			throw new Error("内存与磁盘批注不一致，未迁移；请检查同步状态并重启插件");
		}
		const folder = this.path.slice(0, this.path.lastIndexOf("/"));
		const journal = new AnnotationJournal(adapter, folder);
		await journal.create(raw, onDisk);
		const verify = new AnnotationJournal(adapter, folder);
		const verifiedView = await verify.load();
		if (!journalStatesEqual(verifiedView.state, onDisk)) {
			throw new Error("分文件批注校验失败，旧文件未删除");
		}
		await adapter.remove(this.path);
		this.journal = verify;
		this.pairRevisions = {};
		this.notify();
	}

	/** New immutable files are merged into an open session, including on mobile. */
	async refreshRevisionFiles(): Promise<boolean> {
		if (!this.journal) return false;
		if (await this.journal.legacyChanged(this.path)) {
			this.journalWriteFailure = "旧版 annotations.json 在迁移后变化；请检查另一设备上的旧插件";
			this.notify();
			return false;
		}
		const changed = await this.journal.refresh();
		if (!changed) return false;
		this.clearHistory();
		this.applyJournalView(this.journal.current);
		this.notify();
		return true;
	}

	/** A new device can receive the manifest after plugin startup. */
	async loadLateRevisionFiles(): Promise<boolean> {
		if (this.journal) return false;
		const folder = this.path.slice(0, this.path.lastIndexOf("/"));
		if (!(await AnnotationJournal.exists(this.app.vault.adapter, folder))) return false;
		if (this.editedSinceLoad) {
			this.pendingRevision = true;
			await this.saveQuarantinedSnapshot();
			this.journalWriteFailure = `本机在分文件数据到达前修改了旧格式；待合并副本：${this.quarantinePath}`;
			this.notify();
			return false;
		}
		await this.load(folder);
		this.notify();
		return this.journal !== null;
	}

	async resolveRevisionConflict(key: string, revision: string): Promise<void> {
		if (!this.journal) throw new Error("尚未使用分文件批注");
		if (!(await this.retryPendingRevisionWrites())) throw new Error("请先保存未写入的批注修订");
		const view = await this.journal.resolveAnnotation(key, revision);
		this.clearHistory();
		this.applyJournalView(view);
		this.notify();
	}

	async preserveBothRevisionConflicts(key: string, primaryRevision: string): Promise<void> {
		if (!this.journal) throw new Error("尚未使用分文件批注");
		if (!(await this.retryPendingRevisionWrites())) throw new Error("请先保存未写入的批注修订");
		const view = await this.journal.preserveBothAnnotations(key, primaryRevision);
		this.clearHistory();
		this.applyJournalView(view);
		this.notify();
	}

	async resolveRevisionMetadataConflict(revision: string): Promise<void> {
		if (!this.journal) throw new Error("尚未使用分文件批注");
		if (!(await this.retryPendingRevisionWrites())) throw new Error("请先保存未写入的批注修订");
		const view = await this.journal.resolveMetadata(revision);
		this.clearHistory();
		this.applyJournalView(view);
		this.notify();
	}

	/** Creates a v10 copy for rollback; never changes the active revision journal. */
	async exportLegacySnapshot(): Promise<string> {
		if (!this.journal) throw new Error("当前仍在使用旧格式");
		if (!(await this.retryPendingRevisionWrites())) throw new Error("仍有批注修订未写入磁盘；请先重试保存");
		if (await this.journal.legacyChanged(this.path)) throw new Error("旧版批注文件已变化，不能导出；请先检查另一设备");
		await this.refreshRevisionFiles();
		if (this.journal.current.conflicts.length > 0 || this.journal.current.metadataConflict) {
			throw new Error("请先处理全部同步冲突，再导出旧格式");
		}
		const folder = this.path.slice(0, this.path.lastIndexOf("/"));
		const target = `${folder}/annotations-export-${Date.now()}-${crypto.randomUUID()}.json`;
		const payload: FileShape = {
			version: 10,
			pdfAnnotations: this.journal.current.state.pdfAnnotations,
			pairs: this.journal.current.state.pairs,
			pairModes: this.journal.current.state.pairModes,
			manualOutlines: this.journal.current.state.manualOutlines,
			pairRevisions: {},
		};
		await this.app.vault.adapter.write(target, JSON.stringify(payload, null, 2));
		return target;
	}

	/** Resolves a path to the bucket it shares with its counterpart, if paired. */
	private key(pdfPath: string): string {
		const p = normalizePath(pdfPath);
		return sharedKey({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, p);
	}

	/** All files in the same shared group, including `pdfPath` itself. */
	sharedMembers(pdfPath: string): string[] {
		return groupMembers(this.pairs, normalizePath(pdfPath));
	}

	manualOutlineForFile(pdfPath: string): ManualOutlineEntry[] {
		return (this.manualOutlines[normalizePath(pdfPath)] ?? []).map((item) => ({ ...item }));
	}

	upsertManualOutline(pdfPath: string, entry: ManualOutlineEntry): void {
		const path = normalizePath(pdfPath);
		const normalized = normalizeManualOutline([entry])[0];
		if (!normalized) return;
		const next = this.manualOutlineForFile(path);
		const index = next.findIndex((item) => item.id === entry.id);
		if (index >= 0) next[index] = normalized;
		else next.push(normalized);
		for (const member of this.sharedMembers(path).length > 0 ? this.sharedMembers(path) : [path]) {
			this.manualOutlines[member] = next.map((item) => ({ ...item }));
		}
		this.save();
		this.notify();
	}

	removeManualOutline(pdfPath: string, id: string): boolean {
		const path = normalizePath(pdfPath);
		const next = this.manualOutlineForFile(path).filter((item) => item.id !== id);
		if (next.length === this.manualOutlineForFile(path).length) return false;
		for (const member of this.sharedMembers(path).length > 0 ? this.sharedMembers(path) : [path]) {
			if (next.length > 0) this.manualOutlines[member] = next.map((item) => ({ ...item }));
			else delete this.manualOutlines[member];
		}
		this.save();
		this.notify();
		return true;
	}

	/** Persisted member paths, used to reconcile folder moves and delayed deletes. */
	pairedPaths(): string[] {
		return Object.keys(this.pairs);
	}

	isPaired(pdfPath: string): boolean {
		return normalizePath(pdfPath) in this.pairs;
	}

	relationMode(pdfPath: string): PairMode | null {
		return relationMode(
			{ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes },
			normalizePath(pdfPath)
		);
	}

	annotationCount(pdfPath: string): number {
		return this.forFile(pdfPath).length;
	}

	/** Read-only overview used by the global command; shared buckets are deduplicated. */
	annotationStatusSummaries(existingPaths: ReadonlySet<string>): AnnotationStatusSummary[] {
		return buildAnnotationStatusSummaries(this.data, this.pairs, this.pairModes, existingPaths);
	}

	/**
	 * Lists non-empty private buckets whose PDF path no longer exists. Buckets
	 * still participating in a relationship are excluded: moving those behind
	 * the relationship's back would make its surviving members read stale data.
	 */
	orphanedAnnotationSources(existingPaths: ReadonlySet<string>): OrphanedAnnotationSource[] {
		const existing = new Set([...existingPaths].map((path) => normalizePath(path)));
		const relationshipPaths = new Set([...Object.keys(this.pairs), ...Object.values(this.pairs)]);
		return Object.entries(this.data).flatMap(([path, list]) => {
			if (list.length === 0 || existing.has(path) || relationshipPaths.has(path)) return [];
			return [{
				path,
				count: list.length,
				maxPage: list.reduce((max, annotation) => Math.max(max, annotation.page), 0),
			}];
		});
	}

	/**
	 * Moves one explicitly chosen orphan bucket onto a live PDF. Existing target
	 * notes are merged losslessly; exact duplicates collapse, while divergent
	 * records sharing an id are retained under deterministic suffixed ids.
	 */
	recoverOrphanedAnnotations(
		sourcePath: string,
		targetPath: string
	): { sourceCount: number; previousTargetCount: number; resultCount: number } | null {
		const source = normalizePath(sourcePath);
		const target = normalizePath(targetPath);
		if (source === target || source in this.pairs || Object.values(this.pairs).includes(source)) return null;
		const sourceList = this.data[source];
		if (!sourceList || sourceList.length === 0) return null;

		const targetKey = this.key(target);
		const targetList = this.data[targetKey] ?? [];
		this.pushHistory();
		this.data[targetKey] = mergeAnnotationLists(targetList, sourceList).map(cloneAnnotation);
		delete this.data[source];
		this.save();
		this.notify();
		return {
			sourceCount: sourceList.length,
			previousTargetCount: targetList.length,
			resultCount: this.data[targetKey].length,
		};
	}

	/**
	 * One-time upgrade: every literal annotation colour becomes a stable named
	 * reference. Unknown literals get their own slot; the persisted annotation
	 * schema therefore never needs a second colour representation.
	 */
	migrateColorKeys(slots: AnnotationColorSlot[]): ColorKeyMigration {
		const byColor = new Map(slots.map((slot) => [slot.color.toLowerCase(), slot.id]));
		// If a user already changed an old palette entry before this migration,
		// existing notes still carry its former default hex. Stable default ids let
		// that old value find the renamed/recoloured slot by identity, not value.
		for (const legacy of DEFAULT_COLOR_SLOTS) {
			if (slots.some((slot) => slot.id === legacy.id)) byColor.set(legacy.color.toLowerCase(), legacy.id);
		}
		let changed = 0;
		let addedSlots = 0;
		for (const list of Object.values(this.data)) {
			for (const ann of list) {
				const upgradedKey = ann.colorKey ? LEGACY_COLOR_KEY_MAP[ann.colorKey] : undefined;
				if (upgradedKey) {
					ann.colorKey = slots.some((slot) => slot.id === upgradedKey) ? upgradedKey : undefined;
					changed++;
				}
				const legacyColor = (ann as PdfAnnotation & { color?: string }).color;
				if (!legacyColor) continue;
				const normalized = legacyColor.toLowerCase();
				if (!/^#[\da-f]{6}$/.test(normalized)) {
					delete (ann as PdfAnnotation & { color?: string }).color;
					changed++;
					continue;
				}
				let key = byColor.get(normalized);
				if (!key) {
					key = makeColorSlotId(slots.map((slot) => slot.id));
					slots.push({ id: key, name: `旧颜色 ${normalized}`, color: normalized });
					byColor.set(normalized, key);
					addedSlots++;
				}
				if (!ann.colorKey) ann.colorKey = key;
				delete (ann as PdfAnnotation & { color?: string }).color;
				changed++;
			}
		}
		if (changed > 0) {
			this.save();
			this.notify();
		}
		return { annotations: changed, addedSlots };
	}

	/** Deleting a slot removes the assignment; affected notes follow their default. */
	detachColorKey(key: string): number {
		let changed = 0;
		for (const list of Object.values(this.data)) {
			for (const ann of list) {
				if (ann.colorKey !== key) continue;
				ann.colorKey = undefined;
				changed++;
			}
		}
		if (changed > 0) {
			this.save();
			this.notify();
		}
		return changed;
	}

	/** Removes one layer membership everywhere; annotations themselves are never deleted. */
	detachLayerId(layerId: string): number {
		let changed = 0;
		for (const list of Object.values(this.data)) {
			for (const ann of list) {
				if (!ann.layerIds?.includes(layerId)) continue;
				changed++;
			}
		}
		if (changed === 0) return 0;
		this.pushHistory();
		for (const list of Object.values(this.data)) {
			for (const ann of list) {
				if (!ann.layerIds?.includes(layerId)) continue;
				const remaining = ann.layerIds.filter((id) => id !== layerId);
				ann.layerIds = remaining.length > 0 ? remaining : undefined;
				ann.updatedAt = Date.now();
			}
		}
		this.save();
		this.notify();
		return changed;
	}

	annotationConflict(a: string, b: string): boolean {
		return annotationListsConflict(this.forFile(a), this.forFile(b));
	}

	/** Add a file or an existing shared group to the current N-member group. */
	joinShared(a: string, b: string, strategy: SharedStrategy = "merge"): void {
		const pa = normalizePath(a);
		const pb = normalizePath(b);
		const beforeMembers = [...new Set([pa, pb, ...this.sharedMembers(pa), ...this.sharedMembers(pb)])];
		const combinedOutline = mergeManualOutlines(...beforeMembers.map((path) => this.manualOutlineForFile(path)));
		joinSharedGroups({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, pa, pb, strategy);
		for (const member of this.sharedMembers(pa)) {
			if (combinedOutline.length > 0) this.manualOutlines[member] = combinedOutline.map((item) => ({ ...item }));
			else delete this.manualOutlines[member];
		}
		this.clearHistory();
		this.prunePairRevisions();
		const group = this.pairs[pa];
		if (group) this.captureGroupRevisions(group);
		this.save();
		this.notify();
	}

	/** Current file leaves; remaining members continue sharing when at least two remain. */
	leaveGroup(pdfPath: string): boolean {
		const p = normalizePath(pdfPath);
		const members = detachDeletedFile({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, p);
		if (members.length === 0) return false;
		this.clearHistory();
		this.prunePairRevisions();
		this.refreshSharedRevisions();
		this.save();
		this.notify();
		return true;
	}

	/** Removes stale navigation on delete while keeping recoverable note snapshots. */
	detachFile(pdfPath: string): boolean {
		const p = normalizePath(pdfPath);
		const members = detachDeletedFile({ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes }, p);
		if (members.length === 0) return false;
		this.clearHistory();
		this.prunePairRevisions();
		this.refreshSharedRevisions();
		this.save();
		this.notify();
		return true;
	}

	/** Clears relationships whose member path no longer exists in the vault. */
	detachMissingFiles(existingPaths: ReadonlySet<string>): number {
		const missing = Object.entries(this.pairs)
			.filter(([member]) => !existingPaths.has(member))
			.map(([member]) => member);
		let detachedMembers = 0;
		for (const path of missing) {
			const members = detachDeletedFile(
				{ pdfAnnotations: this.data, pairs: this.pairs, pairModes: this.pairModes },
				path
			);
			if (members.length > 0) detachedMembers++;
		}
		if (detachedMembers === 0) return 0;
		this.clearHistory();
		this.prunePairRevisions();
		this.refreshSharedRevisions();
		this.save();
		this.notify();
		return detachedMembers;
	}

	/**
	 * Revision changes only mean "recheck the layout". They are not proof that
	 * page coordinates changed: sync clients commonly rewrite an identical PDF
	 * or touch its mtime.
	 */
	changedSharedMembers(): string[] {
		const changed: string[] = [];
		for (const group of [...new Set(Object.values(this.pairs))]) {
			if ((this.pairModes[group] ?? "shared") !== "shared") continue;
			const members = Object.keys(this.pairs).filter((path) => this.pairs[path] === group);
			const recorded = this.pairRevisions[group];
			for (const path of members) {
				const current = this.fileRevision(path);
				const previous = recorded?.[path];
				if (!current || !previous || current.mtime !== previous.mtime || current.size !== previous.size) {
					changed.push(path);
				}
			}
		}
		return changed;
	}

	/** Record one member only after its current page layout has been verified. */
	acceptCurrentRevision(pdfPath: string): boolean {
		const path = normalizePath(pdfPath);
		const group = this.pairs[path];
		if (!group || (this.pairModes[group] ?? "shared") !== "shared") return false;
		const revision = this.fileRevision(path);
		if (!revision) return false;
		this.pairRevisions[group] ??= {};
		this.pairRevisions[group][path] = revision;
		this.save();
		return true;
	}

	private fileRevision(path: string): FileRevision | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? { mtime: file.stat.mtime, size: file.stat.size } : null;
	}

	private captureGroupRevisions(group: string): void {
		const revisions: Record<string, FileRevision> = {};
		for (const [member, memberGroup] of Object.entries(this.pairs)) {
			if (memberGroup !== group) continue;
			const revision = this.fileRevision(member);
			if (revision) revisions[member] = revision;
		}
		this.pairRevisions[group] = revisions;
	}

	private refreshSharedRevisions(): void {
		for (const group of new Set(Object.values(this.pairs))) {
			if ((this.pairModes[group] ?? "shared") === "shared") this.captureGroupRevisions(group);
		}
	}

	private prunePairRevisions(): void {
		for (const group of Object.keys(this.pairRevisions)) {
			if (!Object.values(this.pairs).includes(group) || (this.pairModes[group] ?? "shared") !== "shared") {
				delete this.pairRevisions[group];
			}
		}
	}

	/**
	 * Readers get COPIES, never the stored objects.
	 *
	 * Callers edit an annotation in place and then hand it back to `upsert`
	 * (see the layer's `mutate`). If that were the same object the store holds,
	 * the edit would already be applied to the store's own state by the time
	 * `upsert` ran — so the "before" snapshot taken there would capture the
	 * edited value, and undoing a text/colour/position change would silently do
	 * nothing (only add and delete would ever work). Copying on the way out is
	 * what makes the stored state genuinely the previous one.
	 */
	forPage(pdfPath: string, page: number): PdfAnnotation[] {
		return (this.data[this.key(pdfPath)] ?? []).filter((a) => a.page === page).map(cloneAnnotation);
	}

	forFile(pdfPath: string): PdfAnnotation[] {
		return (this.data[this.key(pdfPath)] ?? []).map(cloneAnnotation);
	}

	/**
	 * `recordHistory: false` for writes the user did not perform — currently the
	 * automatic quote→anchor resolution, which would otherwise fill the undo
	 * stack with entries that undo something nobody did.
	 */
	upsert(pdfPath: string, ann: PdfAnnotation, recordHistory = true): void {
		if (recordHistory) this.pushHistory();
		const key = this.key(pdfPath);
		const list = (this.data[key] ??= []);
		const stored = cloneAnnotation(ann);
		const idx = list.findIndex((a) => a.id === ann.id);
		if (idx >= 0) list[idx] = stored;
		else list.push(stored);
		this.save();
		this.notify();
	}

	remove(pdfPath: string, id: string): void {
		const key = this.key(pdfPath);
		const list = this.data[key];
		if (!list) return;
		this.pushHistory();
		this.data[key] = list.filter((a) => a.id !== id);
		this.save();
		this.notify();
	}

	/**
	 * Keeps annotations attached to their file when it's renamed/moved — plain
	 * path-string keys would otherwise orphan them silently.
	 */
	renameFile(oldPath: string, newPath: string): void {
		this.renamePath(oldPath, newPath, false);
	}

	/**
	 * Obsidian emits one TFolder rename when a whole paper folder moves. Re-key
	 * every stored child path in one pass; waiting for child TFile events loses
	 * the relation because those events are not guaranteed to exist.
	 */
	renameFolder(oldPath: string, newPath: string): number {
		return this.renamePath(oldPath, newPath, true);
	}

	private renamePath(oldPath: string, newPath: string, descendants: boolean): number {
		const from = normalizePath(oldPath);
		const to = normalizePath(newPath);
		if (from === to) return 0;
		const remap = (path: string): string => {
			if (path === from) return to;
			return descendants && path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
		};
		const changed = new Set<string>();

		const nextPairs: Record<string, string> = {};
		for (const [member, group] of Object.entries(this.pairs)) {
			const nextMember = remap(member);
			const nextGroup = remap(group);
			if (nextMember !== member) changed.add(member);
			if (nextGroup !== group) changed.add(group);
			nextPairs[nextMember] = nextGroup;
		}

		const nextModes: Record<string, PairMode> = {};
		for (const [group, mode] of Object.entries(this.pairModes)) {
			const nextGroup = remap(group);
			if (nextGroup !== group) changed.add(group);
			nextModes[nextGroup] = mode;
		}

		const nextData: Record<string, PdfAnnotation[]> = {};
		for (const [key, list] of Object.entries(this.data)) {
			const nextKey = remap(key);
			if (nextKey !== key) changed.add(key);
			nextData[nextKey] = mergeAnnotationLists(nextData[nextKey], list);
		}
		const nextManualOutlines: Record<string, ManualOutlineEntry[]> = {};
		for (const [path, entries] of Object.entries(this.manualOutlines)) {
			const nextPath = remap(path);
			if (nextPath !== path) changed.add(path);
			nextManualOutlines[nextPath] = mergeManualOutlines(nextManualOutlines[nextPath] ?? [], entries);
		}

		if (changed.size === 0) return 0;
		this.pairs = nextPairs;
		this.pairModes = nextModes;
		this.data = nextData;
		this.manualOutlines = nextManualOutlines;
		// Revisions contain exact member paths. Rebuild them from Obsidian's new
		// file objects instead of trying to patch several nested maps independently.
		this.pairRevisions = {};
		this.prunePairRevisions();
		this.refreshSharedRevisions();
		this.save();
		this.notify();
		return changed.size;
	}
}
