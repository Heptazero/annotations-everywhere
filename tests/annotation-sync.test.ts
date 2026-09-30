import assert from "node:assert/strict";
import type { App, Plugin } from "obsidian";
import { PdfAnnotationStore } from "../src/pdf/annotation-store";
import { normalizeAnnotation } from "../src/pdf/annotation-types";

const folder = "99_assets/plugin-data/margin-note";
const dataFile = `${folder}/annotations.json`;
const payload = (id: string) => JSON.stringify({
	version: 10,
	pdfAnnotations: { "paper.pdf": [{ id, page: 1, text: id, anchor: [0, 0, 0, 0], createdAt: 1, updatedAt: 1 }] },
	manualOutlines: {},
	pairs: {},
	pairModes: {},
	pairRevisions: {},
});

function makeStore(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const folders = new Set<string>();
	const hasFolder = (path: string) => folders.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
	const app = { vault: { getAbstractFileByPath: () => null, adapter: {
		exists: async (path: string) => files.has(path) || hasFolder(path),
		read: async (path: string) => {
			const data = files.get(path);
			if (data === undefined) throw new Error(`Missing ${path}`);
			return data;
		},
		write: async (path: string, data: string) => { files.set(path, data); },
		mkdir: async (path: string) => { folders.add(path); },
		list: async (path: string) => {
			if (!hasFolder(path)) throw new Error(`Missing folder ${path}`);
			return {
				files: [...files.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")),
				folders: [],
			};
		},
		remove: async (path: string) => { files.delete(path); },
	} } } as unknown as App;
	const plugin = { loadData: async () => ({}) } as unknown as Plugin;
	return { files, store: new PdfAnnotationStore(app, plugin) };
}

// A fresh mobile install may have no synced plugin settings, but the vault data
// is already present. The old default must resolve to that file without moving it.
{
	const { files, store } = makeStore({ [dataFile]: payload("desktop") });
	await store.load(".margin-notes-hz");
	assert.equal(store.filePath, dataFile);
	assert.equal(store.totalAnnotationCount, 1);
	assert.equal(files.get(dataFile), payload("desktop"));
}

// If the sync client delivers the file after plugin startup, an empty session
// can adopt it and notify the list panel through the store listener.
{
	const { files, store } = makeStore();
	await store.load(folder);
	let changes = 0;
	store.onChange(() => { changes++; });
	files.set(dataFile, payload("arrived-late"));
	assert.equal(await store.loadLateSyncedFile(), true);
	assert.equal(store.totalAnnotationCount, 1);
	assert.equal(changes, 1);
}

// The portable file can also arrive after a device started with old settings.
{
	const { files, store } = makeStore();
	await store.load(".margin-notes-hz");
	files.set(dataFile, payload("arrived-after-old-settings"));
	assert.equal(await store.loadLateSyncedFile(dataFile), true);
	assert.equal(store.filePath, dataFile);
	assert.equal(store.totalAnnotationCount, 1);
}

// Changing the configured folder on a device with no local data must open an
// existing synced file instead of replacing it with an empty JSON payload.
{
	const { files, store } = makeStore();
	await store.load(".margin-notes-hz");
	const remote = payload("keep-desktop-data");
	files.set(dataFile, remote);
	await store.relocate(folder);
	assert.equal(store.totalAnnotationCount, 1);
	assert.equal(files.get(dataFile), remote);
}

// Two existing data files need manual reconciliation; neither may be wiped.
{
	const sourceFile = "other-folder/annotations.json";
	const source = payload("source");
	const remote = payload("remote");
	const { files, store } = makeStore({ [sourceFile]: source, [dataFile]: remote });
	await store.load("other-folder");
	await assert.rejects(store.relocate(folder), /未覆盖/);
	assert.equal(store.filePath, sourceFile);
	assert.equal(files.get(sourceFile), source);
	assert.equal(files.get(dataFile), remote);
}

// Never replace notes authored locally while the remote file was absent.
{
	const { files, store } = makeStore();
	await store.load(folder);
	store.upsert("paper.pdf", normalizeAnnotation({ id: "mobile", page: 1, text: "mobile" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	files.set(dataFile, payload("desktop"));
	assert.equal(await store.loadLateSyncedFile(), false);
	assert.equal(store.forFile("paper.pdf")[0].id, "mobile");
}

// Opt-in migration removes the old file after validation, writes current records
// individually, and stores later edits as separate immutable revisions.
{
	const original = payload("baseline");
	const { files, store } = makeStore({ [dataFile]: original });
	await store.load(folder);
	await store.migrateToRevisionFiles();
	assert.equal(store.usesRevisionFiles, true);
	assert.equal(files.has(dataFile), false);
	store.upsert("paper.pdf", normalizeAnnotation({ id: "after", page: 1, text: "after" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(files.has(dataFile), false);
	assert.equal([...files.keys()].filter((path) => path.includes("/revisions/records/")).length, 1);
	assert.equal([...files.keys()].filter((path) => path.includes("/revisions/changes/")).length, 1);
	const exportPath = await store.exportLegacySnapshot();
	assert.deepEqual((JSON.parse(files.get(exportPath)!) as { pdfAnnotations: Record<string, Array<{ id: string }>> })
		.pdfAnnotations["paper.pdf"].map((item) => item.id).sort(), ["after", "baseline"]);
	assert.equal(files.has(dataFile), false);
	const reopened = makeStore(Object.fromEntries(files));
	await reopened.store.load(folder);
	assert.deepEqual(reopened.store.forFile("paper.pdf").map((item) => item.id).sort(), ["after", "baseline"]);
}

// The sync client may deliver a manifest before its record files. Startup must
// wait safely, then load the complete baseline when the remaining file arrives.
{
	const migrated = makeStore({ [dataFile]: payload("baseline") });
	await migrated.store.load(folder);
	await migrated.store.migrateToRevisionFiles();
	const recordPath = [...migrated.files.keys()].find((path) => path.includes("/revisions/records/"));
	assert.ok(recordPath);
	const record = migrated.files.get(recordPath);
	assert.ok(record);
	migrated.files.delete(recordPath);
	const receiving = makeStore(Object.fromEntries(migrated.files));
	await receiving.store.load(folder);
	assert.equal(receiving.store.waitingForRevisionFiles, true);
	assert.equal(receiving.store.usesRevisionFiles, false);
	receiving.files.set(recordPath, record);
	assert.equal(await receiving.store.loadLateRevisionFiles(), true);
	assert.equal(receiving.store.waitingForRevisionFiles, false);
	assert.equal(receiving.store.totalAnnotationCount, 1);
}

// Shared groups keep one visible annotation bucket when expanded to three PDFs.
{
	const { files, store } = makeStore({ [dataFile]: payload("original") });
	await store.load(folder);
	await store.migrateToRevisionFiles();
	store.joinShared("paper.pdf", "cn.pdf");
	store.joinShared("paper.pdf", "second-translation.pdf");
	store.upsert("second-translation.pdf", normalizeAnnotation({ id: "translated", page: 1, text: "shared" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const reopened = makeStore(Object.fromEntries(files));
	await reopened.store.load(folder);
	for (const path of ["paper.pdf", "cn.pdf", "second-translation.pdf"]) {
		assert.deepEqual(reopened.store.forFile(path).map((item) => item.id).sort(), ["original", "translated"]);
	}
	assert.equal(reopened.store.sharedMembers("cn.pdf").length, 3);
}

// A modified legacy file indicates an old device is still writing and prevents
// a new-session silent fork.
{
	const { files, store } = makeStore({ [dataFile]: payload("baseline") });
	await store.load(folder);
	await store.migrateToRevisionFiles();
	files.set(dataFile, payload("old-phone-edit"));
	const reopened = makeStore(Object.fromEntries(files));
	await assert.rejects(reopened.store.load(folder), /旧版 annotations.json/);
}

console.log("annotation-sync: 10 cases passed");
