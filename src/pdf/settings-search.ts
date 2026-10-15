import { prepareFuzzySearch } from "obsidian";

/** Each term must match one field; term order and Unicode composition do not matter. */
export function settingsSearchMatcher(query: string): (fields: readonly string[]) => boolean {
	const terms = query.normalize("NFC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).map(prepareFuzzySearch);
	return (fields) => {
		const normalized = fields.map((field) => field.normalize("NFC").toLocaleLowerCase());
		return terms.every((match) => normalized.some((field) => match(field) !== null));
	};
}
