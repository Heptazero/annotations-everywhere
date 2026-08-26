import assert from "node:assert/strict";
import { PdfAnnotationStore } from "../src/pdf/annotation-store";
import {
	annotationColorOrder,
	LEGACY_COLOR_KEY_MAP,
	loadPdfAnnotationSettings,
	resolveAnnotationColor,
} from "../src/pdf/annotation-settings";

const settings = await loadPdfAnnotationSettings({
	loadData: async () => ({
		pdfAnnotationSettings: {
			palette: ["#eed37c", "#010203", "#8fbf8f", "#d98f8f", "#b998d4", "#7fbfc4", "#c9a37a", "#9aa0a6"],
		},
	}),
});
assert.equal(settings.palette[0].id, LEGACY_COLOR_KEY_MAP.general);
assert.equal(settings.palette[1].id, LEGACY_COLOR_KEY_MAP.concept);
assert.equal(settings.palette[1].name, "定义与建模");
assert.equal(settings.dotSize, 12);
assert.deepEqual(settings.layers.map((layer) => layer.name), ["内心 OS", "论证骨架", "知识查阅"]);

const dotSizeSettings = await loadPdfAnnotationSettings({
	loadData: async () => ({ pdfAnnotationSettings: { dotSize: 99 } }),
});
assert.equal(dotSizeSettings.dotSize, 18);

const objectSettings = await loadPdfAnnotationSettings({
	loadData: async () => ({
		pdfAnnotationSettings: {
			palette: [{ id: "concept", name: "已改名", color: "#123456" }],
		},
	}),
});
assert.deepEqual(objectSettings.palette[0], {
	id: LEGACY_COLOR_KEY_MAP.concept,
	name: "已改名",
	color: "#123456",
});

const ann = { pinned: true, colorKey: LEGACY_COLOR_KEY_MAP.concept };
assert.equal(resolveAnnotationColor(ann, settings), "#010203");
assert.equal(annotationColorOrder(ann, settings), 1);
assert.equal(annotationColorOrder({ pinned: true }, settings), settings.palette.length);
assert.equal(annotationColorOrder({ pinned: false }, settings), settings.palette.length + 1);
const reversedSettings = { ...settings, palette: [...settings.palette].reverse() };
assert.equal(annotationColorOrder(ann, reversedSettings), reversedSettings.palette.length - 2);

const disk = new Map<string, string>([
	[
		"annotations.json",
		JSON.stringify({
			version: 6,
			pdfAnnotations: {
				"a.pdf": [
					{
						id: "old-palette",
						page: 1,
						anchor: [0, 0, 1, 1],
						pinned: true,
						collapsed: false,
						side: "right",
						color: "#7d94ca",
						text: "old",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "custom",
						page: 1,
						anchor: [0, 0, 1, 1],
						pinned: true,
						collapsed: false,
						side: "right",
						color: "#abcdef",
						text: "custom",
						createdAt: 1,
						updatedAt: 1,
					},
					{
						id: "semantic-key",
						page: 1,
						anchor: [0, 0, 1, 1],
						pinned: true,
						collapsed: false,
						side: "right",
						colorKey: "evidence",
						text: "semantic",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			pairs: {},
			pairModes: {},
			pairRevisions: {},
		}),
	],
]);
const adapter = {
	exists: async (path: string) => disk.has(path),
	read: async (path: string) => disk.get(path) ?? "",
	write: async (path: string, value: string) => void disk.set(path, value),
	mkdir: async () => undefined,
	remove: async (path: string) => void disk.delete(path),
};
const store = new PdfAnnotationStore(
	{ vault: { adapter, getAbstractFileByPath: () => null } } as never,
	{ loadData: async () => null } as never
);
await store.load("annotations.json");
assert.deepEqual(store.migrateColorKeys(settings.palette), { annotations: 3, addedSlots: 1 });
let migrated = store.forFile("a.pdf");
assert.equal(migrated[0].colorKey, LEGACY_COLOR_KEY_MAP.concept);
assert.equal((migrated[0] as typeof migrated[0] & { color?: string }).color, undefined);
assert.match(migrated[1].colorKey ?? "", /^clr-[\da-f]{16}$/);
assert.equal(migrated[1].colorKey?.includes("abcdef"), false);
assert.equal((migrated[1] as typeof migrated[1] & { color?: string }).color, undefined);
assert.equal(migrated[2].colorKey, LEGACY_COLOR_KEY_MAP.evidence);
assert.deepEqual(settings.palette.at(-1), {
	id: migrated[1].colorKey,
	name: "旧颜色 #abcdef",
	color: "#abcdef",
});

assert.equal(store.detachColorKey(LEGACY_COLOR_KEY_MAP.concept), 1);
migrated = store.forFile("a.pdf");
assert.equal(migrated[0].colorKey, undefined);
assert.equal((migrated[0] as typeof migrated[0] & { color?: string }).color, undefined);

const persisted = JSON.parse(disk.get("annotations.json") ?? "{}") as {
	version?: number;
	pdfAnnotations?: Record<string, Array<Record<string, unknown>>>;
};
assert.equal(persisted.version, 9);
assert.equal(persisted.pdfAnnotations?.["a.pdf"].some((item) => "color" in item), false);

console.log("color-slots: 6 cases passed");
