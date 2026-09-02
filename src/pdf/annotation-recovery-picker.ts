import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type { OrphanedAnnotationSource } from "./annotation-recovery";

/** Lets the user explicitly attach one recoverable list to the current PDF. */
export class AnnotationRecoveryPicker extends FuzzySuggestModal<OrphanedAnnotationSource> {
	constructor(
		app: App,
		private candidates: OrphanedAnnotationSource[],
		private targetPages: number,
		private onPick: (source: OrphanedAnnotationSource) => void
	) {
		super(app);
		this.setPlaceholder("选择要恢复到当前 PDF 的旧批注");
	}

	getItems(): OrphanedAnnotationSource[] {
		return this.candidates;
	}

	getItemText(source: OrphanedAnnotationSource): string {
		return source.path;
	}

	renderSuggestion(match: FuzzyMatch<OrphanedAnnotationSource>, el: HTMLElement): void {
		const source = match.item;
		const name = source.path.slice(source.path.lastIndexOf("/") + 1);
		el.createDiv({ text: name });
		el.createDiv({
			cls: "suggestion-note",
			text: `${source.count} 条批注 · 最后批注第 ${source.maxPage} 页 / 当前共 ${this.targetPages} 页`,
		});
		el.createDiv({ cls: "suggestion-note", text: source.path });
	}

	onChooseItem(source: OrphanedAnnotationSource): void {
		this.onPick(source);
	}
}
