import { Scope, prepareFuzzySearch, type App } from "obsidian";
import { TEXT_EDITOR_NAVIGATION_KEYS } from "./editor-key-scope";
import type { PdfReferenceSource } from "./pdf-reference-index";
import { referenceSourceCounts } from "./pdf-reference-decoration";

/** Anchored, searchable source list; callers own cleanup when the plugin unloads. */
export function openPdfReferencePicker(app: App, refs: PdfReferenceSource[], at: { x: number; y: number }, onChoose: (ref: PdfReferenceSource) => void, onClose: () => void): () => void {
	const el = document.body.createDiv({ cls: "margin-notes-pdf-reference-picker", attr: { role: "dialog", "aria-label": "引用此处的笔记" } });
	const counts = referenceSourceCounts(refs);
	el.createDiv({ cls: "margin-notes-pdf-reference-summary", text: `${counts.notes} 篇笔记 · ${counts.references} 处引用` });
	const search = el.createEl("input", { attr: { type: "search", placeholder: "搜索引用笔记…", "aria-label": "搜索引用笔记" } });
	const results = el.createDiv("margin-notes-pdf-reference-results");
	let closed = false;
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
	function close(): void {
		if (closed) return;
		closed = true;
		app.keymap.popScope(scope);
		document.removeEventListener("pointerdown", outside, true);
		document.removeEventListener("keydown", keyboard, true);
		el.remove(); onClose();
	}
	function outside(event: PointerEvent): void { if (!el.contains(event.target as Node)) close(); }
	function keyboard(event: KeyboardEvent): void {
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
		if (!el.contains(event.target as Node)) return;
		event.stopPropagation();
		const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("button"));
		const index = buttons.findIndex((button) => button === event.target);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault(); buttons[event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)]?.focus();
		}
		if (event.key === "Enter" && event.target === search) { event.preventDefault(); buttons[0]?.click(); }
	}
	search.addEventListener("input", render); render();
	const bounds = el.getBoundingClientRect();
	el.setCssStyles({ left: `${Math.max(8, Math.min(at.x, window.innerWidth - bounds.width - 8))}px`, top: `${Math.max(8, Math.min(at.y + 6, window.innerHeight - bounds.height - 8))}px` });
	document.addEventListener("pointerdown", outside, true);
	document.addEventListener("keydown", keyboard, true);
	search.focus({ preventScroll: true });
	return close;
}
