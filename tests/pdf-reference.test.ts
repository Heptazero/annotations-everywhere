import assert from "node:assert/strict";
import { Component, Notice, TFile } from "obsidian";
import { normalizeAnnotation } from "../src/pdf/annotation-types";
import { prepareAnnotationTransfer } from "../src/pdf/annotation-batch";
import { PdfReferenceIndex, type PdfReferenceSource } from "../src/pdf/pdf-reference-index";
import { registerPdfReferenceLinkOpen } from "../src/pdf/pdf-reference-link-open";
import { annotationForReferenceRegion, isReferenceAnnotation, materializeReferenceAnnotation, referenceAnnotation, resolveReferenceRegions } from "../src/pdf/pdf-reference-regions";
import { PdfReferenceService } from "../src/pdf/pdf-reference-service";
import { DEFAULT_PDF_ANNOTATION_SETTINGS } from "../src/pdf/annotation-settings";
import { buildPdfReferenceSubpath, formatPdfReferenceCopy, normalizeStoredTextSelection, parsePdfReferenceSubpath, targetForAnnotation } from "../src/pdf/pdf-reference-target";

const native = { page: 2, selection: [0, 2, 1, 4] as [number, number, number, number] };
const rectangle = { page: 2, rect: [10, 20, 40, 60] as [number, number, number, number] };
assert.deepEqual(parsePdfReferenceSubpath(buildPdfReferenceSubpath(native)), { ...native, rect: undefined });
assert.deepEqual(parsePdfReferenceSubpath(buildPdfReferenceSubpath(rectangle)), { ...rectangle, selection: undefined });
assert.equal(buildPdfReferenceSubpath({ ...native, ...rectangle }), "#page=2&selection=0,2,1,4");
assert.equal(buildPdfReferenceSubpath({ page: 1, rect: [-0.1, 0.1, 0.2, 0.3] }), "#page=1&rect=-1,0,1,1");
for (const subpath of ["", "#page=0&rect=1,2,3,4", "#page=2.1&rect=1,2,3,4", "#page=1&rect=1,2,1,4", "#page=1&rect=1,2,NaN,4", "#page=1&selection=0,2,0,2", "#page=1&selection=-1,2,3,4", "#page=1&selection=1,2,0,4", "#page=1&selection=0,,1,4"]) assert.equal(parsePdfReferenceSubpath(subpath), null, subpath);
assert.throws(() => buildPdfReferenceSubpath({ page: 1, rect: [0, 0, 0, 0] }));
assert.equal(normalizeStoredTextSelection({ pdfPath: "a.pdf", page: 1, range: [0, 1, 0, 1] }), undefined);
const stored = { pdfPath: "cn.pdf", page: 2, range: native.selection };
const ann = normalizeAnnotation({ id: "saved", ...rectangle, anchor: rectangle.rect, textSelection: stored, text: "正文\n$E=mc^2$", quote: "中文\n引文" });
assert.deepEqual(targetForAnnotation("cn.pdf", ann).selection, native.selection);
assert.equal(targetForAnnotation("en.pdf", ann).selection, undefined, "shared PDFs must not reuse each other's text offsets");
assert.equal(targetForAnnotation("cn.pdf", { ...ann, page: 3 }).selection, undefined);
assert.deepEqual(normalizeAnnotation(JSON.parse(JSON.stringify(ann))).textSelection, stored);
assert.equal(formatPdfReferenceCopy("[[cn.pdf#page=2|p. 2]]", "第一行\n$E=mc^2$", "quote"), "> 第一行\n> $E=mc^2$\n> [[cn.pdf#page=2|p. 2]]");
assert.equal(formatPdfReferenceCopy("link", "quote", "link"), "link");
assert.equal(formatPdfReferenceCopy("link", "", "quote"), "link");
const layout = [{ width: 100, height: 200, rotation: 0 }, { width: 100, height: 200, rotation: 0 }];
const transfer = prepareAnnotationTransfer([ann], [{ sourceFrom: 2, sourceTo: 2, targetFrom: 1 }], layout, layout);
assert.equal(transfer.annotations[0].textSelection, undefined);
assert.deepEqual(ann.textSelection, stored, "transfer must not modify source offsets");

function ref(link: string, page = 2): PdfReferenceSource {
	return { sourcePath: "note.md", line: 3, ch: 2, link, target: parsePdfReferenceSubpath(link) ?? { ...rectangle, page } };
}
const nativeRef = ref("#page=2&selection=0,2,1,4");
const rectRef = ref("#page=2&rect=10,20,40,60");
const lines: [number, number, number, number][] = [[10.2, 20.1, 40, 30], [10.3, 40, 39.9, 59.8]];
const regions = resolveReferenceRegions([rectRef, nativeRef, ref("#page=3&rect=10,20,40,60"), ref("#page=2&rect=80,20,90,60")], () => lines);
assert.equal(regions.length, 3, "same page/region deduplicates rect and native encodings only");
assert.equal(regions[0].sources.length, 2);
assert.deepEqual(regions[0].rects, lines, "native multilines win over rectangle bounding box");
assert.equal(annotationForReferenceRegion(regions[0], [ann])?.id, "saved");
assert.equal(annotationForReferenceRegion(regions[0], [{ ...ann, page: 3 }]), undefined);
assert.equal(resolveReferenceRegions([nativeRef], () => []).length, 0, "unrendered text layer must not guess an anchor");
const derived = referenceAnnotation("cn.pdf", regions[0]);
assert.equal(isReferenceAnnotation(derived), true);
assert.equal(derived.createdAt, 0);
assert.deepEqual(derived.anchorRects, lines);
assert.equal(derived.textSelection?.pdfPath, "cn.pdf");
const promoted = materializeReferenceAnnotation(derived);
assert.notEqual(promoted.id, derived.id);
assert.ok(promoted.createdAt > 0);
assert.equal(isReferenceAnnotation(promoted), false);
assert.equal(materializeReferenceAnnotation(promoted), promoted);
assert.equal(derived.createdAt, 0, "derived record remains ephemeral");

const pdf = new TFile("folder/cn.pdf");
const note = new TFile("note.md");
const embedNote = new TFile("embed.md");
const nonMarkdown = new TFile("canvas.canvas");
const files = new Map([pdf, note, embedNote, nonMarkdown].map((file) => [file.path, file]));
const link = (value: string, line = 1) => ({ link: value, position: { start: { line, col: 2 } } });
let links = [link("cn.pdf#page=2&selection=0,2,1,4"), link("cn.pdf#page=2&rect=10,20,40,60", 2), link("other.pdf#page=2&rect=10,20,40,60"), link("cn.pdf#page=2"), link("cn.pdf#page=2&rect=1,2,1,4")];
const app = {
	vault: { getAbstractFileByPath: (path: string) => files.get(path) },
	metadataCache: {
		resolvedLinks: { "note.md": { [pdf.path]: 5 }, "embed.md": { [pdf.path]: 1 }, "canvas.canvas": { [pdf.path]: 1 } },
		getFirstLinkpathDest: (path: string) => path === "cn.pdf" || path === pdf.path ? pdf : null,
		getFileCache: (file: TFile) => file === note ? { links, embeds: links.slice(0, 1) } : { embeds: [link("cn.pdf#page=3&rect=10,20,40,60")] },
	},
};
const index = new PdfReferenceIndex(app as never);
assert.equal(index.forPdf(pdf.path).length, 3, "links/embeds deduplicate by position; invalid and wrong targets ignored");
assert.deepEqual(index.forPdf(pdf.path).map((source) => source.sourcePath), ["embed.md", "note.md", "note.md"]);
links = [link("cn.pdf#page=2&rect=10,20,40,60", 9)];
assert.equal(index.forPdf(pdf.path).length, 3, "cache is reused until metadata invalidates");
index.invalidate();
assert.equal(index.forPdf(pdf.path).length, 2);
assert.equal(index.forPdf(pdf.path)[1].line, 9);
files.delete(note.path); index.invalidate();
assert.equal(index.forPdf(pdf.path).length, 1, "deleted/not-yet-synced source is ignored");
files.set("renamed.md", new TFile("renamed.md"));
assert.equal(index.forPdf("renamed.pdf").length, 0, "renamed targets don't reuse cached references");

// Wrapper keeps native navigation contract, propagates rejection and restores on unload.
const owner = new Component();
const view = { file: pdf };
const calls: unknown[][] = [];
const workspace = {
	async openLinkText(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); },
	getMostRecentLeaf: () => ({ view }), getLeavesOfType: () => [{ view }],
};
const original = workspace.openLinkText;
const opened: unknown[] = [];
registerPdfReferenceLinkOpen({ ...app, workspace } as never, owner as never, (v, target) => opened.push([v, target]));
const options = { active: false };
await workspace.openLinkText("cn.pdf#page=2&rect=10,20,40,60", "note.md", "tab", options);
assert.deepEqual(calls[0], [workspace, "cn.pdf#page=2&rect=10,20,40,60", "note.md", "tab", options]);
assert.equal(opened.length, 1);
await workspace.openLinkText("cn.pdf#page=2", "note.md");
assert.equal(opened.length, 1);
owner.unload(); assert.equal(workspace.openLinkText, original);
const retainedOwner = new Component();
registerPdfReferenceLinkOpen({ ...app, workspace } as never, retainedOwner as never, () => opened.push("unexpected"));
const retained = workspace.openLinkText;
workspace.openLinkText = async function (...args) { await retained.apply(this, args); };
retainedOwner.unload();
await workspace.openLinkText("cn.pdf#page=2&rect=10,20,40,60", "note.md");
assert.equal(opened.length, 1, "retained disposed closure stays inert");
const rejectedOwner = new Component();
workspace.openLinkText = async () => { throw new Error("navigation failed"); };
registerPdfReferenceLinkOpen({ ...app, workspace } as never, rejectedOwner as never, () => opened.push("unexpected"));
await assert.rejects(workspace.openLinkText("cn.pdf#page=2&rect=10,20,40,60", "note.md"), /navigation failed/);
assert.equal(opened.length, 1); rejectedOwner.unload();

// Clipboard failure never reports success and copying never writes source files or annotations.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
	const texts: string[] = [];
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { texts.push(value); } } } });
	const service = new PdfReferenceService({ ...app, fileManager: { generateMarkdownLink: (_file: TFile, _source: string, subpath: string, alias: string) => `[[${pdf.path}${subpath}|${alias}]]` } } as never, {} as never, { settings: () => ({ pdfReferenceHighlights: true }) as never, invalidate() {}, page: () => undefined, reveal: () => false });
	Notice.messages.length = 0;
	await service.copy(pdf.path, native, "中文\n$E=mc^2$", "quote");
	assert.equal(texts[0], "> 中文\n> $E=mc^2$\n> [[folder/cn.pdf#page=2&selection=0,2,1,4|p. 2]]");
	assert.deepEqual(Notice.messages, ["已复制引文及引用链接"]);
	await service.copy(pdf.path, { page: 1, rect: [0, 0, 0, 0] });
	await service.copy("missing.pdf", rectangle);
	assert.equal(texts.length, 1);
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("clipboard denied"); } } } });
	Notice.messages.length = 0;
	await service.copy(pdf.path, rectangle);
	assert.deepEqual(Notice.messages, ["clipboard denied"]);
} finally {
	if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
	else Reflect.deleteProperty(globalThis, "navigator");
}

// Lifecycle invalidates derived sources and cancels deferred flashes on unload.
{
	files.set(note.path, note);
	links = [link("cn.pdf#page=2&selection=0,2,1,4")];
	const events = new Map<string, () => void>();
	const lifecycleOwner = new Component();
	const ownerWithEvents = Object.assign(lifecycleOwner, { registerEvent() {} });
	workspace.openLinkText = original;
	const sourceOpens: unknown[] = [];
	const sourceLeaf = { view: { file: note }, openFile: async (file: TFile, options: unknown) => { sourceOpens.push([file.path, options]); } };
	const lifecycleWorkspace = { ...workspace,
		getLeavesOfType: (type: string) => type === "markdown" ? [sourceLeaf] : [{ view }],
		setActiveLeaf: (leaf: unknown, options: unknown) => sourceOpens.push([leaf, options]),
	};
	let invalidations = 0;
	let highlights = true;
	const service = new PdfReferenceService({ ...app,
		workspace: lifecycleWorkspace,
		vault: { ...app.vault, on: (name: string, fn: () => void) => { events.set(`vault:${name}`, fn); } },
		metadataCache: { ...app.metadataCache, on: (name: string, fn: () => void) => { events.set(`metadata:${name}`, fn); } },
	} as never, ownerWithEvents as never, {
		settings: () => ({ ...DEFAULT_PDF_ANNOTATION_SETTINGS, pdfReferenceHighlights: highlights }),
		invalidate: () => { invalidations++; }, page: () => undefined, reveal: () => false,
	});
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	try {
		Object.defineProperty(globalThis, "window", { configurable: true, value: {
			setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; },
			clearTimeout: (id: number) => timers.delete(id),
		} });
		service.register();
		assert.equal(service.sources(pdf.path, { ...ann, textSelection: { ...stored, pdfPath: pdf.path } }).length, 1);
		assert.equal(service.sources(pdf.path, ann).length, 0, "another shared member must not match native offsets without its geometry");
		links = [link("cn.pdf#page=2&rect=10,20,40,60", 8)];
		events.get("metadata:changed")?.();
		assert.equal(service.sources(pdf.path, ann).length, 1);
		await service.openSource(pdf.path, service.sources(pdf.path, ann)[0]);
		assert.deepEqual(sourceOpens[0], ["note.md", { eState: { line: 8 } }]);
		highlights = false;
		assert.deepEqual(service.regions(pdf.path, 2, {} as never), []);
		links = []; events.get("metadata:resolved")?.();
		assert.equal(service.sources(pdf.path, ann).length, 0);
		events.get("vault:rename")?.(); events.get("vault:delete")?.();
		assert.equal(invalidations, 4);
		await lifecycleWorkspace.openLinkText("cn.pdf#page=2&rect=10,20,40,60", "note.md");
		assert.equal(timers.size, 1);
		lifecycleOwner.unload();
		assert.equal(timers.size, 0);
		assert.equal(lifecycleWorkspace.openLinkText, original);
	} finally {
		lifecycleOwner.unload();
		if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
		else Reflect.deleteProperty(globalThis, "window");
	}
}
console.log("pdf-reference: legacy links, shared-file offsets, derived regions, index, navigation and clipboard safety passed");
