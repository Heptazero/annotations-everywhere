import { Menu } from "obsidian";
import type { AnnotationLayerDefinition } from "./annotation-layers";
import { toggleAnnotationLayer } from "./annotation-layers";
import type { PdfAnnotation } from "./annotation-types";

/** Adds multi-select membership entries to an annotation's ordinary context menu. */
export function appendAnnotationLayerMenuItems(
	menu: Menu,
	layers: AnnotationLayerDefinition[],
	ann: PdfAnnotation,
	onChange: (next: string[] | undefined) => void
): void {
	menu.addItem((item) => item.setTitle("所属图层（可多选）").setIcon("layers").setIsLabel(true));
	if (layers.length === 0) {
		menu.addItem((item) => item.setTitle("暂无图层，请先到设置中添加").setDisabled(true));
		return;
	}
	for (const layer of layers) {
		menu.addItem((item) =>
			item
				.setTitle(layer.name)
				.setChecked(!!ann.layerIds?.includes(layer.id))
				.onClick(() => onChange(toggleAnnotationLayer(ann.layerIds, layer.id)))
		);
	}
	if (ann.layerIds?.length) {
		menu.addItem((item) => item.setTitle("移出所有图层").setIcon("layers-2").onClick(() => onChange(undefined)));
	}
}

/** Populates the anchored layer filter used by the annotation-list toolbar. */
export function appendLayerFilterMenuItems(
	menu: Menu,
	layers: AnnotationLayerDefinition[],
	activeLayerId: string | null,
	onChoose: (id: string | null) => void
): void {
	menu.addItem((item) => item.setTitle("全部批注").setChecked(activeLayerId === null).onClick(() => onChoose(null)));
	for (const layer of layers) {
		menu.addItem((item) =>
			item
				.setTitle(layer.name)
				.setChecked(activeLayerId === layer.id)
				.onClick(() => onChoose(layer.id))
		);
	}
}
