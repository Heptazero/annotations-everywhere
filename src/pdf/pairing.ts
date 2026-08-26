import { TFile, type App } from "obsidian";

const MIN_CORE_LEN = 12;
const MIN_NAME_RATIO = 0.6;

/** A comparison-only filename core; it never decides whether pairing is allowed. */
export function normalizeName(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
	return base.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

/** Used only to rank likely choices at the top of the manual picker. */
export function namesLookRelated(a: string, b: string): boolean {
	const na = normalizeName(a);
	const nb = normalizeName(b);
	if (!na || !nb || na === nb) return na === nb && na.length >= MIN_CORE_LEN;
	const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
	return short.length >= MIN_CORE_LEN && long.includes(short) && short.length / long.length >= MIN_NAME_RATIO;
}

/** All vault PDFs remain selectable; resemblance changes initial order only. */
export function pairingCandidates(app: App, currentPath: string): string[] {
	return app.vault
		.getFiles()
		.filter((file) => file.extension.toLowerCase() === "pdf" && file.path !== currentPath)
		.map((file) => file.path)
		.sort((a, b) => {
			const related = Number(namesLookRelated(currentPath, b)) - Number(namesLookRelated(currentPath, a));
			return related || a.localeCompare(b, undefined, { sensitivity: "base" });
		});
}

export function isPdf(file: unknown): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}
