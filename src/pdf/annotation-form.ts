import type { Menu } from "obsidian";
import type { PdfAnnotation } from "./annotation-types";

export type AnnotationForm = "mark" | "popup" | "free" | "left" | "right";

const FORMS: Array<{ id: AnnotationForm; name: string; icon: string }> = [
	{ id: "mark", name: "勾画（悬浮显示批注）", icon: "highlighter" },
	{ id: "popup", name: "收起成点", icon: "circle-dot" },
	{ id: "free", name: "自由批注框", icon: "sticky-note" },
	{ id: "left", name: "左侧批注", icon: "panel-left" },
	{ id: "right", name: "右侧批注", icon: "panel-right" },
];

export function annotationForm(ann: PdfAnnotation): AnnotationForm {
	if (ann.markOnly) return "mark";
	if (ann.pinned) return ann.side;
	return ann.collapsed ? "popup" : "free";
}

/** Change presentation in place; identity, text, anchors and memberships survive. */
export function setAnnotationForm(ann: PdfAnnotation, form: AnnotationForm): void {
	ann.markOnly = form === "mark" ? true : undefined;
	ann.pinned = form === "left" || form === "right";
	ann.collapsed = form === "mark" || form === "popup";
	if (form === "left" || form === "right") ann.side = form;
}

export function appendAnnotationFormMenuItems(menu: Menu, ann: PdfAnnotation, onChoose: (form: AnnotationForm) => void): void {
	menu.addItem((item) => item.setTitle("批注显示形式").setIsLabel(true));
	for (const form of FORMS) {
		menu.addItem((item) => item.setTitle(form.name).setIcon(form.icon)
			.setChecked(annotationForm(ann) === form.id).onClick(() => onChoose(form.id)));
	}
}
