import assert from "node:assert/strict";
import { TFile } from "obsidian";
import {
	normalizeAnnotationPropertyName,
	SourceAnnotationSync,
	sourceLinkTargets,
} from "../src/pdf/source-annotation-sync";
import { DEFAULT_PDF_ANNOTATION_SETTINGS } from "../src/pdf/annotation-settings";

assert.deepEqual(
	sourceLinkTargets(["[[paper.pdf|English]]", "[[cn_paper.pdf#page=2]]", "plain text"]),
	["paper.pdf", "cn_paper.pdf"]
);
assert.equal(normalizeAnnotationPropertyName(" source "), "has_annotations");
assert.equal(normalizeAnnotationPropertyName("annotated"), "annotated");

const english = new TFile("research/paper.pdf");
const chinese = new TFile("research/cn_paper.pdf");
const withAnnotations = new TFile("research/paper.md");
const emptied = new TFile("research/empty.md");
const alreadyCorrect = new TFile("research/correct.md");
const manualValue = new TFile("research/manual.md");
const frontmatter: Record<string, Record<string, unknown>> = {
	[withAnnotations.path]: { source: "[[paper.pdf]]", has_annotations: false, title: "Keep" },
	[emptied.path]: { source: "[[cn_paper.pdf]]", has_annotations: true },
	[alreadyCorrect.path]: { source: "[[paper.pdf]]", has_annotations: true },
	[manualValue.path]: { source: "[[paper.pdf]]", has_annotations: "manual" },
};
const counts = new Map([[english.path, 4], [chinese.path, 0]]);
const files = [english, chinese, withAnnotations, emptied, alreadyCorrect, manualValue];
const app = {
	vault: { getMarkdownFiles: () => files.filter((file) => file.extension === "md") },
	metadataCache: {
		getFileCache: (file: TFile) => ({ frontmatter: frontmatter[file.path] }),
		getFirstLinkpathDest: (target: string) => files.find((file) => file.path === target || file.path.endsWith(`/${target}`)) ?? null,
	},
	fileManager: {
		processFrontMatter: async (note: TFile, update: (value: Record<string, unknown>) => void) => {
			update(frontmatter[note.path]);
		},
	},
};
const settings = {
	...DEFAULT_PDF_ANNOTATION_SETTINGS,
	syncAnnotationProperty: true,
	annotationPropertyName: "has_annotations",
};
const sync = new SourceAnnotationSync(
	app as never,
	{ annotationCount: (path) => counts.get(path) ?? 0 },
	() => settings
);

const plan = sync.plan();
assert.deepEqual(
	plan.map((change) => [change.note.path, change.before, change.after]),
	[
		[withAnnotations.path, false, true],
		[emptied.path, true, undefined],
	]
);
assert.deepEqual(await sync.apply(plan), { updated: 2, skipped: 0 });
assert.deepEqual(frontmatter[withAnnotations.path], {
	source: "[[paper.pdf]]",
	has_annotations: true,
	title: "Keep",
});
assert.equal("has_annotations" in frontmatter[emptied.path], false);
assert.equal(frontmatter[manualValue.path].has_annotations, "manual");

frontmatter[emptied.path].has_annotations = true;
const stale = sync.plan();
counts.set(chinese.path, 2);
assert.deepEqual(await sync.apply(stale), { updated: 0, skipped: 1 });
assert.equal(frontmatter[emptied.path].has_annotations, true);

console.log("source-annotation-sync: 8 cases passed");
