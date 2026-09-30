import assert from "node:assert/strict";
import type { App, Plugin } from "obsidian";
import { PdfAnnotationStore } from "../src/pdf/annotation-store";
import { normalizeAnnotation } from "../src/pdf/annotation-types";

const folder = "99_assets/plugin-data/margin-note";
const dataFile = `${folder}/annotations.json`;
const payload = (id: string) => JSON.stringify({
	version: 10,
	pdfAnnotations: { "paper.pdf": [{ id, page: 1, text: id, anchor: [0, 0, 0, 0] }] },
	manualOutlines: {},
	pairs: {},
	pairModes: {},
	pairRevisions: {},
});

function makeStore(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	const app = { vault: { adapter: {
		exists: async (path: string) => files.has(path),
		read: async (path: string) => {
			const data = files.get(path);
			if (data === undefined) throw new Error(`Missing ${path}`);
			return data;
		},
		write: async (path: string, data: string) => { files.set(path, data); },
		mkdir: async () => undefined,
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

console.log("annotation-sync: 6 cases passed");
