import { FuzzySuggestModal, type App, type FuzzyMatch } from "obsidian";
import type { AnnotationStatusSummary } from "./annotation-status";

export class AnnotationStatusPicker extends FuzzySuggestModal<AnnotationStatusSummary> {
	constructor(
		app: App,
		private summaries: AnnotationStatusSummary[],
		private onPick: (summary: AnnotationStatusSummary) => void
	) {
		super(app);
		this.setPlaceholder("搜索论文、路径或批注状态");
	}

	getItems(): AnnotationStatusSummary[] {
		return this.summaries;
	}

	getItemText(summary: AnnotationStatusSummary): string {
		return [summary.representativePath, ...summary.memberPaths, statusLabel(summary)].join(" ");
	}

	renderSuggestion(match: FuzzyMatch<AnnotationStatusSummary>, el: HTMLElement): void {
		const summary = match.item;
		const name = summary.representativePath.slice(summary.representativePath.lastIndexOf("/") + 1);
		el.createDiv({ text: name });
		el.createDiv({
			cls: "suggestion-note",
			text: `${summary.count} 条 · 首次 ${formatTimestamp(summary.firstCreatedAt)} · 最近 ${formatTimestamp(summary.lastUpdatedAt)}`,
		});
		el.createDiv({ cls: "suggestion-note", text: `${statusLabel(summary)} · ${summary.representativePath}` });
	}

	onChooseItem(summary: AnnotationStatusSummary): void {
		this.onPick(summary);
	}
}

function statusLabel(summary: AnnotationStatusSummary): string {
	if (summary.status === "orphaned") return "未挂载";
	if (summary.status === "shared") return `共享 · ${summary.memberPaths.length} 份 PDF`;
	return "独立 PDF";
}

function formatTimestamp(timestamp: number | null): string {
	if (timestamp === null) return "时间未知";
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return "时间未知";
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
