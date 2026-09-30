import { AbstractInputSuggest, type App } from "obsidian";

type PdfChoice = { path: string } | { empty: true };

function normalized(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_-]+/g, " ").trim();
}

/** Inline fuzzy-enough PDF picker for batch annotation operations. */
export class PdfPathSuggest extends AbstractInputSuggest<PdfChoice> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private candidates: string[],
		private onChoose: (path: string) => void
	) {
		super(app, input);
		this.limit = 30;
	}

	protected getSuggestions(query: string): PdfChoice[] {
		const terms = normalized(query).split(" ").filter(Boolean);
		const matches = this.candidates
			.filter((path) => {
				const haystack = normalized(path);
				return terms.every((term) => haystack.includes(term));
			})
			.slice(0, this.limit);
		return matches.length > 0 ? matches.map((path) => ({ path })) : [{ empty: true }];
	}

	renderSuggestion(choice: PdfChoice, el: HTMLElement): void {
		if ("empty" in choice) {
			el.createDiv({ cls: "suggestion-note", text: "没有匹配的 PDF" });
			return;
		}
		const name = choice.path.slice(choice.path.lastIndexOf("/") + 1);
		el.createDiv({ text: name });
		el.createDiv({ cls: "suggestion-note", text: choice.path });
	}

	selectSuggestion(choice: PdfChoice): void {
		if ("empty" in choice) return;
		this.setValue(choice.path);
		this.onChoose(choice.path);
		this.close();
	}
}
