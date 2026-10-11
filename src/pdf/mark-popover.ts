import { setIcon, type App } from "obsidian";
import type { AnnotationColorSlot, PdfAnnotationSettings } from "./annotation-settings";
import { activeColorSlots } from "./color-groups";
import { appendColorGroupPicker } from "./color-group-picker";
import { beginTextEditorNavigationScope } from "./editor-key-scope";

export interface MarkPopoverOptions {
	app: App;
	at: { x: number; y: number };
	mode: "create" | "existing";
	swatches: AnnotationColorSlot[];
	colorSettings?: PdfAnnotationSettings;
	onColorGroupChange?: (id: string) => void;
	currentKey?: string;
	quote?: string;
	text?: string;
	onPickColor: (id: string) => void;
	onSaveText?: (text: string, colorKey?: string) => void;
	onChooseForm?: (at: { x: number; y: number }) => void;
	onDelete?: () => void;
	onClose?: () => void;
	/** Opens the inline deletion confirmation, for the PDF context-menu path. */
	initialAction?: "delete";
}

export interface MarkPopoverHandle {
	close(): void;
	/** Routine dismissal is refused while an edited note has unsaved text. */
	requestClose(): boolean;
	isDirty(): boolean;
}

/** One palette/editor at a time, whether opened by a new selection or an old mark. */
let activePopover: MarkPopoverHandle | null = null;

export function openMarkPopover(opts: MarkPopoverOptions): MarkPopoverHandle | null {
	if (activePopover && !activePopover.requestClose()) return null;

	const el = document.body.createDiv({
		cls: "margin-notes-pdf-mark-popover",
		attr: { role: "dialog", "aria-label": opts.mode === "create" ? "勾画与批注" : "编辑勾画" },
	});
	let closed = false;
	let confirmRow: HTMLElement | null = null;
	let editor: HTMLTextAreaElement | null = null;
	let releaseNavigationScope: (() => void) | null = null;
	let draftHint: HTMLElement | null = null;
	let deleteButton: HTMLButtonElement | null = null;
	let draftColorKey = opts.currentKey;
	const handle: MarkPopoverHandle = { close, requestClose, isDirty };
	activePopover = handle;

	const toolbar = el.createDiv({ cls: "margin-notes-pdf-mark-popover-toolbar" });
	if (opts.colorSettings) appendColorGroupPicker(toolbar, opts.colorSettings, (id) => {
		opts.onColorGroupChange?.(id);
		renderPalette(); position();
	}, true);
	const palette = toolbar.createDiv({ cls: "margin-notes-pdf-mark-popover-palette" });
	function renderPalette(): void {
		palette.empty();
		for (const slot of opts.colorSettings ? activeColorSlots(opts.colorSettings) : opts.swatches) {
			const button = palette.createEl("button", {
				cls: "margin-notes-pdf-mark-popover-swatch",
				attr: {
					type: "button",
					"aria-label": `${slot.name}（${slot.color}）`,
					"aria-pressed": String(draftColorKey === slot.id),
					title: slot.name,
				},
			});
			button.setCssProps({ "--margin-notes-pdf-swatch-color": slot.color });
			button.dataset.colorKey = slot.id;
			if (draftColorKey === slot.id) button.addClass("is-current");
			button.addEventListener("click", () => {
				if (editor) {
					draftColorKey = slot.id;
					for (const swatch of palette.querySelectorAll("button")) {
						const selected = swatch === button;
						swatch.toggleClass("is-current", selected);
						swatch.setAttribute("aria-pressed", String(selected));
					}
					return;
				}
				try {
					opts.onPickColor(slot.id);
				} finally {
					close();
				}
			});
		}
	}
	renderPalette();

	{
		const actions = toolbar.createDiv({ cls: "margin-notes-pdf-mark-popover-actions" });
		if (opts.onSaveText) {
			const label = opts.text?.trim() ? "编辑批注" : "添加批注";
			const edit = actions.createEl("button", {
				attr: { type: "button", "aria-label": label, title: label },
			});
			setIcon(edit, "message-square-plus");
			edit.addEventListener("click", () => {
				if (editor) return;
				actions.hide();
				el.addClass("is-expanded");
				const form = el.createDiv({ cls: "margin-notes-pdf-mark-popover-editor" });
				editor = form.createEl("textarea", {
					attr: { "aria-label": "批注内容", placeholder: "写下批注…", rows: "4" },
				});
				editor.value = opts.text ?? "";
				const controls = form.createDiv({ cls: "margin-notes-pdf-mark-popover-editor-actions" });
				const cancel = controls.createEl("button", { text: "取消", attr: { type: "button" } });
				const save = controls.createEl("button", {
					text: "保存",
					cls: "mod-cta",
					attr: { type: "button" },
				});
				const dismissEditor = () => {
					releaseNavigationScope?.();
					releaseNavigationScope = null;
					draftHint?.remove();
					draftHint = null;
					form.remove();
					editor = null;
					draftColorKey = opts.currentKey;
					for (const swatch of palette.querySelectorAll<HTMLButtonElement>("button")) {
						const selected = opts.mode === "existing" && swatch.dataset.colorKey === opts.currentKey;
						swatch.toggleClass("is-current", selected);
						swatch.setAttribute("aria-pressed", String(selected));
					}
					actions.show();
					el.removeClass("is-expanded");
					position();
				};
				cancel.addEventListener("click", dismissEditor);
				save.addEventListener("click", () => {
					const text = editor?.value ?? "";
					try {
						opts.onSaveText?.(text, draftColorKey);
					} finally {
						close();
					}
				});
				releaseNavigationScope = beginTextEditorNavigationScope(opts.app);
				editor.addEventListener("keydown", (event) => {
					event.stopPropagation();
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						save.click();
					}
				});
				editor.addEventListener("keyup", (event) => event.stopPropagation());
				position();
				editor.focus({ preventScroll: true });
			});
		}
		if (opts.onChooseForm) {
			const form = actions.createEl("button", { attr: { type: "button", "aria-label": "转换批注形式", title: "转换批注形式" } });
			setIcon(form, "replace");
			form.addEventListener("click", () => {
				const bounds = form.getBoundingClientRect();
				close();
				opts.onChooseForm?.({ x: bounds.left, y: bounds.bottom });
			});
		}

		if (opts.onDelete) {
			const remove = actions.createEl("button", {
				cls: "margin-notes-pdf-mark-popover-delete",
				attr: { type: "button", "aria-label": "删除勾画", title: "删除勾画" },
			});
			setIcon(remove, "trash-2");
			deleteButton = remove;
			remove.addEventListener("click", () => {
				if (confirmRow) return;
				actions.hide();
				el.addClass("is-expanded");
				confirmRow = el.createDiv({ cls: "margin-notes-pdf-mark-popover-confirm" });
				confirmRow.createDiv({ text: "删除整条勾画及其批注？" });
				const controls = confirmRow.createDiv({ cls: "margin-notes-pdf-mark-popover-editor-actions" });
				const cancel = controls.createEl("button", { text: "取消", attr: { type: "button" } });
				const confirm = controls.createEl("button", {
					text: "删除",
					cls: "margin-notes-pdf-mark-popover-delete mod-warning",
					attr: { type: "button" },
				});
				cancel.addEventListener("click", () => {
					confirmRow?.remove();
					confirmRow = null;
					actions.show();
					el.removeClass("is-expanded");
					position();
					remove.focus();
				});
				confirm.addEventListener("click", () => {
					try {
						opts.onDelete?.();
					} finally {
						close();
					}
				});
				position();
				confirm.focus();
			});
		}
	}
	if (opts.initialAction === "delete") deleteButton?.click();

	function position(): void {
		if (closed) return;
		const gap = 8;
		const bounds = el.getBoundingClientRect();
		const x = Number.isFinite(opts.at.x) ? opts.at.x : window.innerWidth / 2;
		const y = Number.isFinite(opts.at.y) ? opts.at.y : window.innerHeight / 2;
		const left = Math.max(gap, Math.min(x, window.innerWidth - bounds.width - gap));
		const below = y + gap;
		const above = y - bounds.height - gap;
		const top = below + bounds.height <= window.innerHeight - gap ? below : Math.max(gap, above);
		el.setCssStyles({ left: `${left}px`, top: `${Math.min(top, Math.max(gap, window.innerHeight - bounds.height - gap))}px` });
	}

	function onPointerDown(event: PointerEvent): void {
		if (el.contains(event.target as Node)) return;
		if (!requestClose()) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (el.querySelector(".margin-notes-pdf-color-group-menu")) return;
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (editor) {
			el.querySelector<HTMLButtonElement>(".margin-notes-pdf-mark-popover-editor-actions button")?.click();
			return;
		}
		if (confirmRow) {
			confirmRow.querySelector<HTMLButtonElement>("button")?.click();
			return;
		}
		close();
	}

	function onScroll(event: Event): void {
		if (!el.contains(event.target as Node)) requestClose();
	}

	function requestClose(): boolean {
		if (isDirty()) {
			if (!draftHint) draftHint = el.createDiv({ cls: "margin-notes-pdf-mark-popover-draft-hint", text: "请先保存或取消未保存的批注" });
			position();
			editor?.focus({ preventScroll: true });
			return false;
		}
		close();
		return true;
	}

	function isDirty(): boolean {
		return !!editor && (editor.value !== (opts.text ?? "") || draftColorKey !== opts.currentKey);
	}

	function close(): void {
		if (closed) return;
		closed = true;
		releaseNavigationScope?.();
		releaseNavigationScope = null;
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("scroll", onScroll, true);
		window.removeEventListener("resize", position);
		el.remove();
		if (activePopover === handle) activePopover = null;
		opts.onClose?.();
	}

	position();
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("scroll", onScroll, true);
	window.addEventListener("resize", position);
	const initialConfirm = el.querySelector<HTMLElement>(".margin-notes-pdf-mark-popover-confirm");
	// Preserve the PDF selection; only an explicitly opened confirmation takes focus.
	initialConfirm?.querySelector<HTMLButtonElement>("button:last-child")?.focus({ preventScroll: true });
	return handle;
}
