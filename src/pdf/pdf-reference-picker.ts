import { Scope, prepareFuzzySearch, type App } from "obsidian";
import { TEXT_EDITOR_NAVIGATION_KEYS } from "./editor-key-scope";
import type { PdfReferenceSource } from "./pdf-reference-index";
import { referenceSourceCounts } from "./pdf-reference-decoration";
import { referencePickerNextIndex, referencePickerPlacement } from "./reference-picker-layout";

/** Anchored, searchable source list; callers own cleanup when the plugin unloads. */
export function openPdfReferencePicker(app: App, refs: PdfReferenceSource[], at: { x: number; y: number }, onChoose: (ref: PdfReferenceSource) => void, onClose: () => void): () => void {
	const previousFocus = document.activeElement;
	const el = document.body.createDiv({ cls: "margin-notes-pdf-reference-picker", attr: { role: "dialog", "aria-label": "引用此处的笔记" } });
	const counts = referenceSourceCounts(refs);
	el.createDiv({ cls: "margin-notes-pdf-reference-summary", text: `${counts.notes} 篇笔记 · ${counts.references} 处引用` });
	const search = el.createEl("input", { attr: { type: "search", placeholder: "搜索引用笔记…", "aria-label": "搜索引用笔记" } });
	const results = el.createDiv("margin-notes-pdf-reference-results");
	let closed = false;
	const handledKeys = new WeakSet<KeyboardEvent>();
	const viewport = window.visualViewport;
	const scope = new Scope(app.scope);
	for (const key of [...TEXT_EDITOR_NAVIGATION_KEYS, "Escape", "Enter"]) scope.register(null, key, (event) => {
		keyboard(event); return true;
	});
	app.keymap.pushScope(scope);
	const render = () => {
		results.empty();
		const query = search.value.trim().normalize("NFC").toLocaleLowerCase();
		const match = prepareFuzzySearch(query);
		for (const ref of refs) {
			const label = `${ref.sourcePath.replace(/\.md$/i, "")} · 第 ${ref.line + 1} 行`;
			if (query && !match(label.normalize("NFC"))) continue;
			const button = results.createEl("button", { text: label, attr: { type: "button", title: ref.sourcePath } });
			button.addEventListener("click", () => { close(); onChoose(ref); });
		}
		if (!results.childElementCount) results.createDiv({ text: "没有匹配的引用", cls: "setting-item-description" });
	};
	function position(): void {
		if (closed) return;
		const visible = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
			width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight };
		const constraints = referencePickerPlacement(at, { width: 0, height: 0 }, visible);
		el.setCssStyles({ maxWidth: `${constraints.maxWidth}px`, maxHeight: `${constraints.maxHeight}px` });
		const placement = referencePickerPlacement(at, el.getBoundingClientRect(), visible);
		el.setCssStyles({ left: `${placement.left}px`, top: `${placement.top}px` });
	}
	function close(): void {
		if (closed) return;
		closed = true;
		app.keymap.popScope(scope);
		document.removeEventListener("pointerdown", outside, true);
		document.removeEventListener("keydown", keyboard, true);
		window.removeEventListener("resize", position);
		viewport?.removeEventListener("resize", position);
		viewport?.removeEventListener("scroll", position);
		el.remove(); onClose();
	}
	function outside(event: PointerEvent): void { if (!el.contains(event.target as Node)) close(); }
	function keyboard(event: KeyboardEvent): void {
		if (closed || event.isComposing || !el.contains(event.target as Node) || handledKeys.has(event)) return;
		handledKeys.add(event);
		if (event.key === "Escape") {
			event.preventDefault(); event.stopPropagation(); close();
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
			return;
		}
		event.stopPropagation();
		const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("button"));
		const index = buttons.findIndex((button) => button === event.target);
		const next = referencePickerNextIndex(event.key, index, buttons.length);
		if (next !== null) {
			event.preventDefault(); buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: "nearest" });
		}
		if (event.key === "Enter" && event.target === search) { event.preventDefault(); buttons[0]?.click(); }
	}
	search.addEventListener("input", () => { render(); position(); }); render();
	el.addEventListener("focusout", (event) => { if (event.relatedTarget && !el.contains(event.relatedTarget as Node)) close(); });
	position();
	document.addEventListener("pointerdown", outside, true);
	document.addEventListener("keydown", keyboard, true);
	window.addEventListener("resize", position);
	viewport?.addEventListener("resize", position);
	viewport?.addEventListener("scroll", position);
	search.focus({ preventScroll: true });
	return close;
}
