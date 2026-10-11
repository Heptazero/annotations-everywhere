/**
 * A small palette popover, used instead of the OS colour panel.
 *
 * The native `<input type=color>` route had to place an invisible input at the
 * click just to coax the system panel to open nearby, and it still landed in a
 * corner. This is a plain element positioned where it was asked for, so it is
 * simply where the click was — and offering a fixed set of colours keeps a
 * document's annotations looking like one system rather than a free-for-all.
 */
export function openSwatchPicker(opts: {
	at: { x: number; y: number };
	swatches: AnnotationColorSlot[];
	colorSettings?: PdfAnnotationSettings;
	onColorGroupChange?: (id: string) => void;
	currentKey?: string;
	onPick: (colorKey: string | undefined) => void;
}): void {
	const el = document.body.createDiv("margin-notes-pdf-swatches");
	if (opts.colorSettings) appendColorGroupPicker(el, opts.colorSettings, (id) => {
		opts.onColorGroupChange?.(id); renderPalette(); position();
	}, true);
	const palette = el.createDiv("margin-notes-pdf-swatch-palette");
	function renderPalette(): void {
		palette.empty();
		for (const slot of opts.colorSettings ? activeColorSlots(opts.colorSettings) : opts.swatches) {
			const b = palette.createEl("button", { cls: "margin-notes-pdf-swatch-dot", attr: { type: "button" } });
			b.setCssStyles({ background: slot.color });
			b.setAttribute("aria-label", slot.name);
			b.setAttribute("title", slot.name);
			if (opts.currentKey === slot.id) b.addClass("is-current");
			b.addEventListener("click", () => {
				opts.onPick(slot.id);
				close();
			});
		}
	}
	renderPalette();

	const reset = el.createDiv({ cls: "margin-notes-pdf-swatch-reset", text: "默认颜色" });
	reset.addEventListener("click", () => {
		opts.onPick(undefined);
		close();
	});

	// Positioned after insertion so the measured size can be used to keep it on
	// screen — a popover opened near the right or bottom edge would otherwise
	// hang off it.
	function position(): void {
		const r = el.getBoundingClientRect();
		el.setCssStyles({ left: `${Math.max(4, Math.min(opts.at.x, window.innerWidth - r.width - 4))}px`, top: `${Math.max(4, Math.min(opts.at.y + 6, window.innerHeight - r.height - 4))}px` });
	}
	position();

	const onDown = (e: MouseEvent) => {
		if (!el.contains(e.target as Node)) close();
	};
	const onKey = (e: KeyboardEvent) => {
		if (el.querySelector(".margin-notes-pdf-color-group-menu")) return;
		if (e.key === "Escape") close();
	};
	function close(): void {
		document.removeEventListener("mousedown", onDown, true);
		document.removeEventListener("keydown", onKey, true);
		el.remove();
	}
	// Capture phase, and deferred by a frame so the click that opened this popover
	// cannot immediately close it again.
	window.requestAnimationFrame(() => {
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey, true);
	});
}
import type { AnnotationColorSlot, PdfAnnotationSettings } from "./annotation-settings";
import { activeColorSlots } from "./color-groups";
import { appendColorGroupPicker } from "./color-group-picker";
