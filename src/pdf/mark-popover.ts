import type { App } from "obsidian";
import type { AnnotationColorSlot } from "./annotation-settings";
import { beginTextEditorNavigationScope } from "./editor-key-scope";

export interface MarkPopoverOptions {
	app: App;
	at: { x: number; y: number };
	mode: "create" | "existing";
	swatches: AnnotationColorSlot[];
	currentKey?: string;
	quote?: string;
	text?: string;
	onPickColor: (id: string) => void;
	onSaveText?: (text: string) => void;
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
		attr: { role: "dialog", "aria-label": opts.mode === "create" ? "选择勾画颜色" : "编辑勾画" },
	});
	let closed = false;
	let confirmRow: HTMLElement | null = null;
	let editor: HTMLTextAreaElement | null = null;
	let releaseNavigationScope: (() => void) | null = null;
	let draftHint: HTMLElement | null = null;
	let deleteButton: HTMLButtonElement | null = null;
	const handle: MarkPopoverHandle = { close, requestClose, isDirty };
	activePopover = handle;

	if (opts.quote?.trim()) {
		el.createDiv({ cls: "margin-notes-pdf-mark-popover-quote", text: opts.quote.trim() });
	}

	const palette = el.createDiv({ cls: "margin-notes-pdf-mark-popover-palette" });
	for (const slot of opts.swatches) {
		const button = palette.createEl("button", {
			cls: "margin-notes-pdf-mark-popover-swatch",
			attr: {
				type: "button",
				"aria-label": `${slot.name}（${slot.color}）`,
				"aria-pressed": String(opts.mode === "existing" && opts.currentKey === slot.id),
				title: slot.name,
			},
		});
		button.style.setProperty("--margin-notes-pdf-swatch-color", slot.color);
		if (opts.mode === "existing" && opts.currentKey === slot.id) button.addClass("is-current");
		button.addEventListener("click", () => {
			try {
				opts.onPickColor(slot.id);
			} finally {
				close();
			}
		});
	}

	if (opts.mode === "existing") {
		const actions = el.createDiv({ cls: "margin-notes-pdf-mark-popover-actions" });
		if (opts.onSaveText) {
			const edit = actions.createEl("button", {
				text: opts.text?.trim() ? "编辑批注" : "添加批注",
				attr: { type: "button" },
			});
			edit.addEventListener("click", () => {
				if (editor) return;
				actions.hide();
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
					actions.show();
					position();
				};
				cancel.addEventListener("click", dismissEditor);
				save.addEventListener("click", () => {
					const text = editor?.value ?? "";
					try {
						opts.onSaveText?.(text);
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

		if (opts.onDelete) {
			const remove = actions.createEl("button", {
				text: "删除勾画",
				cls: "margin-notes-pdf-mark-popover-delete",
				attr: { type: "button" },
			});
			deleteButton = remove;
			remove.addEventListener("click", () => {
				if (confirmRow) return;
				actions.hide();
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
		el.style.left = `${left}px`;
		el.style.top = `${Math.min(top, Math.max(gap, window.innerHeight - bounds.height - gap))}px`;
	}

	function onPointerDown(event: PointerEvent): void {
		if (el.contains(event.target as Node)) return;
		if (!requestClose()) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
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
		return !!editor && editor.value !== (opts.text ?? "");
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
	if (initialConfirm) initialConfirm.querySelector<HTMLButtonElement>("button:last-child")?.focus({ preventScroll: true });
	else palette.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	return handle;
}
