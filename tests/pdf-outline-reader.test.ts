import assert from "node:assert/strict";
import { TFile, type App } from "obsidian";
import { PdfOutlineReader, resolvePdfOutline, type PdfOutlineDocument } from "../src/pdf/pdf-outline";

const app = { vault: { readBinary: async () => new ArrayBuffer(8) } } as unknown as App;
const file = new TFile("outline.pdf");
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function document(overrides: Partial<PdfOutlineDocument> = {}): PdfOutlineDocument {
	return {
		getOutline: async () => [{ title: "Chapter", dest: [0, { name: "FitH" }, null] }],
		getDestination: async () => [0, { name: "XYZ" }, 0, 700],
		getPageIndex: async () => 0,
		getPage: async () => ({ view: [0, 0, 612, 792] }),
		destroy() {},
		...overrides,
	};
}

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
try {
// A named destination can still be in flight after getOutline returns. Its
// worker must survive until BOTH the destination and page geometry are read.
{
	const started = deferred<void>();
	const destination = deferred<unknown[] | null>();
	const pageStarted = deferred<void>();
	const page = deferred<{ view: [number, number, number, number] }>();
	let destroyed = 0;
	const doc = document({
		getOutline: async () => [{ title: "Chapter", dest: "chapter" }],
		getDestination: () => { started.resolve(); return destination.promise; },
		getPage: () => { pageStarted.resolve(); return page.promise; },
		destroy: () => { destroyed++; },
	});
	const reader = new PdfOutlineReader(app, { loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve(doc) }) }) });
	const pending = reader.read(file);
	assert.equal(reader.read(file), pending, "simultaneous callers share a read");
	await started.promise;
	assert.equal(destroyed, 0, "do not destroy during destination lookup");
	destination.resolve([0, { name: "XYZ" }, 0, 700]);
	await pageStarted.promise;
	assert.equal(destroyed, 0, "do not destroy during page lookup");
	page.resolve({ view: [0, 0, 612, 792] });
	const items = await pending;
	assert.equal(items[0].page, 1);
	assert.equal(items[0].topRatio, 92 / 792);
	assert.equal(destroyed, 1);
	assert.equal(reader.read(file), pending, "finished reads are cached");
	reader.invalidate(file.path);
	assert.notEqual(reader.read(file), pending, "explicit retry bypasses the cache");
	await reader.read(file);
}

// Many headings on one page share the in-flight page geometry request.
{
	let pages = 0;
	const doc = document({ getPage: async () => { pages++; return { view: [0, 0, 612, 792] }; } });
	const items = await resolvePdfOutline(doc, [100, 200, 300].map((top) => ({ title: `Heading ${top}`, dest: [0, { name: "FitH" }, top] })));
	assert.equal(items.length, 3);
	assert.equal(pages, 1);
}

// A stuck loading task times out, is released once, and is not cached forever.
{
	let stuck = true, released = 0;
	const reader = new PdfOutlineReader(app, {
		timeoutMs: 15,
		loadPdfJs: async () => ({ getDocument: () => ({
			promise: stuck ? new Promise<PdfOutlineDocument>(() => {}) : Promise.resolve(document()),
			destroy: () => { released++; return new Promise<void>(() => {}); },
		}) }),
	});
	await assert.rejects(reader.read(file), /超时/);
	assert.equal(released, 1, "even stuck cleanup must not block rejection");
	stuck = false;
	assert.equal((await reader.read(file))[0].page, 1, "a timed-out read can be retried");
	assert.equal(released, 2);
}

// The deadline also covers a stalled outline request, not just PDF opening.
{
	let released = 0;
	const doc = document({ getOutline: () => new Promise(() => {}), destroy: () => { released++; } });
	const reader = new PdfOutlineReader(app, { timeoutMs: 15, loadPdfJs: async () => ({ getDocument: () => ({ promise: Promise.resolve(doc) }) }) });
	await assert.rejects(reader.read(file), /超时/);
	assert.equal(released, 1);
}

// A loader arriving after timeout must not open a new background document.
{
	const loader = deferred<{ getDocument(): { promise: Promise<PdfOutlineDocument> } }>();
	let opened = 0;
	const reader = new PdfOutlineReader(app, { timeoutMs: 15, loadPdfJs: () => loader.promise });
	await assert.rejects(reader.read(file), /超时/);
	loader.resolve({ getDocument: () => { opened++; return { promise: Promise.resolve(document()) }; } });
	await Promise.resolve();
	assert.equal(opened, 0);
}

// Older PDF.js versions may only expose destroy on the eventual document.
{
	const opening = deferred<PdfOutlineDocument>();
	let released = 0;
	const reader = new PdfOutlineReader(app, { timeoutMs: 15, loadPdfJs: async () => ({ getDocument: () => ({ promise: opening.promise }) }) });
	await assert.rejects(reader.read(file), /超时/);
	opening.resolve(document({ destroy: () => { released++; } }));
	await Promise.resolve();
	assert.equal(released, 1, "late documents are released as well");
}
} finally {
	if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
	else Reflect.deleteProperty(globalThis, "window");
}

console.log("pdf-outline-reader: worker lifetime, in-flight caching, shared page geometry, timeout/retry and late cleanup passed");
