import type { PdfAnnotation } from "./annotation-types";

interface AnnotationSearch {
	pages: number[];
	terms: string[];
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

/** Parses optional page filters while leaving ordinary Markdown/LaTeX searchable. */
export function parseAnnotationSearch(query: string): AnnotationSearch {
	const pages: number[] = [];
	const withoutPages = query
		.replace(/\bpage\s*:\s*(\d+)\b/gi, (_match, page: string) => {
			pages.push(Number(page));
			return " ";
		})
		.replace(/第\s*(\d+)\s*页/g, (_match, page: string) => {
			pages.push(Number(page));
			return " ";
		});
	return {
		pages,
		terms: normalize(withoutPages).split(" ").filter(Boolean),
	};
}

/** All terms and all explicit page filters must match the annotation. */
export function filterAnnotations(annotations: PdfAnnotation[], query: string): PdfAnnotation[] {
	const search = parseAnnotationSearch(query);
	if (search.pages.length === 0 && search.terms.length === 0) return annotations;
	return annotations.filter((annotation) => {
		if (search.pages.some((page) => page !== annotation.page)) return false;
		const text = normalize(annotation.text);
		return search.terms.every((term) => text.includes(term));
	});
}
