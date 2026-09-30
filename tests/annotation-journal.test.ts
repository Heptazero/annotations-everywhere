import assert from "node:assert/strict";
import type { DataAdapter } from "obsidian";
import { AnnotationJournal, materializeJournal, type JournalState } from "../src/pdf/annotation-journal";
import { normalizeAnnotation } from "../src/pdf/annotation-types";

const dataFolder = "99_assets/plugin-data/margin-note";
const note = (id: string, text: string) => normalizeAnnotation({ id, page: 1, text, createdAt: 1, updatedAt: 2 });
const empty = (): JournalState => ({ pdfAnnotations: {}, pairs: {}, pairModes: {}, manualOutlines: {} });

function mockDisk() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const adapter = {
		exists: async (path: string) => files.has(path) || folders.has(path),
		mkdir: async (path: string) => { folders.add(path); },
		write: async (path: string, value: string) => { files.set(path, value); },
		read: async (path: string) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`Missing ${path}`);
			return value;
		},
		list: async (path: string) => ({
			files: [...files.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")),
			folders: [],
		}),
	} as unknown as DataAdapter;
	return { files, adapter };
}

// A migration writes new-format record files plus metadata; no baseline copy exists.
{
	const { files, adapter } = mockDisk();
	const base: JournalState = { ...empty(), pdfAnnotations: {
		"english.pdf": [note("same-old-id", "source")],
		"translation.pdf": [note("same-old-id", "translation")],
	} };
	const raw = JSON.stringify(base);
	const journal = new AnnotationJournal(adapter, dataFolder);
	await journal.create(raw, base);
	assert.equal(files.has(`${dataFolder}/revisions/baseline.json`), false);
	assert.equal([...files.keys()].filter((path) => path.includes("/revisions/records/")).length, 2);
	assert.equal(files.has(`${dataFolder}/revisions/metadata.json`), true);
	assert.equal(journal.current.state.pdfAnnotations["english.pdf"].length, 1);
	assert.equal(journal.current.state.pdfAnnotations["translation.pdf"].length, 1);
	const reopened = new AnnotationJournal(adapter, dataFolder);
	await reopened.load();
	assert.equal(reopened.current.conflicts.length, 0);
	assert.equal(await reopened.legacyChanged(`${dataFolder}/annotations.json`), false);
}

// Two devices can add distinct notes to the same PDF without touching the same file.
{
	const { files, adapter } = mockDisk();
	const base = empty();
	const raw = JSON.stringify(base);
	files.set(`${dataFolder}/annotations.json`, raw);
	const a = new AnnotationJournal(adapter, dataFolder);
	await a.create(raw, base);
	const b = new AnnotationJournal(adapter, dataFolder);
	await b.load();
	const aEvent = a.stage({ ...empty(), pdfAnnotations: { "paper.pdf": [note("a", "desktop")] } });
	const bEvent = b.stage({ ...empty(), pdfAnnotations: { "paper.pdf": [note("b", "mobile")] } });
	assert.ok(aEvent && bEvent);
	await a.persist(aEvent);
	await b.persist(bEvent);
	assert.notEqual(aEvent.id, bEvent.id);
	await a.refresh();
	await b.refresh();
	assert.deepEqual(a.current.state.pdfAnnotations["paper.pdf"].map((item) => item.id).sort(), ["a", "b"]);
	assert.deepEqual(b.current.state.pdfAnnotations["paper.pdf"].map((item) => item.id).sort(), ["a", "b"]);
	assert.equal(a.current.conflicts.length, 0);
}

// Concurrent edits to one record retain both heads, including edit vs delete.
{
	const { files, adapter } = mockDisk();
	const base: JournalState = { ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "original")] } };
	const raw = JSON.stringify(base);
	files.set(`${dataFolder}/annotations.json`, raw);
	const a = new AnnotationJournal(adapter, dataFolder);
	await a.create(raw, base);
	const b = new AnnotationJournal(adapter, dataFolder);
	await b.load();
	const edited: JournalState = { ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "edited")] } };
	const edit = a.stage(edited);
	const deletion = b.stage(empty());
	assert.ok(edit && deletion);
	await a.persist(edit);
	await b.persist(deletion);
	await a.refresh();
	assert.equal(a.current.conflicts.length, 1);
	assert.equal(a.current.state.pdfAnnotations["paper.pdf"][0].text, "edited");
	await a.resolveAnnotation(a.current.conflicts[0].key, deletion.id);
	assert.equal(a.current.conflicts.length, 0);
	assert.equal(a.current.state.pdfAnnotations["paper.pdf"], undefined);
}

// "Keep both" forks one legacy ID, and an independent device sees the resolution.
{
	const { files, adapter } = mockDisk();
	const base: JournalState = { ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "original")] } };
	const raw = JSON.stringify(base);
	files.set(`${dataFolder}/annotations.json`, raw);
	const a = new AnnotationJournal(adapter, dataFolder);
	await a.create(raw, base);
	const b = new AnnotationJournal(adapter, dataFolder);
	await b.load();
	const left = a.stage({ ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "left")] } });
	const right = b.stage({ ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "right")] } });
	assert.ok(left && right);
	await a.persist(left);
	await b.persist(right);
	await a.refresh();
	await a.preserveBothAnnotations(a.current.conflicts[0].key, left.id);
	assert.equal(a.current.conflicts.length, 0);
	assert.deepEqual(a.current.state.pdfAnnotations["paper.pdf"].map((item) => item.text).sort(), ["left", "right"]);
	await b.refresh();
	assert.equal(b.current.conflicts.length, 0);
	assert.equal(b.current.state.pdfAnnotations["paper.pdf"].length, 2);
}

// Bindings are a separate revision stream and simultaneous structural changes
// are held for explicit choice rather than silently choosing one device.
{
	const { adapter } = mockDisk();
	const base = empty();
	const a = new AnnotationJournal(adapter, dataFolder);
	await a.create(JSON.stringify(base), base);
	const b = new AnnotationJournal(adapter, dataFolder);
	await b.load();
	const aEvent = a.stage({ ...empty(), pairs: { "a.pdf": "a.pdf", "b.pdf": "a.pdf" }, pairModes: { "a.pdf": "shared" } });
	const bEvent = b.stage({ ...empty(), pairs: { "x.pdf": "x.pdf", "y.pdf": "x.pdf" }, pairModes: { "x.pdf": "shared" } });
	assert.ok(aEvent && bEvent);
	await a.persist(aEvent);
	await b.persist(bEvent);
	await a.refresh();
	assert.equal(a.current.metadataConflict, true);
	await a.resolveMetadata(aEvent.id);
	assert.equal(a.current.metadataConflict, false);
	assert.equal(a.current.state.pairs["b.pdf"], "a.pdf");
}

// Replaying an event set does not depend on filesystem enumeration order.
{
	const base: JournalState = { ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "old")] } };
	const parent = { version: 1 as const, id: "one", changes: [{ bucket: "paper.pdf", id: "n", parents: ["base"], value: note("n", "one") }] };
	const child = { version: 1 as const, id: "two", changes: [{ bucket: "paper.pdf", id: "n", parents: ["one"], value: note("n", "two") }] };
	assert.equal(materializeJournal(base, [parent, child]).state.pdfAnnotations["paper.pdf"][0].text, "two");
	assert.equal(materializeJournal(base, [child, parent]).state.pdfAnnotations["paper.pdf"][0].text, "two");
}

// Identical concurrent writes are not presented as user-visible conflicts.
{
	const base: JournalState = { ...empty(), pdfAnnotations: { "paper.pdf": [note("n", "old")] } };
	const a = { version: 1 as const, id: "a", changes: [{ bucket: "paper.pdf", id: "n", parents: ["base"], value: note("n", "same") }] };
	const b = { version: 1 as const, id: "b", changes: [{ bucket: "paper.pdf", id: "n", parents: ["base"], value: note("n", "same") }] };
	const view = materializeJournal(base, [a, b]);
	assert.equal(view.conflicts.length, 0);
	assert.deepEqual(view.annotationHeads.get(JSON.stringify(["paper.pdf", "n"])), ["a", "b"]);
}

console.log("annotation-journal: 7 cases passed");
