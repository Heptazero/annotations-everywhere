import assert from "node:assert/strict";
import { configuredReferenceCopy, DEFAULT_REFERENCE_PREFERENCES, normalizeReferencePreferences, referenceTemplateError, renderReferenceTemplate } from "../src/pdf/pdf-reference-preferences";
import { decorateReferenceBands, referenceSourceCounts } from "../src/pdf/pdf-reference-decoration";
import { loadPdfAnnotationSettings } from "../src/pdf/annotation-settings";
import { PdfReferenceService } from "../src/pdf/pdf-reference-service";
import { Notice, TFile } from "obsidian";

const link = "[[cn.pdf#page=3&selection=0,0,0,5|p. 3]]";
const text = "第一行\n$\\nabla f$ 与 {{link}} 是原文，不应被展开";
assert.deepEqual(normalizeReferencePreferences({}), DEFAULT_REFERENCE_PREFERENCES);
assert.equal(normalizeReferencePreferences({ pdfReferenceIndicator: false }).pdfReferenceIndicator, false);
assert.equal(normalizeReferencePreferences({ pdfReferencedStyle: "bogus", pdfReferenceCopyMode: 3 } as never).pdfReferencedStyle, "none");
assert.equal(normalizeReferencePreferences({ pdfReferencedStyle: "box", pdfReferenceCopyMode: "quote" }).pdfReferenceCopyMode, "quote");
assert.equal(configuredReferenceCopy({}, "link", link, text, "cn", 3), link);
assert.equal(configuredReferenceCopy({}, "inline", link, text, "cn", 3), `第一行 $\\nabla f$ 与 {{link}} 是原文，不应被展开 ${link}`);
assert.equal(configuredReferenceCopy({}, "quote", link, text, "cn", 3), `> 第一行\n> $\\nabla f$ 与 {{link}} 是原文，不应被展开\n> ${link}`);
assert.equal(configuredReferenceCopy({}, "quote", link, "", "cn", 3), link, "no OCR/text uses link fallback");
assert.equal(configuredReferenceCopy({ pdfReferenceQuoteTemplate: "文件 {{file}} 第 {{page}} 页\\n> {{text}}\\n> {{link}}" }, "quote", link, text, "cn", 3), `文件 cn 第 3 页\n> 第一行\n> $\\nabla f$ 与 {{link}} 是原文，不应被展开\n> ${link}`);
assert.equal(renderReferenceTemplate("{{text}}\\n{{link}}", { text: "$\\nu$ {{page}}", link }), `$\\nu$ {{page}}\n${link}`, "interpret template, never re-interpret inserted quote");
assert.equal(renderReferenceTemplate("> > {{text}}", { text: "a\r\nb" }), "> > a\n> > b");
assert.equal(renderReferenceTemplate("{{file}} · 第 {{page}} 页", { file: "论文", page: "3" }), "论文 · 第 3 页");
assert.match(referenceTemplateError("{{text}}")!, /link/);
assert.match(referenceTemplateError("{{link}} {{typo}}")!, /未知变量/);
assert.throws(() => configuredReferenceCopy({ pdfReferenceLinkTemplate: "" }, "link", link, text, "cn", 3), /必须包含/);
assert.equal(referenceTemplateError("{{link}}\n{{text}}"), null);
const stored = { pdfAnnotationSettings: { pdfReferenceIndicator: false, pdfReferencedStyle: "underline", pdfReferenceCopyMode: "inline", pdfReferenceInlineTemplate: "{{file}} - {{text}} {{link}}", railWidthLeft: 230, dataPath: "my/data" } };
const loaded = await loadPdfAnnotationSettings({ loadData: async () => JSON.parse(JSON.stringify(stored)) });
assert.equal(loaded.pdfReferenceIndicator, false);
assert.equal(loaded.pdfReferencedStyle, "underline");
assert.equal(loaded.pdfReferenceInlineTemplate, stored.pdfAnnotationSettings.pdfReferenceInlineTemplate);
assert.equal(loaded.railWidthLeft, 230);
assert.equal(loaded.dataPath, "my/data");
const reloaded = await loadPdfAnnotationSettings({ loadData: async () => ({ pdfAnnotationSettings: JSON.parse(JSON.stringify(loaded)) }) });
assert.deepEqual(JSON.parse(JSON.stringify(reloaded)), JSON.parse(JSON.stringify(loaded)), "new UI settings persist without changing existing settings");
const refs = [{ sourcePath: "a.md" }, { sourcePath: "a.md" }, { sourcePath: "b.md" }];
assert.deepEqual(referenceSourceCounts(refs as never), { notes: 2, references: 3 });
assert.deepEqual(referenceSourceCounts([]), { notes: 0, references: 0 });
const classes: string[] = [];
const bands = [{ addClass: (value: string) => classes.push(value), colorKey: "semantic-color" }];
decorateReferenceBands(bands as never, DEFAULT_REFERENCE_PREFERENCES);
assert.deepEqual(classes, [], "default doesn't override mark style");
decorateReferenceBands(bands as never, { ...DEFAULT_REFERENCE_PREFERENCES, pdfReferencedStyle: "box" });
assert.deepEqual(classes, ["is-referenced-box"]);
assert.equal(bands[0].colorKey, "semantic-color", "reference styles cannot overwrite annotation semantics");

// The toolbar uses configured format/label; explicit commands still override it.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
try {
	const output: string[] = [];
	const aliases: (string | undefined)[] = [];
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { output.push(value); } } } });
	const preferences = { ...DEFAULT_REFERENCE_PREFERENCES, pdfReferenceCopyMode: "inline" as const, pdfReferenceLinkLabel: "第 {{page}} 页", pdfReferenceInlineTemplate: "{{file}}: {{text}} {{link}}" };
	const pdf = new TFile("folder/cn.pdf");
	const service = new PdfReferenceService({ vault: { getAbstractFileByPath: () => pdf }, fileManager: {
		generateMarkdownLink: (_file: TFile, _source: string, subpath: string, alias?: string) => { aliases.push(alias); return `[[${pdf.path}${subpath}${alias ? `|${alias}` : ""}]]`; },
	} } as never, {} as never, { settings: () => preferences as never, invalidate() {}, page: () => undefined, reveal: () => false });
	const target = { page: 3, rect: [10, 20, 30, 40] as [number, number, number, number] };
	await service.copy(pdf.path, target, "a\nb");
	assert.equal(output[0], "cn: a b [[folder/cn.pdf#page=3&rect=10,20,30,40|第 3 页]]");
	await service.copy(pdf.path, target, "a\nb", "link");
	assert.equal(output[1], "[[folder/cn.pdf#page=3&rect=10,20,30,40|第 3 页]]");
	preferences.pdfReferenceLinkLabel = "";
	await service.copy(pdf.path, target, "a", "link");
	assert.equal(aliases[2], undefined);
	preferences.pdfReferenceLinkTemplate = "{{text}}";
	Notice.messages.length = 0;
	await service.copy(pdf.path, target, "a", "link");
	assert.equal(output.length, 3, "invalid template must not replace the clipboard with a non-reference");
	assert.match(Notice.messages[0], /必须包含/);
} finally {
	if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
	else Reflect.deleteProperty(globalThis, "navigator");
}
console.log("pdf-reference-preferences: template escaping, validation, multiline math, persistence and reference counts passed");
