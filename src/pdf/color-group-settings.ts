import { Modal, Setting, setIcon, type App } from "obsidian";
import { makeColorSlotId, type PdfAnnotationSettings } from "./annotation-settings";
import { activeColorGroup, activeColorSlots, archiveColorGroup, makeColorGroupId, visibleColorGroups } from "./color-groups";
import { appendColorGroupPicker } from "./color-group-picker";

/** Settings-only UI; removed groups/slots stay in the catalog for older annotations. */
export function renderColorGroupSettings(parent: HTMLElement, app: App, settings: PdfAnnotationSettings, commit: () => void): void {
	const root = parent.createDiv("margin-notes-pdf-palette-settings");
	const render = () => {
		root.empty();
		const group = activeColorGroup(settings);
		new Setting(root).setName("预设颜色组").setDesc("不同语境使用独立的颜色含义。切组不改变已有批注；删除组只移出预设，旧批注保留颜色和含义。")
			.addExtraButton((button) => button.setIcon("plus").setTooltip("添加颜色组（复制当前组颜色，独立编辑）").onClick(() => {
				const keys = activeColorSlots(settings).map((slot) => {
					const id = makeColorSlotId(settings.palette.map((item) => item.id));
					settings.palette.push({ ...slot, id });
					return id;
				});
				const id = makeColorGroupId();
				settings.colorGroups.push({ id, name: `颜色组 ${visibleColorGroups(settings).length + 1}`, colorKeys: keys });
				settings.activeColorGroupId = id;
				commit(); render();
			}));
		appendColorGroupPicker(root, settings, () => { commit(); render(); });
		new Setting(root).setName("组名").addText((input) => input.setValue(group.name).onChange((value) => {
			if (!value.trim()) return;
			group.name = value.trim(); commit();
		})).addExtraButton((button) => button.setIcon("trash").setTooltip("删除此组，保留已有批注语义").setDisabled(visibleColorGroups(settings).length < 2).onClick(() => {
			const modal = new Modal(app);
			modal.titleEl.setText(`删除颜色组「${group.name}」？`);
			modal.contentEl.createEl("p", { text: "这组将不再出现在预设中。已有批注及其颜色、语义全部保留。" });
			new Setting(modal.contentEl).addButton((b) => b.setButtonText("取消").onClick(() => modal.close()))
				.addButton((b) => b.setButtonText("删除组").onClick(() => {
					archiveColorGroup(settings, group.id); commit(); modal.close(); render();
				}));
			modal.open();
		}));
		new Setting(root).setName("组内颜色").setDesc("名称表示语义；改名或改色会更新使用此项的旧批注。不同组互不影响。")
			.addExtraButton((button) => button.setIcon("plus").setTooltip("添加颜色").onClick(() => {
				const id = makeColorSlotId(settings.palette.map((slot) => slot.id));
				settings.palette.push({ id, name: `颜色 ${group.colorKeys.length + 1}`, color: "#808080" });
				group.colorKeys.push(id); commit(); render();
			}));
		activeColorSlots(settings).forEach((slot, index) => {
			const row = new Setting(root).setName(`颜色 ${index + 1}`);
			const reorder = row.nameEl.createSpan({ cls: "margin-notes-pdf-palette-reorder" });
			row.nameEl.prepend(reorder);
			for (const [delta, icon, label] of [[-1, "arrow-up", "上移"], [1, "arrow-down", "下移"]] as const) {
				const target = index + delta;
				const button = reorder.createEl("button", { cls: "clickable-icon margin-notes-pdf-palette-move", attr: { type: "button", "aria-label": label } });
				setIcon(button, icon);
				button.disabled = target < 0 || target >= group.colorKeys.length;
				button.addEventListener("click", () => {
					[group.colorKeys[index], group.colorKeys[target]] = [group.colorKeys[target], group.colorKeys[index]];
					commit(); render();
				});
			}
			row.addText((input) => input.setValue(slot.name).onChange((value) => {
				if (value.trim()) { slot.name = value.trim(); commit(); }
			}));
			row.addColorPicker((picker) => picker.setValue(slot.color).onChange((value) => { slot.color = value; commit(); }));
			row.addExtraButton((button) => button.setIcon("trash").setTooltip("移出预设，保留旧批注颜色").onClick(() => {
				// Keep membership in a hidden group so old labels retain their context.
				let retained = settings.colorGroups.find((item) => item.id === `${group.id}-retained`);
				if (!retained) {
					retained = { id: `${group.id}-retained`, name: group.name, colorKeys: [], archived: true };
					settings.colorGroups.push(retained);
				}
				retained.colorKeys.push(slot.id);
				group.colorKeys = group.colorKeys.filter((key) => key !== slot.id); commit(); render();
			}));
		});
	};
	render();
}
