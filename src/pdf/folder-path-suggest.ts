import { AbstractInputSuggest, type App } from "obsidian";
import { searchFolderPaths } from "./folder-path-search";

type FolderChoice = { path: string } | { empty: true };

/** Inline folder picker; a typed new folder path remains valid input. */
export class FolderPathSuggest extends AbstractInputSuggest<FolderChoice> {
	constructor(
		app: App,
		input: HTMLInputElement,
		private preferredPath: string,
		private onChoose: (path: string) => void
	) {
		super(app, input);
		this.limit = 20;
	}

	protected getSuggestions(query: string): FolderChoice[] {
		const paths = this.app.vault.getAllFolders().map((folder) => folder.path);
		const matches = searchFolderPaths(paths, query, this.preferredPath, this.limit);
		return matches.length > 0 ? matches.map((path) => ({ path })) : [{ empty: true }];
	}

	renderSuggestion(choice: FolderChoice, el: HTMLElement): void {
		if ("empty" in choice) {
			el.createDiv({ cls: "suggestion-note", text: "没有匹配的文件夹；也可以输入新路径" });
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
