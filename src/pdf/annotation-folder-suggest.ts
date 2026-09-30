import { AbstractInputSuggest, type App } from "obsidian";

type FolderChoice = { path: string } | { empty: true };

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, " ").trim();
}

/** Searchable folder-prefix picker limited to folders represented by annotation data. */
export class AnnotationFolderSuggest extends AbstractInputSuggest<FolderChoice> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private candidates: string[],
		private onChoose: (path: string) => void
	) {
		super(app, input);
		this.limit = 30;
	}

	protected getSuggestions(query: string): FolderChoice[] {
		const terms = normalized(query).split(" ").filter(Boolean);
		const matches = this.candidates
			.filter((path) => {
				const haystack = normalized(path);
				return terms.every((term) => haystack.includes(term));
			})
			.slice(0, this.limit);
		return matches.length > 0 ? matches.map((path) => ({ path })) : [{ empty: true }];
	}

	renderSuggestion(choice: FolderChoice, el: HTMLElement): void {
		if ("empty" in choice) {
			el.createDiv({ cls: "suggestion-note", text: "没有包含批注 PDF 的匹配文件夹" });
			return;
		}
		const name = choice.path.slice(choice.path.lastIndexOf("/") + 1);
		el.createDiv({ text: name });
		el.createDiv({ cls: "suggestion-note", text: choice.path });
	}

	selectSuggestion(choice: FolderChoice): void {
		if ("empty" in choice) return;
		this.setValue(choice.path);
		this.onChoose(choice.path);
		this.close();
	}
}
