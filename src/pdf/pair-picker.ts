import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";

/**
 * Picker for "link this PDF with that one". Every vault PDF is searchable;
 * likely filename matches merely start near the top and never hide alternatives.
 */
export class PairPickerModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private candidates: string[],
		private onPick: (path: string) => void
	) {
		super(app);
		this.setPlaceholder("选择要加入当前共享批注组的 PDF");
	}

	getItems(): string[] {
		return this.candidates;
	}

	getItemText(path: string): string {
		return path;
	}

	renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
		const path = match.item;
		const name = path.slice(path.lastIndexOf("/") + 1);
		el.createDiv({ text: name });
		el.createDiv({ cls: "suggestion-note", text: path });
	}

	onChooseItem(path: string): void {
		this.onPick(path);
	}
}
