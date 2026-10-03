import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type App, Component, MarkdownRenderer, editorInfoField, loadMathJax } from "obsidian";
import { footnoteRefIsVisible, scanFootnotes, serializeDefContent } from "./footnote-scan";
import { resolveCollisions } from "./collision-avoidance";
import {
	MIN_MARKDOWN_MARGIN_GAP,
	normalizeMarkdownMarginSettings,
	type MarkdownMarginSettings,
} from "./markdown-margin-settings";

const LAYER_CLASS = "margin-notes-layer";
const BOX_CLASS = "margin-notes-box";
const EDITING_CLASS = "is-editing";
const MIN_GAP = 8;

export interface MarkdownMarginSettingsController {
	get(): MarkdownMarginSettings;
	save(settings: MarkdownMarginSettings): void;
	onChange(listener: (settings: MarkdownMarginSettings) => void): () => void;
}

interface BoxData {
	id: string;
	/** Natural top, aligned with the `[^id]` reference's line. */
	top: number;
	content: string;
	hasDef: boolean;
}

interface Measurement {
	left: number;
	boxes: BoxData[];
}

interface MarginBoxHandle {
	el: HTMLDivElement;
	bodyEl: HTMLDivElement;
}

/**
 * Renders each footnote's definition as an Obsidian-rendered Markdown box
 * (LaTeX/MathJax, bold, links … all through the native pipeline) in the right
 * margin, vertically aligned with its first `[^id]` reference. The layer is a
 * CHILD of CM6's own scrollDOM (`.cm-scroller`) — because it shares that
 * scrolling container, positions only need recomputing on doc/geometry
 * change, never on scroll (scrolling moves the whole layer for free).
 *
 * Editing: clicking a box swaps the rendered Markdown for the plain source in
 * a contentEditable (same mental model as Live Preview). Committing
 * (blur/Enter) writes the text back into the document's `[^id]: ...`
 * definition via `view.dispatch`, or appends a new definition if none exists;
 * Escape discards and re-renders.
 */
class MarginNotesViewPlugin {
	private layer: HTMLDivElement;
	/** Id of the box currently being edited, if any. */
	private editingId: string | null = null;
	/** A rebuild arrived while editing — run it once the edit commits. */
	private pendingRebuild = false;
	/** Owns the lifecycle of child components MarkdownRenderer attaches (one per rebuild). */
	private renderComponent = new Component();
	/** Bumped per rebuild so stale async render passes know to bail out. */
	private buildGen = 0;
	private marginSettings: MarkdownMarginSettings;
	private unsubscribeSettings: () => void;
	private resizeCleanup: (() => void) | null = null;

	constructor(
		private view: EditorView,
		private app: App,
		private settingsController: MarkdownMarginSettingsController,
	) {
		this.renderComponent.load();
		this.layer = createDiv({ cls: LAYER_CLASS });
		this.marginSettings = settingsController.get();
		this.applyMarginSettings(this.marginSettings);
		this.unsubscribeSettings = settingsController.onChange((settings) => {
			this.marginSettings = settings;
			this.applyMarginSettings(settings);
			this.scheduleRebuild();
		});
		this.view.scrollDOM.appendChild(this.layer);
		this.scheduleRebuild();
	}

	update(update: ViewUpdate): void {
		// Not perf-tuned yet (viewportChanged fires on scroll too, which is more
		// rebuilding than strictly needed) — fine for a first correctness check.
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.scheduleRebuild();
		}
	}

	/**
	 * `coordsAtPos`/`getBoundingClientRect` are layout reads — CM6 throws
	 * ("Reading the editor layout isn't allowed during an update") if they're
	 * called synchronously from `update()` or the plugin constructor, since both
	 * run before CM6's own DOM write phase. `requestMeasure` defers the `read`
	 * callback to CM6's dedicated measure phase and `write` to the following
	 * write phase — the only safe way to do this.
	 */
	private scheduleRebuild(): void {
		if (this.editingId !== null) {
			// Rebuilding would destroy the contentEditable mid-edit; defer.
			this.pendingRebuild = true;
			return;
		}
		this.view.requestMeasure<Measurement>({
			read: (view) => this.measure(view),
			write: (measurement) => this.applyMeasurement(measurement),
		});
	}

	private measure(view: EditorView): Measurement {
		const text = view.state.doc.toString();
		const { refs, defs } = scanFootnotes(text);
		const scrollerRect = view.scrollDOM.getBoundingClientRect();

		// Position the layer at the actual rendered text's right edge, not the
		// scroller's — themes commonly center a narrower readable-line-length
		// content column inside a wider scroller, leaving margin space on both sides.
		const contentRect = view.contentDOM.getBoundingClientRect();
		const left = contentRect.right - scrollerRect.left + view.scrollDOM.scrollLeft;

		const defsById = new Map<string, string>();
		for (const def of defs) {
			if (!defsById.has(def.id)) defsById.set(def.id, def.content);
		}

		const boxes: BoxData[] = [];
		const seen = new Set<string>();
		for (const ref of refs) {
			// CM6 excludes folded document spans from visibleRanges. Check before
			// de-duplicating so a hidden first reference does not suppress a later,
			// visible reference to the same footnote.
			if (!footnoteRefIsVisible(ref, view.visibleRanges)) continue;
			if (seen.has(ref.id)) continue;

			const coords = view.coordsAtPos(ref.pos);
			if (!coords) continue; // not currently measured (e.g. far outside viewport)
			seen.add(ref.id);

			const top = coords.top - scrollerRect.top + view.scrollDOM.scrollTop;
			const content = defsById.get(ref.id);
			boxes.push({
				id: ref.id,
				top,
				content: content ?? "",
				hasDef: content !== undefined,
			});
		}

		return { left, boxes };
	}

	private applyMeasurement(measurement: Measurement): void {
		// Fresh component per rebuild: unloading releases whatever child
		// components the previous pass's MarkdownRenderer.render attached.
		this.renderComponent.unload();
		this.renderComponent = new Component();
		this.renderComponent.load();

		this.layer.empty();
		this.layer.style.left = `${measurement.left}px`;

		const rendered = measurement.boxes.map((box) => ({
			id: box.id,
			top: box.top,
			height: 0,
			content: box.content,
			...this.createBox(box),
		}));

		void this.finishRender(++this.buildGen, rendered);
	}

	/**
	 * Markdown rendering is async (MathJax may need to load/typeset), and the
	 * boxes' heights aren't final until it completes — so collision avoidance
	 * must wait for it, then run in its own measure cycle.
	 */
	private async finishRender(
		gen: number,
		rendered: {
			id: string;
			top: number;
			height: number;
			content: string;
			el: HTMLDivElement;
			bodyEl: HTMLDivElement;
		}[],
	): Promise<void> {
		await Promise.all(rendered.map((r) => this.renderDisplay(r.bodyEl, r.content)));
		if (gen !== this.buildGen) return; // superseded by a newer rebuild

		this.view.requestMeasure({
			read: () => {
				for (const r of rendered) r.height = r.el.offsetHeight;
				return resolveCollisions(rendered, MIN_GAP);
			},
			write: (resolved) => {
				for (const r of resolved) r.el.style.top = `${r.top}px`;
			},
		});
	}

	/** Renders footnote source as Obsidian Markdown (incl. LaTeX) into the box. */
	private async renderDisplay(el: HTMLElement, content: string): Promise<void> {
		el.empty();
		if (!content) return; // placeholder shows via :empty::before
		if (content.includes("$")) await loadMathJax();
		await MarkdownRenderer.render(this.app, content, el, this.sourcePath(), this.renderComponent);
	}

	/** Path of the file behind this editor, for resolving links/embeds. */
	private sourcePath(): string {
		return this.view.state.field(editorInfoField, false)?.file?.path ?? "";
	}

	private createBox(box: BoxData): MarginBoxHandle {
		const el = this.layer.createDiv(BOX_CLASS);
		el.dataset.footnoteId = box.id;
		el.dataset.source = box.content;
		el.style.top = `${box.top}px`;
		const bodyEl = el.createDiv("margin-notes-body");
		bodyEl.spellcheck = false;
		bodyEl.dataset.placeholder = box.hasDef ? "(空)" : `[^${box.id}] 无定义,点击添加`;
		this.attachResize(el);

		// Keep CM6 from treating interactions with the box as editor input.
		el.addEventListener("mousedown", (e) => e.stopPropagation());
		el.addEventListener("click", () => {
			if (!el.hasClass(EDITING_CLASS)) this.enterEdit(el, bodyEl, box.id);
		});
		bodyEl.addEventListener("blur", () => {
			if (!el.hasClass(EDITING_CLASS)) return;
			const changed = this.commit(box.id, bodyEl);
			bodyEl.contentEditable = "false";
			el.removeClass(EDITING_CLASS);
			this.editingId = null;
			if (this.pendingRebuild) {
				this.pendingRebuild = false;
				this.scheduleRebuild();
			} else if (!changed) {
				// No doc change means no rebuild is coming — restore the
				// rendered view ourselves.
				void this.renderDisplay(bodyEl, el.dataset.source ?? "");
			}
		});
		bodyEl.addEventListener("keydown", (e) => {
			if (!el.hasClass(EDITING_CLASS)) return;
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				bodyEl.blur(); // commit
			} else if (e.key === "Escape") {
				e.preventDefault();
				bodyEl.setText(el.dataset.source ?? "");
				bodyEl.blur(); // text equals source → commit is a no-op → re-render
			}
		});
		return { el, bodyEl };
	}

	private applyMarginSettings(settings: MarkdownMarginSettings): void {
		this.layer.style.setProperty("--margin-notes-md-width", `${settings.width}px`);
		this.layer.style.setProperty("--margin-notes-md-gap", `${settings.gap}px`);
	}

	/** Both edges resize one shared Markdown rail, so every side note stays aligned. */
	private attachResize(box: HTMLDivElement): void {
		const begin = (edge: "left" | "right") => (ev: PointerEvent) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.resizeCleanup?.();
			const startX = ev.clientX;
			const start = { ...this.marginSettings };
			box.addClass("is-resizing");

			const solve = (x: number): MarkdownMarginSettings => {
				const dx = x - startX;
				if (edge === "right") {
					return normalizeMarkdownMarginSettings({ width: start.width + dx, gap: start.gap });
				}
				// The left edge faces the document. Move it while keeping the outer
				// edge fixed; once the minimum gap is reached, further growth belongs
				// to the outer/right handle.
				const width = Math.min(start.width - dx, start.width + start.gap - MIN_MARKDOWN_MARGIN_GAP);
				const normalized = normalizeMarkdownMarginSettings({ width, gap: start.gap + start.width - width });
				return normalized;
			};

			const onMove = (move: PointerEvent) => {
				this.applyMarginSettings(solve(move.clientX));
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				box.removeClass("is-resizing");
				this.resizeCleanup = null;
			};
			const onUp = (up: PointerEvent) => {
				const next = solve(up.clientX);
				cleanup();
				this.settingsController.save(next);
			};
			const onCancel = () => {
				cleanup();
				this.applyMarginSettings(start);
			};
			this.resizeCleanup = cleanup;
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
		};

		for (const edge of ["left", "right"] as const) {
			const grip = box.createDiv(`margin-notes-resize is-${edge}`);
			grip.setAttribute("aria-label", edge === "left" ? "拖动内边缘调整全部注脚宽度" : "拖动外边缘调整全部注脚宽度");
			grip.addEventListener("pointerdown", begin(edge));
			grip.addEventListener("click", (ev) => ev.stopPropagation());
		}
	}

	/** Swaps rendered Markdown for the editable plain source. */
	private enterEdit(el: HTMLDivElement, bodyEl: HTMLDivElement, id: string): void {
		this.editingId = id;
		el.addClass(EDITING_CLASS);
		bodyEl.empty();
		bodyEl.contentEditable = "true";
		bodyEl.setText(el.dataset.source ?? "");
		bodyEl.focus();
		const sel = window.getSelection();
		if (sel) {
			sel.selectAllChildren(bodyEl);
			sel.collapseToEnd();
		}
	}

	/**
	 * Writes the box's text back into the document: replaces the existing
	 * `[^id]: ...` block's content, or appends a new definition at the end of
	 * the document if the id has none yet. Returns whether the doc changed.
	 */
	private commit(id: string, el: HTMLElement): boolean {
		// contentEditable innerText: \n for line breaks, NBSP for some spaces.
		const newText = el.innerText.replace(/\u00a0/g, " ").replace(/\n+$/, "").trimEnd();
		const doc = this.view.state.doc.toString();
		const { defs } = scanFootnotes(doc);
		const def = defs.find((d) => d.id === id);

		if (def) {
			if (newText === def.content) return false;
			this.view.dispatch({
				changes: {
					from: def.markerEnd,
					to: def.to,
					insert: newText ? ` ${serializeDefContent(newText)}` : "",
				},
			});
			return true;
		}
		if (newText) {
			const sep = doc.length === 0 ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
			this.view.dispatch({
				changes: {
					from: doc.length,
					insert: `${sep}[^${id}]: ${serializeDefContent(newText)}\n`,
				},
			});
			return true;
		}
		return false;
	}

	destroy(): void {
		this.resizeCleanup?.();
		this.unsubscribeSettings();
		this.renderComponent.unload();
		this.layer.remove();
	}
}

export function createMarginNotesExtension(app: App, settings: MarkdownMarginSettingsController) {
	return ViewPlugin.define((view) => new MarginNotesViewPlugin(view, app, settings));
}
