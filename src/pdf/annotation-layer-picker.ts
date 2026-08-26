import { FuzzySuggestModal, type App } from "obsidian";
import type { AnnotationLayerDefinition } from "./annotation-layers";

type LayerChoice = AnnotationLayerDefinition | null;

export class AnnotationLayerPicker extends FuzzySuggestModal<LayerChoice> {
	constructor(
		app: App,
		private layers: AnnotationLayerDefinition[],
		private activeLayerId: string | null,
		private onPick: (id: string | null) => void
	) {
		super(app);
		this.setPlaceholder("选择要显示的批注图层");
	}

	getItems(): LayerChoice[] {
		return [null, ...this.layers];
	}

	getItemText(item: LayerChoice): string {
		const selected = (item?.id ?? null) === this.activeLayerId ? "✓ " : "";
		return `${selected}${item?.name ?? "全部批注"}`;
	}

	onChooseItem(item: LayerChoice): void {
		this.onPick(item?.id ?? null);
	}
}
