function folded(value: string): string {
	return value.normalize("NFC").replace(/\\/g, "/").toLocaleLowerCase();
}

function subsequenceGaps(text: string, query: string): number | null {
	let previous = -1;
	let gaps = 0;
	for (const char of query) {
		const next = text.indexOf(char, previous + 1);
		if (next < 0) return null;
		if (previous >= 0) gaps += next - previous - 1;
		previous = next;
	}
	return gaps;
}

/** Rank vault folders without changing their actual paths or creating new ones. */
export function searchFolderPaths(
	paths: readonly string[],
	query: string,
	preferredPath = "",
	limit = 20
): string[] {
	const needle = folded(query.trim());
	const preferred = folded(preferredPath);
	const scored: Array<{ path: string; score: number }> = [];
	for (const path of paths) {
		if (!path || path === "/") continue;
		const full = folded(path);
		const name = full.slice(full.lastIndexOf("/") + 1);
		let score: number;
		if (!needle) score = full === preferred ? -100 : path.split("/").length * 10;
		else if (full === needle) score = -100;
		else if (name === needle) score = -90;
		else if (name.startsWith(needle)) score = 0;
		else if (full.startsWith(needle)) score = 10;
		else if (name.includes(needle)) score = 20 + name.indexOf(needle);
		else if (full.includes(needle)) score = 40 + full.indexOf(needle);
		else {
			const terms = needle.split(/\s+/).filter(Boolean);
			if (terms.length > 1 && terms.every((term) => full.includes(term))) {
				score = 70 + terms.reduce((total, term) => total + full.indexOf(term), 0);
			} else {
				const compactQuery = needle.replace(/[\s/_-]/g, "");
				const compactName = name.replace(/[\s/_-]/g, "");
				const compactFull = full.replace(/[\s/_-]/g, "");
				const gaps = subsequenceGaps(compactName, compactQuery) ?? subsequenceGaps(compactFull, compactQuery);
				if (gaps === null) continue;
				score = 100 + gaps;
			}
		}
		if (full === preferred) score -= 5;
		scored.push({ path, score });
	}
	return scored
		.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path, "zh-CN"))
		.slice(0, Math.max(0, limit))
		.map(({ path }) => path);
}
