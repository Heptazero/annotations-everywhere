import assert from "node:assert/strict";
import "./color-slots.test";
import "./annotation-layers.test";
import "./reading-order.test";
import "./markdown-margin.test";
import "./mark-click.test";
import "./manual-outline.test";
import "./pdf-layout.test";
import "./editor-key-scope.test";
import "./source-annotation-sync.test";
import { TFile } from "obsidian";
import { PdfAnnotationStore } from "../src/pdf/annotation-store";
import { normalizeAnnotation } from "../src/pdf/annotation-types";
import { compatibleRecoverySources } from "../src/pdf/annotation-recovery";
import { buildAnnotationStatusSummaries } from "../src/pdf/annotation-status";
import { filterAnnotations, parseAnnotationSearch } from "../src/pdf/annotation-search";
import { comparePageLayouts, largestCompatibleLayoutCluster } from "../src/pdf/layout-check";
import { adaptiveLeaderEndpoints, leaderVisible } from "../src/pdf/leader-geometry";
import {
	outlineHasDestination,
	resolvePdfOutline,
	toNativePdfOutline,
	type PdfOutlineDocument,
} from "../src/pdf/pdf-outline";
import { NativeOutlineBridge, type SharedOutlineResult } from "../src/pdf/native-outline-bridge";
import { Component, FileView } from "obsidian";
import {
	annotationListsConflict,
	connectFiles,
	counterpartOf,
	detachDeletedFile,
	groupMembers,
	joinSharedGroups,
	mergeAnnotationLists,
	relationMode,
	sharedKey,
	unpairFile,
} from "../src/pdf/pairing-state";

interface Ann {
	id: string;
	text: string;
}

function state(data: Record<string, Ann[]> = {}) {
	return {
		pdfAnnotations: data,
		pairs: {} as Record<string, string>,
		pairModes: {} as Record<string, "linked" | "shared">,
	};
}

// Binary sharing remains the ordinary case.
{
	const s = state({ "paper.pdf": [{ id: "a", text: "source" }], "cn.pdf": [{ id: "b", text: "translation" }] });
	joinSharedGroups(s, "paper.pdf", "cn.pdf", "merge");
	assert.equal(sharedKey(s, "cn.pdf"), "paper.pdf");
	assert.equal(counterpartOf(s.pairs, "paper.pdf"), "cn.pdf");
	assert.equal(relationMode(s, "paper.pdf"), "shared");
	assert.deepEqual(s.pdfAnnotations["paper.pdf"].map((a) => a.id), ["a", "b"]);
	assert.equal(s.pdfAnnotations["cn.pdf"], undefined);
}

// The global overview counts a shared group once, keeps orphaned buckets
// visible, excludes empty buckets, and computes first/latest valid timestamps.
{
	const notes = (ids: string[], createdAt: number | undefined, updatedAt: number | undefined) =>
		ids.map((id) => ({ ...annotation(id), createdAt, updatedAt }));
	const summaries = buildAnnotationStatusSummaries(
		{
			"shared-group.pdf": notes(["s1", "s2"], 20, 50),
			"private.pdf": notes(["p"], 10, 100),
			"orphan.pdf": notes(["o"], 5, 30),
			"empty.pdf": [],
		},
		{ "shared-group.pdf": "shared-group.pdf", "translation.pdf": "shared-group.pdf" },
		{ "shared-group.pdf": "shared" },
		new Set(["shared-group.pdf", "private.pdf", "translation.pdf"])
	);
	assert.deepEqual(summaries.map((summary) => summary.key), ["private.pdf", "shared-group.pdf", "orphan.pdf"]);
	assert.equal(summaries[1].count, 2);
	assert.equal(summaries[1].status, "shared");
	assert.deepEqual(summaries[1].livePaths, ["shared-group.pdf", "translation.pdf"]);
	assert.equal(summaries[2].status, "orphaned");
	assert.equal(summaries[0].firstCreatedAt, 10);
	assert.equal(summaries[0].lastUpdatedAt, 100);
	assert.equal(summaries[2].firstCreatedAt, 5);
	assert.equal(summaries[2].lastUpdatedAt, 30);
	const unknown = buildAnnotationStatusSummaries(
		{ "unknown.pdf": notes(["u"], undefined, undefined) },
		{},
		{},
		new Set(["unknown.pdf"])
	)[0];
	assert.equal(unknown.firstCreatedAt, null);
	assert.equal(unknown.lastUpdatedAt, null);
}

// Adding a third file extends, rather than replaces, the existing group.
{
	const s = state({
		"a.pdf": [{ id: "a", text: "a" }],
		"b.pdf": [{ id: "b", text: "b" }],
		"c.pdf": [{ id: "c", text: "c" }],
	});
	joinSharedGroups(s, "a.pdf", "b.pdf");
	joinSharedGroups(s, "b.pdf", "c.pdf");
	assert.deepEqual(groupMembers(s.pairs, "b.pdf"), ["a.pdf", "b.pdf", "c.pdf"]);
	assert.deepEqual(s.pdfAnnotations["a.pdf"].map((a) => a.id), ["a", "b", "c"]);
}

// Two already-shared groups can become one N-member group.
{
	const s = state({
		"a.pdf": [{ id: "a", text: "a" }],
		"b.pdf": [],
		"c.pdf": [{ id: "c", text: "c" }],
		"d.pdf": [],
	});
	joinSharedGroups(s, "a.pdf", "b.pdf");
	joinSharedGroups(s, "c.pdf", "d.pdf");
	joinSharedGroups(s, "b.pdf", "d.pdf");
	assert.deepEqual(groupMembers(s.pairs, "a.pdf"), ["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
	assert.deepEqual(s.pdfAnnotations["a.pdf"].map((a) => a.id), ["a", "c"]);
}

// No prompt is needed for an empty side or for exactly identical lists.
{
	const one = [{ id: "a", text: "same" }];
	assert.equal(annotationListsConflict(one, []), false);
	assert.equal(annotationListsConflict(one, [{ ...one[0] }]), false);
	assert.equal(annotationListsConflict(one, [{ id: "b", text: "different" }]), true);
}

// A same-id, different record is retained under a fresh id when merging.
{
	const merged = mergeAnnotationLists(
		[{ id: "same", text: "first" }],
		[{ id: "same", text: "second" }]
	);
	assert.deepEqual(merged, [
		{ id: "same", text: "first" },
		{ id: "same~2", text: "second" },
	]);
}

// Exact duplicates still dedupe.
{
	const merged = mergeAnnotationLists(
		[{ id: "same", text: "same" }],
		[{ id: "same", text: "same" }]
	);
	assert.equal(merged.length, 1);
}

// Leaving a three-member group gives the leaver a copy; two keep sharing.
{
	const s = state({ "a.pdf": [{ id: "a", text: "shared" }] });
	s.pairs = { "a.pdf": "a.pdf", "b.pdf": "a.pdf", "c.pdf": "a.pdf" };
	s.pairModes = { "a.pdf": "shared" };
	detachDeletedFile(s, "b.pdf");
	assert.deepEqual(groupMembers(s.pairs, "a.pdf"), ["a.pdf", "c.pdf"]);
	assert.deepEqual(s.pdfAnnotations["b.pdf"], [{ id: "a", text: "shared" }]);
}

// Leaving a binary group dissolves it and both sides keep a copy.
{
	const s = state({ "a.pdf": [{ id: "a", text: "shared" }] });
	s.pairs = { "a.pdf": "a.pdf", "b.pdf": "a.pdf" };
	s.pairModes = { "a.pdf": "shared" };
	detachDeletedFile(s, "a.pdf");
	assert.deepEqual(s.pairs, {});
	assert.deepEqual(s.pdfAnnotations["a.pdf"], s.pdfAnnotations["b.pdf"]);
	assert.notEqual(s.pdfAnnotations["a.pdf"], s.pdfAnnotations["b.pdf"]);
}

// If the group-key file leaves, a surviving member becomes the key.
{
	const s = state({ "a.pdf": [{ id: "a", text: "shared" }] });
	s.pairs = { "a.pdf": "a.pdf", "b.pdf": "a.pdf", "c.pdf": "a.pdf" };
	s.pairModes = { "a.pdf": "shared" };
	detachDeletedFile(s, "a.pdf");
	assert.deepEqual(groupMembers(s.pairs, "b.pdf"), ["b.pdf", "c.pdf"]);
	assert.equal(sharedKey(s, "c.pdf"), "b.pdf");
}

// Explicit conflict choices retain only the selected side.
{
	const current = state({ "a.pdf": [{ id: "a", text: "a" }], "b.pdf": [{ id: "b", text: "b" }] });
	joinSharedGroups(current, "a.pdf", "b.pdf", "current");
	assert.deepEqual(current.pdfAnnotations["a.pdf"], [{ id: "a", text: "a" }]);
	const other = state({ "a.pdf": [{ id: "a", text: "a" }], "b.pdf": [{ id: "b", text: "b" }] });
	joinSharedGroups(other, "a.pdf", "b.pdf", "other");
	assert.deepEqual(other.pdfAnnotations["a.pdf"], [{ id: "b", text: "b" }]);
}

// v5 linked relations can be dissolved without mixing independent notes.
{
	const s = state({ "a.pdf": [{ id: "a", text: "a" }], "b.pdf": [{ id: "b", text: "b" }] });
	connectFiles(s, "a.pdf", "b.pdf", "linked");
	unpairFile(s, "a.pdf");
	assert.deepEqual(s.pairs, {});
	assert.deepEqual(s.pdfAnnotations["a.pdf"], [{ id: "a", text: "a" }]);
	assert.deepEqual(s.pdfAnnotations["b.pdf"], [{ id: "b", text: "b" }]);
}

console.log("sharing-groups: 11 cases passed");

const page = (width = 612, height = 792, rotation = 0) => ({ width, height, rotation });
assert.equal(comparePageLayouts([page(), page()], [page(), page()]).compatible, true);
assert.equal(comparePageLayouts([page()], [page()]).status, "compatible");
assert.match(comparePageLayouts([page()], [page(), page()]).reason, /页数不同/);
assert.equal(comparePageLayouts([page()], [page(), page()]).status, "mismatch");
assert.match(comparePageLayouts([page()], [page(600)]).reason, /尺寸或旋转/);
assert.match(comparePageLayouts([page()], [page(612, 792, 90)]).reason, /尺寸或旋转/);
assert.equal(comparePageLayouts([page()], [page(612.5, 791.5)]).compatible, true);
assert.equal(comparePageLayouts(null, [page()]).compatible, false);
assert.equal(comparePageLayouts(null, [page()]).status, "unreadable");
assert.deepEqual(largestCompatibleLayoutCluster([[page()], [page()], [page(500)]]), [0, 1]);
assert.deepEqual(largestCompatibleLayoutCluster([[page()], [page(500)]]), [0]);
assert.deepEqual(largestCompatibleLayoutCluster([[page()], [page()], [page()]]), [0, 1, 2]);
console.log("layout-check: 12 cases passed");

const noteBox = { left: 40, top: 40, right: 60, bottom: 60 };
assert.deepEqual(adaptiveLeaderEndpoints(noteBox, { left: 80, top: 45, right: 100, bottom: 55 }), {
	start: { x: 60, y: 50 },
	end: { x: 80, y: 50 },
});
assert.deepEqual(adaptiveLeaderEndpoints(noteBox, { left: 0, top: 45, right: 20, bottom: 55 }), {
	start: { x: 40, y: 50 },
	end: { x: 20, y: 50 },
});
assert.deepEqual(adaptiveLeaderEndpoints(noteBox, { left: 45, top: 0, right: 55, bottom: 20 }), {
	start: { x: 50, y: 40 },
	end: { x: 50, y: 20 },
});
assert.deepEqual(adaptiveLeaderEndpoints(noteBox, { left: 45, top: 80, right: 55, bottom: 100 }), {
	start: { x: 50, y: 60 },
	end: { x: 50, y: 80 },
});
assert.deepEqual(adaptiveLeaderEndpoints(noteBox, { left: 80, top: 80, right: 100, bottom: 100 }), {
	start: { x: 60, y: 60 },
	end: { x: 80, y: 80 },
});
assert.deepEqual(
	adaptiveLeaderEndpoints(noteBox, { left: 45, top: 80, right: 55, bottom: 100 }, { x: 0.5, y: 1 }),
	{
		start: { x: 50, y: 60 },
		end: { x: 50, y: 100 },
	}
);
console.log("leader-geometry: 6 cases passed");
assert.equal(leaderVisible(true, true, true), false);
assert.equal(leaderVisible(true, undefined, true), false);
assert.equal(leaderVisible(false, undefined, true), true);
assert.equal(leaderVisible(false, false, true), false);
console.log("collapsed-leader: 4 cases passed");

function annotation(id: string) {
	return { id, page: 1, anchor: [0, 0, 1, 1], text: id, createdAt: 1, updatedAt: 1 };
}

function storeHarness(payload: unknown, files: TFile[]) {
	const disk = new Map<string, string>([["annotations.json", JSON.stringify(payload)]]);
	const byPath = new Map(files.map((file) => [file.path, file]));
	const adapter = {
		exists: async (path: string) => disk.has(path),
		read: async (path: string) => disk.get(path) ?? "",
		write: async (path: string, value: string) => void disk.set(path, value),
		mkdir: async () => undefined,
		remove: async (path: string) => void disk.delete(path),
	};
	const app = { vault: { adapter, getAbstractFileByPath: (path: string) => byPath.get(path) ?? null } };
	const plugin = { loadData: async () => null };
	return { store: new PdfAnnotationStore(app as never, plugin as never), disk };
}

// Manual headings survive reload, sharing, unpairing and path changes without
// modifying the annotation bucket or silently disappearing from translations.
{
	const a = new TFile("paper.pdf");
	const b = new TFile("cn_paper.pdf");
	const c = new TFile("alternate.pdf");
	const h = storeHarness({ version: 9, pdfAnnotations: {}, pairs: {}, pairModes: {}, pairRevisions: {} }, [a, b, c]);
	await h.store.load("annotations.json");
	h.store.upsertManualOutline(a.path, { id: "m1", title: "方法", level: 1, page: 3 });
	h.store.joinShared(a.path, b.path);
	assert.deepEqual(h.store.manualOutlineForFile(b.path).map((item) => item.title), ["方法"]);
	h.store.upsertManualOutline(b.path, { id: "m2", title: "实验", level: 1, page: 5 });
	assert.equal(h.store.manualOutlineForFile(a.path).length, 2);
	h.store.joinShared(b.path, c.path);
	assert.equal(h.store.manualOutlineForFile(c.path).length, 2);
	h.store.leaveGroup(b.path);
	assert.equal(h.store.manualOutlineForFile(b.path).length, 2);
	h.store.removeManualOutline(b.path, "m2");
	assert.equal(h.store.manualOutlineForFile(a.path).length, 2);
	assert.equal(h.store.manualOutlineForFile(c.path).length, 2);
	assert.equal(h.store.manualOutlineForFile(b.path).length, 1);
	h.store.renameFile(b.path, "moved/cn_paper.pdf");
	assert.equal(h.store.manualOutlineForFile("moved/cn_paper.pdf").length, 1);
	assert.equal(h.store.manualOutlineForFile(b.path).length, 0);
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	const persisted = JSON.parse(h.disk.get("annotations.json") ?? "{}");
	assert.equal(persisted.version, 10);
	assert.equal(persisted.manualOutlines["moved/cn_paper.pdf"][0].title, "方法");
	assert.deepEqual(persisted.pdfAnnotations, {});
}

// Recovery only offers vanished private buckets whose page numbers fit the
// current PDF, and filename resemblance ranks rather than hides candidates.
{
	const target = "research/1985-paper/1985-Storing-Infinite-Numbers.pdf";
	const sources = [
		{ path: "old/cn_1985-Storing-Infinite-Numbers.pdf", count: 35, maxPage: 4 },
		{ path: "old/unrelated.pdf", count: 2, maxPage: 3 },
		{ path: "old/too-long.pdf", count: 1, maxPage: 5 },
	];
	const compatible = compatibleRecoverySources(target, 4, sources);
	assert.deepEqual(compatible.map((source) => source.path), [sources[0].path, sources[1].path]);
}

// Explicit recovery moves the old bucket, preserves existing target notes and
// leaves exact duplicates collapsed.
{
	const live = new TFile("new/paper.pdf", 10, 100);
	const h = storeHarness(
		{
			version: 9,
			pdfAnnotations: {
				"old/paper.pdf": [annotation("old"), annotation("same")],
				"new/paper.pdf": [annotation("current"), annotation("same")],
				"live/other.pdf": [annotation("mounted")],
			},
			pairs: {},
			pairModes: {},
			pairRevisions: {},
		},
		[live, new TFile("live/other.pdf")]
	);
	await h.store.load("annotations.json");
	const orphaned = h.store.orphanedAnnotationSources(new Set([live.path, "live/other.pdf"]));
	assert.deepEqual(orphaned.map((source) => source.path), ["old/paper.pdf"]);
	assert.equal(orphaned[0].maxPage, 1);
	const recovered = h.store.recoverOrphanedAnnotations("old/paper.pdf", live.path);
	assert.deepEqual(recovered, { sourceCount: 2, previousTargetCount: 2, resultCount: 3 });
	assert.deepEqual(h.store.forFile(live.path).map((item) => item.id), ["current", "same", "old"]);
	assert.equal(h.store.annotationCount("old/paper.pdf"), 0);
}

// Pre-v5 unverified shared data becomes independent copies in v6.
{
	const a = new TFile("a.pdf", 10, 100);
	const b = new TFile("b.pdf", 20, 200);
	const h = storeHarness(
		{
			version: 4,
			pdfAnnotations: { "a.pdf": [annotation("legacy")] },
			pairs: { "a.pdf": "a.pdf", "b.pdf": "a.pdf" },
			fingerprints: { "a.pdf": { pages: 1 } },
		},
		[a, b]
	);
	await h.store.load("annotations.json");
	assert.equal(h.store.legacyGroupsDowngraded, 1);
	assert.equal(h.store.isPaired("a.pdf"), false);
	assert.equal(h.store.annotationCount("a.pdf"), 1);
	assert.equal(h.store.annotationCount("b.pdf"), 1);
	const written = JSON.parse(h.disk.get("annotations.json") ?? "{}");
	assert.equal(written.version, 10);
	assert.equal(written.fingerprints, undefined);
}

// Deleting a layer removes only that membership; the shared annotation survives.
{
	const a = new TFile("a.pdf", 10, 100);
	const h = storeHarness(
		{
			version: 9,
			pdfAnnotations: {
				"a.pdf": [{ ...annotation("layered"), layerIds: ["os", "argument"] }],
			},
			pairs: {},
			pairModes: {},
			pairRevisions: {},
		},
		[a]
	);
	await h.store.load("annotations.json");
	assert.equal(h.store.detachLayerId("os"), 1);
	assert.equal(h.store.annotationCount("a.pdf"), 1);
	assert.deepEqual(h.store.forFile("a.pdf")[0].layerIds, ["argument"]);
}

// Moving a whole paper folder preserves every member and the canonical bucket.
{
	const source = new TFile("old/paper/source.pdf", 10, 100);
	const translation = new TFile("old/paper/cn_source.pdf", 20, 200);
	const movedSource = new TFile("research/paper/source.pdf", 10, 100);
	const movedTranslation = new TFile("research/paper/cn_source.pdf", 20, 200);
	const h = storeHarness(
		{
			version: 9,
			pdfAnnotations: { "old/paper/source.pdf": [annotation("shared")] },
			pairs: {
				"old/paper/source.pdf": "old/paper/source.pdf",
				"old/paper/cn_source.pdf": "old/paper/source.pdf",
			},
			pairModes: { "old/paper/source.pdf": "shared" },
			pairRevisions: {},
		},
		[source, translation, movedSource, movedTranslation]
	);
	await h.store.load("annotations.json");
	assert.ok(h.store.renameFolder("old/paper", "research/paper") > 0);
	assert.deepEqual(h.store.sharedMembers("research/paper/source.pdf"), [
		"research/paper/source.pdf",
		"research/paper/cn_source.pdf",
	]);
	assert.equal(h.store.annotationCount("research/paper/cn_source.pdf"), 1);
	assert.equal(h.store.isPaired("old/paper/source.pdf"), false);
}

// v5 linked data is dissolved without combining its two independent lists.
{
	const a = new TFile("a.pdf", 10, 100);
	const b = new TFile("b.pdf", 20, 200);
	const h = storeHarness(
		{
			version: 5,
			pdfAnnotations: { "a.pdf": [annotation("a")], "b.pdf": [annotation("b")] },
			pairs: { "a.pdf": "a.pdf", "b.pdf": "a.pdf" },
			pairModes: { "a.pdf": "linked" },
			pairRevisions: {},
		},
		[a, b]
	);
	await h.store.load("annotations.json");
	assert.equal(h.store.isPaired("a.pdf"), false);
	assert.equal(h.store.annotationCount("a.pdf"), 1);
	assert.equal(h.store.annotationCount("b.pdf"), 1);
}

// A changed binary revision requests layout revalidation but does not detach.
{
	const a = new TFile("a.pdf", 10, 100);
	const b = new TFile("b.pdf", 20, 200);
	const h = storeHarness(
		{
			version: 5,
			pdfAnnotations: { "a.pdf": [annotation("shared")] },
			pairs: { "a.pdf": "a.pdf", "b.pdf": "a.pdf" },
			pairModes: { "a.pdf": "shared" },
			pairRevisions: {
				"a.pdf": { "a.pdf": { mtime: 10, size: 100 }, "b.pdf": { mtime: 20, size: 200 } },
			},
		},
		[a, b]
	);
	await h.store.load("annotations.json");
	assert.deepEqual(h.store.changedSharedMembers(), []);
	b.stat.mtime = 21;
	assert.deepEqual(h.store.changedSharedMembers(), ["b.pdf"]);
	assert.equal(h.store.isPaired("a.pdf"), true);
	assert.equal(h.store.acceptCurrentRevision("b.pdf"), true);
	assert.deepEqual(h.store.changedSharedMembers(), []);
}

// Revalidation markers are updated per member without disturbing a 3-way group.
{
	const a = new TFile("a.pdf", 10, 100);
	const b = new TFile("b.pdf", 20, 200);
	const c = new TFile("c.pdf", 30, 300);
	const h = storeHarness(
		{
			version: 6,
			pdfAnnotations: { "a.pdf": [annotation("shared")] },
			pairs: { "a.pdf": "a.pdf", "b.pdf": "a.pdf", "c.pdf": "a.pdf" },
			pairModes: { "a.pdf": "shared" },
			pairRevisions: {
				"a.pdf": {
					"a.pdf": { mtime: 10, size: 100 },
					"b.pdf": { mtime: 20, size: 200 },
					"c.pdf": { mtime: 30, size: 300 },
				},
			},
		},
		[a, b, c]
	);
	await h.store.load("annotations.json");
	b.stat.size = 201;
	assert.deepEqual(h.store.changedSharedMembers(), ["b.pdf"]);
	assert.equal(h.store.acceptCurrentRevision("b.pdf"), true);
	assert.deepEqual(h.store.sharedMembers("a.pdf"), ["a.pdf", "b.pdf", "c.pdf"]);
}

console.log("annotation-store migration/revision/layers: 5 cases passed");

const searchable = [
	{ ...annotation("实验结果:在 $2^{30}$ 中 25 很小"), page: 2 },
	{ ...annotation("Asymmetric robustness\nremains"), page: 3 },
	{ ...annotation("mark"), text: "", quote: "E = mc squared", markOnly: true, page: 4 },
];
assert.deepEqual(filterAnnotations(searchable as never, "2^{30}"), [searchable[0]]);
assert.deepEqual(filterAnnotations(searchable as never, "asymmetric ROBUSTNESS"), [searchable[1]]);
assert.deepEqual(filterAnnotations(searchable as never, "page:3 remains"), [searchable[1]]);
assert.deepEqual(filterAnnotations(searchable as never, "第 2 页 实验结果"), [searchable[0]]);
assert.deepEqual(filterAnnotations(searchable as never, "page:2 remains"), []);
assert.deepEqual(filterAnnotations(searchable as never, "page:4 squared"), [searchable[2]]);
assert.deepEqual(parseAnnotationSearch("第3页 latex"), { pages: [3], terms: ["latex"] });
assert.equal(normalizeAnnotation({ markOnly: true }).markOnly, true);
assert.equal(normalizeAnnotation({ markOnly: false }).markOnly, undefined);
const commentedMark = normalizeAnnotation({ markOnly: true, quote: "source", text: "later note", colorKey: "slot-one" });
assert.equal(commentedMark.markOnly, true);
assert.deepEqual(filterAnnotations([commentedMark], "later note"), [commentedMark]);
assert.equal(commentedMark.colorKey, "slot-one");
console.log("annotation-search/mark-only: 12 cases passed");

const outlineDoc: PdfOutlineDocument = {
	getOutline: async () => null,
	getDestination: async (name) => (name === "named" ? [1, { name: "XYZ" }, 0, 600, null] : null),
	getPageIndex: async (ref) => (ref as { index: number }).index,
	getPage: async () => ({ view: [0, 0, 612, 792] }),
	destroy: () => undefined,
};
const outline = await resolvePdfOutline(outlineDoc, [
	{
		title: "  第一章   Introduction ",
		dest: [{ index: 0 }, { name: "FitH" }, 700],
		items: [{ title: "没有目的地的父项", items: [{ title: "子节", dest: [2, { name: "Fit" }] }] }],
	},
	{ title: "Named destination", dest: "named" },
	{ title: "   ", items: [{ title: "提升一层", dest: [3, { name: "Fit" }] }] },
]);
assert.equal(outline[0].title, "第一章 Introduction");
assert.equal(outline[0].page, 1);
assert.ok(Math.abs((outline[0].topRatio ?? 0) - 92 / 792) < 1e-9);
assert.equal(outline[0].items[0].page, null);
assert.equal(outline[0].items[0].items[0].page, 3);
assert.equal(outline[1].page, 2);
assert.equal(outline[1].topRatio, 192 / 792);
assert.equal(outline[2].title, "提升一层");
assert.equal(outline[2].page, 4);
assert.equal(outlineHasDestination(outline), true);
assert.equal(outlineHasDestination([{ title: "外部标题", page: null, topRatio: null, items: [] }]), false);

const nativeOutline = await toNativePdfOutline(outline, {
	numPages: 4,
	getPage: async () => ({ view: [0, 0, 612, 792] }),
});
assert.equal(nativeOutline[0].dest?.[0], 0);
assert.equal((nativeOutline[0].dest?.[1] as { name: string }).name, "XYZ");
assert.ok(Math.abs((nativeOutline[0].dest?.[3] as number) - 700) < 1e-9);
assert.equal(nativeOutline[0].items[0].dest, null);
assert.deepEqual(nativeOutline[0].items[0].items[0].dest, [2, { name: "FitH" }, null]);
assert.equal(nativeOutline[2].dest?.[0], 3);
assert.equal(nativeOutline[0].color instanceof Uint8ClampedArray, true);
console.log("pdf-outline: 17 cases passed");

const flushOutlineBridge = async () => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
const outlineEvents = new Map<string, (event: unknown) => void>();
const renderedOutlines: Array<unknown[] | null> = [];
const targetDocument = {
	numPages: 4,
	getOutline: async () => null,
	getPage: async () => ({ view: [0, 0, 612, 792] as [number, number, number, number] }),
};
const nativeViewer = {
	pdfViewer: { pdfDocument: targetDocument },
	eventBus: {
		on: (name: string, callback: (event: unknown) => void) => outlineEvents.set(name, callback),
		off: (name: string) => outlineEvents.delete(name),
	},
	pdfOutlineViewer: {
		renderTree: ({ outline: value }: { outline: unknown[] | null }) => renderedOutlines.push(value),
	},
};
const bridgeView = new FileView();
bridgeView.file = new TFile("cn_paper.pdf");
bridgeView.viewer = { child: { pdfViewer: nativeViewer }, then: () => undefined };
const bridgeOwner = new Component();
let sharedResult: SharedOutlineResult = { sourcePath: "paper.pdf", items: outline };
const bridge = new NativeOutlineBridge(
	bridgeView as never,
	bridgeOwner as never,
	() => bridgeView.file?.path ?? null,
	async () => sharedResult
);
await flushOutlineBridge();
assert.equal(renderedOutlines.length, 1);
assert.equal((renderedOutlines[0]?.[0] as { title: string }).title, "第一章 Introduction");
sharedResult = { sourcePath: null, items: [] };
bridge.refresh();
await flushOutlineBridge();
assert.equal(renderedOutlines.at(-1), null);

const ownOutlineRenders: Array<unknown[] | null> = [];
const ownOutlineView = new FileView();
ownOutlineView.file = new TFile("already-outlined.pdf");
ownOutlineView.viewer = {
	child: {
		pdfViewer: {
			pdfViewer: { pdfDocument: { ...targetDocument, getOutline: async () => [{ title: "自己的目录" }] } },
			eventBus: { on: () => undefined, off: () => undefined },
			pdfOutlineViewer: {
				renderTree: ({ outline: value }: { outline: unknown[] | null }) => ownOutlineRenders.push(value),
			},
		},
	},
	then: () => undefined,
};
new NativeOutlineBridge(
	ownOutlineView as never,
	new Component() as never,
	() => ownOutlineView.file?.path ?? null,
	async () => ({ sourcePath: "paper.pdf", items: outline })
);
await flushOutlineBridge();
assert.equal(ownOutlineRenders.length, 0);
let manualAvailable = true;
const manualBridge = new NativeOutlineBridge(
	ownOutlineView as never,
	new Component() as never,
	() => ownOutlineView.file?.path ?? null,
	async () => ({ sourcePath: "already-outlined.pdf", hasManual: true, items: [
		{ title: "自己的目录", page: 1, topRatio: null, items: [] },
		{ title: "手动标题", page: 2, topRatio: null, items: [], manualId: "m1" },
	] }),
	() => manualAvailable
);
await flushOutlineBridge();
assert.equal((ownOutlineRenders.at(-1)?.[1] as { title: string }).title, "手动标题");
manualAvailable = false;
manualBridge.refresh();
await flushOutlineBridge();
assert.equal((ownOutlineRenders.at(-1)?.[0] as { title: string }).title, "自己的目录");
console.log("native-outline-bridge: 4 cases passed");
