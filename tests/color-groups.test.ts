import assert from "node:assert/strict";
import { activeColorGroup, activeColorSlots, archiveColorGroup, colorSlotLabel, normalizeColorGroups, visibleColorGroups } from "../src/pdf/color-groups";
import { annotationColorOrder, loadPdfAnnotationSettings, resolveAnnotationColor } from "../src/pdf/annotation-settings";

const legacy = await loadPdfAnnotationSettings({ loadData: async () => ({ pdfAnnotationSettings: {
	palette: [{ id: "old-id", name: "旧语义", color: "#aabbcc" }],
} }) });
assert.equal(activeColorGroup(legacy).name, "默认");
assert.deepEqual(activeColorSlots(legacy), legacy.palette);
assert.equal(legacy.palette[0].id, "old-id");
assert.equal(colorSlotLabel(legacy, "old-id"), "旧语义");

const raw = { pdfAnnotationSettings: {
	palette: [{ id: "paper-red", name: "疑问", color: "#ff0000" }, { id: "course-red", name: "考点", color: "#ff0000" }],
	colorGroups: [{ id: "paper", name: "论文", colorKeys: ["paper-red"] }, { id: "course", name: "课程", colorKeys: ["course-red"] }],
	activeColorGroupId: "paper",
} };
const settings = await loadPdfAnnotationSettings({ loadData: async () => raw });
const note = { colorKey: "paper-red", pinned: true };
const before = JSON.stringify(note);
assert.equal(colorSlotLabel(settings, note.colorKey), "论文 · 疑问");
settings.activeColorGroupId = "course";
assert.deepEqual(activeColorSlots(settings).map((slot) => slot.id), ["course-red"]);
assert.equal(resolveAnnotationColor(note, settings), "#ff0000");
assert.equal(annotationColorOrder(note, settings), 0);
assert.equal(colorSlotLabel(settings, note.colorKey), "论文 · 疑问");
settings.palette[1].color = "#00ff00";
settings.palette[1].name = "必考";
assert.equal(resolveAnnotationColor(note, settings), "#ff0000");
assert.equal(colorSlotLabel(settings, "course-red"), "课程 · 必考");

// Removing a selected group falls back without detaching or recoloring anything.
assert.equal(archiveColorGroup(settings, "course"), true);
assert.equal(activeColorGroup(settings).id, "paper");
assert.equal(visibleColorGroups(settings).length, 1);
assert.equal(colorSlotLabel(settings, "course-red"), "课程 · 必考");
assert.equal(resolveAnnotationColor({ pinned: true, colorKey: "course-red" }, settings), "#00ff00");
assert.equal(archiveColorGroup(settings, "paper"), false);
assert.equal(archiveColorGroup(settings, "missing"), false);
assert.equal(JSON.stringify(note), before);

const reloaded = await loadPdfAnnotationSettings({ loadData: async () => JSON.parse(JSON.stringify({ pdfAnnotationSettings: settings })) as unknown });
assert.deepEqual(reloaded.colorGroups, settings.colorGroups);
assert.equal(reloaded.activeColorGroupId, "paper");
assert.equal(colorSlotLabel(reloaded, "course-red"), "课程 · 必考");
const corrupted = normalizeColorGroups([
	{ id: "x", name: " A ", colorKeys: ["paper-red", "missing", "paper-red"] },
	{ id: "x", name: "duplicate", colorKeys: [] },
	{ id: "y", name: "B", colorKeys: ["paper-red", "course-red"] },
	{ id: "z", name: 33, colorKeys: [] },
], settings.palette);
assert.deepEqual(corrupted.map((group) => group.colorKeys), [["paper-red"], ["course-red"]]);
assert.ok(normalizeColorGroups([{ id: "x", name: "Archived", colorKeys: [], archived: true }], settings.palette).some((group) => !group.archived));
assert.equal(activeColorSlots(await loadPdfAnnotationSettings({ loadData: async () => ({ pdfAnnotationSettings: {
	...raw.pdfAnnotationSettings, activeColorGroupId: "bad",
} }) })).length, 1);
console.log("color-groups: migration, context isolation, archive and round-trip passed");
