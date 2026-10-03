import { MarkdownRenderer, loadMathJax, setIcon, type App, type Component } from "obsidian";
import { beginTextEditorNavigationScope } from "./editor-key-scope";

const EDITING_CLASS = "is-editing";

export interface ToolbarAction {
	/** Lucide icon name (preferred). */
	icon?: string;
	/** Fallback glyph when no icon is given. */
	label?: string;
	/** Native tooltip. */
	title: string;
	cls?: string;
	onClick: (ev: MouseEvent) => void;
}

export interface AnnotationBoxOptions {
	app: App;
	/** Owns the child components MarkdownRenderer attaches; unload it to release them. */
	component: Component;
	/** Path used to resolve wikilinks/embeds written inside the annotation. */
	sourcePath: string;
	initialText: string;
	placeholder?: string;
	onCommit: (text: string) => void;
	actions?: ToolbarAction[];
}

export interface AnnotationBoxHandle {
	el: HTMLDivElement;
	bodyEl: HTMLDivElement;
	/** Exposed so callers can prepend their own controls (e.g. a drag grip). */
	toolbarEl: HTMLDivElement;
	enterEdit(): void;
	render(): Promise<void>;
}

/**
 * Builds one annotation box — the shared shell behind BOTH the floating popover
 * and the side-margin box, so the two look and behave identically (same toolbar
 * placement, same edit interaction).
 *
 * Display state renders the annotation's Markdown through Obsidian's own
 * pipeline (LaTeX/MathJax, wikilinks, bold, …), exactly like the footnote
 * sidenote in src/margin-view-plugin.ts. Clicking the body swaps it for a real
 * multiline textarea: Enter inserts a line, blur or Mod+Enter commits, Escape
 * reverts. A textarea is deliberate — contentEditable rewrites line breaks as
 * browser-dependent div/br DOM and was eating Markdown newlines on round-trip.
 * Clicking a link inside the rendered output follows the link instead of
 * entering edit mode.
 */
export function buildAnnotationBox(parent: HTMLElement, extraClass: string, opts: AnnotationBoxOptions): AnnotationBoxHandle {
	const el = parent.createDiv(`margin-notes-pdf-box ${extraClass}`);
	el.dataset.source = opts.initialText;

	// Toolbar sits INSIDE the box's top-right corner (not as a negative-offset
	// badge hanging off the edge, which read as clipped/misplaced) and is
	// revealed on hover.
	const toolbar = el.createDiv("margin-notes-pdf-toolbar");
	for (const action of opts.actions ?? []) {
		const btn = toolbar.createDiv({ cls: `margin-notes-pdf-action ${action.cls ?? ""}` });
		if (action.icon) setIcon(btn, action.icon);
		else btn.setText(action.label ?? "");
		btn.setAttribute("aria-label", action.title);
		btn.addEventListener("mousedown", (e) => e.stopPropagation());
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			action.onClick(e);
		});
	}

	const bodyEl = el.createDiv("margin-notes-pdf-body");
	bodyEl.dataset.placeholder = opts.placeholder ?? "写点什么…";
	bodyEl.spellcheck = false;
	let editorEl: HTMLTextAreaElement | null = null;
	let releaseNavigationScope: (() => void) | null = null;

	const render = async (): Promise<void> => {
		bodyEl.empty();
		const source = el.dataset.source ?? "";
		if (!source) return; // placeholder shows via :empty::before
		if (source.includes("$")) await loadMathJax();
		await MarkdownRenderer.render(opts.app, source, bodyEl, opts.sourcePath, opts.component);

		// Wikilinks render as <a class="internal-link">; Obsidian only wires its own
		// click handling inside its own views, so resolve them by hand here.
		bodyEl.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			a.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const target = a.dataset.href ?? a.getAttribute("href") ?? "";
				if (target) void opts.app.workspace.openLinkText(target, opts.sourcePath, e.ctrlKey || e.metaKey);
			});
		});
	};

	const enterEdit = (): void => {
		if (editorEl) return;
		el.addClass(EDITING_CLASS);
		bodyEl.empty();
		const editor = bodyEl.createEl("textarea", { cls: "margin-notes-pdf-editor" });
		editorEl = editor;
		editor.value = el.dataset.source ?? "";
		editor.spellcheck = false;
		releaseNavigationScope = beginTextEditorNavigationScope(opts.app);
		const resize = () => {
			editor.setCssStyles({ height: "0px" });
			editor.setCssStyles({ height: `${Math.max(48, editor.scrollHeight)}px` });
		};
		editor.addEventListener("input", resize);
		editor.addEventListener("blur", () => finishEdit(true));
		editor.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				finishEdit(false);
			} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				finishEdit(true);
			}
		});
		// pdf.js variants may also listen on keyup. It has no role in textarea
		// editing, so keep that phase inside the editor as well.
		editor.addEventListener("keyup", (event) => event.stopPropagation());
		resize();
		editor.focus();
		editor.setSelectionRange(editor.value.length, editor.value.length);
	};

	const finishEdit = (save: boolean): void => {
		const editor = editorEl;
		if (!editor) return;
		releaseNavigationScope?.();
		releaseNavigationScope = null;
		const previous = el.dataset.source ?? "";
		const newText = save ? editor.value.replace(/\r\n/g, "\n") : previous;
		editorEl = null;
		el.removeClass(EDITING_CLASS);
		const changed = save && newText !== previous;
		el.dataset.source = newText;
		void render();
		if (changed) opts.onCommit(newText);
	};

	el.addEventListener("mousedown", (e) => e.stopPropagation());
	bodyEl.addEventListener("click", (e) => {
		if (el.hasClass(EDITING_CLASS)) return;
		// A click on rendered link text means "follow it", not "start editing".
		if ((e.target as HTMLElement).closest("a")) return;
		enterEdit();
	});

	return { el, bodyEl, toolbarEl: toolbar, enterEdit, render };
}
