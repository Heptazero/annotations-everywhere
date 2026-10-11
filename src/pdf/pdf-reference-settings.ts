import { Setting } from "obsidian";
import type { PdfAnnotationSettings } from "./annotation-settings";
import { configuredReferenceCopy, DEFAULT_REFERENCE_PREFERENCES, renderReferenceTemplate, type PdfReferenceCopyMode, type ReferencedRegionStyle } from "./pdf-reference-preferences";
import { renderSettingChoice } from "./settings-layout";

export function renderReferenceSettings(appearance: HTMLElement, templates: HTMLElement, settings: PdfAnnotationSettings, commit: () => void): void {
	let previewMode = settings.pdfReferenceCopyMode;
	new Setting(appearance).setName("显示 PDF 引用勾画").setDesc("从笔记里的链接显示引用位置。与其他插件同时使用时，只开启一边的引用显示。")
		.addToggle((toggle) => toggle.setValue(settings.pdfReferenceHighlights).onChange((value) => { settings.pdfReferenceHighlights = value; commit(); }));
	new Setting(appearance).setName("显示引用图标").setDesc("引用位置旁显示小图标，点击查看来源；复制后尚未粘贴不算引用。")
		.addToggle((toggle) => toggle.setValue(settings.pdfReferenceIndicator).onChange((value) => { settings.pdfReferenceIndicator = value; commit(); }));
	const style = new Setting(appearance).setName("被引用的样式").setDesc("保留批注的语义颜色，只区分形状。默认不改变原样式。");
	renderSettingChoice<ReferencedRegionStyle>(style.controlEl, "被引用的样式", [{ value: "none", label: "不改变" }, { value: "underline", label: "下划线" }, { value: "box", label: "边框" }], settings.pdfReferencedStyle, (value) => { settings.pdfReferencedStyle = value; commit(); });
	const copy = new Setting(templates).setName("工具栏复制格式").setDesc("链接图标使用此格式；菜单和命令仍可单独选择。");
	renderSettingChoice<PdfReferenceCopyMode>(copy.controlEl, "工具栏复制格式", [{ value: "link", label: "仅链接" }, { value: "inline", label: "单行引文" }, { value: "quote", label: "引用块" }], settings.pdfReferenceCopyMode, (value) => { settings.pdfReferenceCopyMode = value; commit(); preview(value); });
	new Setting(templates).setName("链接显示文字").setDesc("支持 {{file}}、{{page}}；留空显示文件名。")
		.addText((input) => input.setValue(settings.pdfReferenceLinkLabel).onChange((value) => { settings.pdfReferenceLinkLabel = value; commit(); preview(); }));
	const sample = templates.createDiv("margin-notes-settings-reference-preview");
	sample.createDiv({ cls: "setting-item-description", text: "复制结果预览" });
	const result = sample.createEl("pre");
	function preview(mode = previewMode): void {
		previewMode = mode;
		try {
			const label = renderReferenceTemplate(settings.pdfReferenceLinkLabel, { page: "3", file: "论文" });
			const link = `[[论文.pdf#page=3&selection=0,0,0,8${label ? `|${label}` : ""}]]`;
			result.setText(configuredReferenceCopy(settings, mode, link, "第一行引文\n包含 $E=mc^2$ 的第二行", "论文", 3));
			result.removeClass("is-error");
		} catch (error) { result.setText(error instanceof Error ? error.message : "模板无效"); result.addClass("is-error"); }
	}
	for (const [name, key] of [["仅链接模板", "pdfReferenceLinkTemplate"], ["单行引文模板", "pdfReferenceInlineTemplate"], ["引用块模板", "pdfReferenceQuoteTemplate"]] as const) {
		const mode: PdfReferenceCopyMode = key === "pdfReferenceLinkTemplate" ? "link" : key === "pdfReferenceInlineTemplate" ? "inline" : "quote";
		let reset: () => void = () => {};
		new Setting(templates).setName(name).setDesc("{{text}} 引文 · {{link}} 链接 · {{file}} 文件名 · {{page}} 页码；支持换行及 \\n。必须保留 {{link}}。")
			.setClass("margin-notes-settings-template")
			.addTextArea((input) => {
				input.setValue(settings[key]).onChange((value) => { settings[key] = value; commit(); preview(mode); });
				input.inputEl.rows = 3;
				input.inputEl.setAttribute("aria-label", name);
				reset = () => { settings[key] = DEFAULT_REFERENCE_PREFERENCES[key]; input.setValue(settings[key]); commit(); preview(mode); };
			}).addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip("恢复此模板默认值").onClick(() => reset()));
	}
	preview();
}
