import { App, Notice, PluginSettingTab, Setting, setIcon, type Plugin } from "obsidian";
import {
	DEFAULT_PDF_ANNOTATION_SETTINGS,
	HIGHLIGHT_MODE_LABELS,
	makeColorSlotId,
	type HighlightMode,
	type PdfAnnotationSettings,
} from "./annotation-settings";
import { makeAnnotationLayerId } from "./annotation-layers";
import { resolveDataFilePath } from "./annotation-store";
import type { PdfAnnotationsController } from "./controller";
import { LayerDeleteModal } from "./layer-delete-modal";
import { AnnotationPropertySyncModal } from "./annotation-property-sync-modal";
import { normalizeAnnotationPropertyName } from "./source-annotation-sync";

export class PdfAnnotationSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private controller: PdfAnnotationsController
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings: PdfAnnotationSettings = {
			...this.controller.settings,
			palette: this.controller.settings.palette.map((slot) => ({ ...slot })),
			layers: this.controller.settings.layers.map((layer) => ({ ...layer })),
		};
		const commit = () => void this.controller.saveSettings(settings);

		containerEl.createEl("h3", { text: "批注数据" });

		const pathSetting = new Setting(containerEl)
			.setName("批注存放位置")
			.setDesc(
				"库内相对路径。填文件夹就在里面放 annotations.json,填以 .json 结尾的路径就用这个文件。" +
					"放在库里(而不是插件目录)才能跟着 git / Obsidian Sync / iCloud 同步——本库的 .gitignore 排除了整个 .obsidian/plugins/。"
			)
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_PDF_ANNOTATION_SETTINGS.dataPath)
					.setValue(settings.dataPath)
					.onChange((v) => {
						const next = v.trim();
						if (!next) return;
						settings.dataPath = next;
						commit();
						resolved.setText(`实际文件:${resolveDataFilePath(next)}`);
					})
			);
		const resolved = pathSetting.descEl.createDiv({ cls: "setting-item-description" });
		resolved.setText(`实际文件:${this.controller.store.filePath}`);

		const previewSync = (enableAfterConfirm: boolean): void => {
			const property = normalizeAnnotationPropertyName(settings.annotationPropertyName);
			settings.annotationPropertyName = property;
			const changes = this.controller.annotationPropertySync.plan(property);
			const finishEnable = async (): Promise<void> => {
				if (!enableAfterConfirm) return;
				settings.syncAnnotationProperty = true;
				await this.controller.saveSettings(settings);
				this.display();
			};

			if (changes.length === 0) {
				void finishEnable();
				new Notice("批注属性已经同步，没有笔记需要修改");
				return;
			}

			new AnnotationPropertySyncModal(
				this.app,
				changes,
				async (confirmed) => {
					if (enableAfterConfirm) {
						settings.syncAnnotationProperty = true;
						await this.controller.saveSettings(settings);
					}
					return this.controller.annotationPropertySync.apply(confirmed);
				},
				(result) => {
					new Notice(`已同步 ${result.updated} 篇笔记${result.skipped > 0 ? `，跳过 ${result.skipped} 篇已变化的笔记` : ""}`);
					this.display();
				}
			).open();
		};

		new Setting(containerEl)
			.setName("同步批注状态到 source 笔记")
			.setDesc("只按 Markdown 的 source 双链查找 PDF。有批注时写入 true；最后一条批注删除后移除属性。首次开启会先预览全部改动。")
			.addToggle((toggle) => {
				toggle.setValue(settings.syncAnnotationProperty).onChange(async (value) => {
					if (!value) {
						settings.syncAnnotationProperty = false;
						await this.controller.saveSettings(settings);
						this.display();
						return;
					}
					toggle.setValue(false);
					previewSync(true);
				});
			});

		new Setting(containerEl)
			.setName("批注属性名")
			.setDesc(settings.syncAnnotationProperty ? "关闭自动同步后才能修改属性名。" : "布尔属性；默认 has_annotations。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_PDF_ANNOTATION_SETTINGS.annotationPropertyName)
					.setValue(settings.annotationPropertyName)
					.setDisabled(settings.syncAnnotationProperty)
					.onChange((value) => {
						const next = value.trim();
						if (!next || settings.syncAnnotationProperty) return;
						if (normalizeAnnotationPropertyName(next) !== next) {
							new Notice("这个属性名无效；source 是资源关系字段，不能覆盖");
							return;
						}
						settings.annotationPropertyName = next;
						commit();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("预览并同步")
					.setDisabled(!settings.syncAnnotationProperty)
					.onClick(() => previewSync(false))
			);

		const layerHeader = new Setting(containerEl)
			.setName("批注图层")
			.setDesc("一条批注可同时属于多个图层；正文只保存一份，在任何图层修改都会同步。")
			.addButton((button) =>
				button.setButtonText("添加图层").onClick(() => {
					settings.layers = [
						...settings.layers,
						{
							id: makeAnnotationLayerId(settings.layers.map((layer) => layer.id)),
							name: `图层 ${settings.layers.length + 1}`,
						},
					];
					commit();
					renderLayerRows();
				})
			);
		layerHeader.controlEl.addClass("margin-notes-pdf-palette-add");
		const layerRows = containerEl.createDiv("margin-notes-pdf-layer-settings");
		const renderLayerRows = () => {
			layerRows.empty();
			settings.layers.forEach((layer, index) => {
				const row = new Setting(layerRows).setName(`图层 ${index + 1}`);
				const reorder = row.nameEl.createSpan({ cls: "margin-notes-pdf-palette-reorder" });
				row.nameEl.prepend(reorder);
				const addMoveButton = (icon: string, tooltip: string, targetIndex: number) => {
					const disabled = targetIndex < 0 || targetIndex >= settings.layers.length;
					const button = reorder.createEl("button", {
						cls: "clickable-icon margin-notes-pdf-palette-move",
						attr: { type: "button", "aria-label": tooltip, "aria-disabled": String(disabled) },
					});
					setIcon(button, icon);
					button.disabled = disabled;
					if (disabled) return;
					button.addEventListener("click", () => {
						const next = [...settings.layers];
						[next[index], next[targetIndex]] = [next[targetIndex], next[index]];
						settings.layers = next;
						commit();
						renderLayerRows();
					});
				};
				addMoveButton("arrow-up", "上移这个图层", index - 1);
				addMoveButton("arrow-down", "下移这个图层", index + 1);
				row.addText((input) =>
					input
						.setPlaceholder(`图层 ${index + 1}`)
						.setValue(layer.name)
						.onChange((value) => {
							const name = value.trim();
							if (!name) return;
							settings.layers[index] = { ...settings.layers[index], name };
							commit();
						})
				);
				row.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("删除图层；批注保留")
						.onClick(() =>
							new LayerDeleteModal(this.app, layer.name, () => {
								settings.layers = settings.layers.filter((item) => item.id !== layer.id);
								commit();
								this.controller.store.detachLayerId(layer.id);
								renderLayerRows();
							}).open()
						)
				);
			});
		};
		renderLayerRows();

		containerEl.createEl("h3", { text: "外观" });

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"「固定」的批注不是自己记住位置,而是排在页面左右两条轨道里——所以轨道的宽度和" +
				"离页面的距离是这一条轨道自己的设置,左右两侧互不影响。单位都是 PDF 点" +
				"(100% 缩放时的像素),会跟着页面一起缩放,不会因为你放大缩小而变形。",
		});

		new Setting(containerEl).setName("左侧轨道").setHeading();

		new Setting(containerEl)
			.setName("轨道宽度")
			.setDesc("左侧所有固定批注的宽度。也可以直接拖批注框远离页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(50, 500, 5)
					.setValue(settings.railWidthLeft)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railWidthLeft = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("轨道离页面的距离")
			.setDesc("负数会把轨道压到页面上。也可以直接拖批注框朝向页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(-200, 300, 5)
					.setValue(settings.railGapLeft)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railGapLeft = v;
						commit();
					})
			);

		new Setting(containerEl).setName("右侧轨道").setHeading();

		new Setting(containerEl)
			.setName("轨道宽度")
			.setDesc("右侧所有固定批注的宽度。也可以直接拖批注框远离页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(50, 500, 5)
					.setValue(settings.railWidthRight)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railWidthRight = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("轨道离页面的距离")
			.setDesc("负数会把轨道压到页面上。也可以直接拖批注框朝向页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(-200, 300, 5)
					.setValue(settings.railGapRight)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railGapRight = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("基准字号(px)")
			.setDesc("100% 缩放时的字号,所有批注都以此为基准跟着 PDF 一起缩放。单条批注可以用它自己的菜单再单独调。")
			.addSlider((s) =>
				s
					.setLimits(6, 28, 1)
					.setValue(settings.fontSize)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.fontSize = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("不透明度(%)")
			.setDesc("鼠标悬停或编辑时始终不透明。")
			.addSlider((s) =>
				s
					.setLimits(30, 100, 1)
					.setValue(settings.opacity)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.opacity = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("收起点直径(px)")
			.setDesc("批注收起后圆点的屏幕直径。PDF 放大或缩小时保持不变。")
			.addSlider((s) =>
				s
					.setLimits(6, 18, 1)
					.setValue(settings.dotSize)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.dotSize = v;
						commit();
					})
			);

		new Setting(containerEl).setName("高亮").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"高亮指的是批注在原文上对应的那一段文字/区域。高亮的颜色跟随批注自己的颜色," +
				"所以同一页上有多条批注时,一眼就能看出哪条对应哪段。",
		});

		new Setting(containerEl)
			.setName("显示方式")
			.setDesc("也可以用命令面板里的「切换高亮显示方式」随时改。")
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(HIGHLIGHT_MODE_LABELS)) d.addOption(value, label);
				d.setValue(settings.highlightMode).onChange((v) => {
					settings.highlightMode = v as HighlightMode;
					commit();
				});
			});

		new Setting(containerEl)
			.setName("高亮不透明度(%)")
			.setDesc("只影响原文上的色块和指示线,不影响批注本身的不透明度。")
			.addSlider((s) =>
				s
					.setLimits(5, 100, 1)
					.setValue(settings.highlightOpacity)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.highlightOpacity = v;
						commit();
					})
			);

		const paletteHeader = new Setting(containerEl)
			.setName("命名颜色")
			.setDesc(
				"批注保存颜色名称对应的稳定标识。以后修改名称或色值，所有使用它的批注一起更新；" +
					"用上下箭头调整顺序，批注列表按颜色分组时也采用此顺序。"
			)
			.addButton((button) =>
				button.setButtonText("添加颜色").onClick(() => {
					settings.palette = [
						...settings.palette,
						{
							id: makeColorSlotId(settings.palette.map((slot) => slot.id)),
							name: `颜色 ${settings.palette.length + 1}`,
							color: "#808080",
						},
					];
					commit();
					renderPaletteRows();
				})
			);
		paletteHeader.controlEl.addClass("margin-notes-pdf-palette-add");
		const paletteRows = containerEl.createDiv("margin-notes-pdf-palette-settings");
		const renderPaletteRows = () => {
			paletteRows.empty();
			settings.palette.forEach((slot, index) => {
				const row = new Setting(paletteRows).setName(`颜色 ${index + 1}`);
				const reorder = row.nameEl.createSpan({ cls: "margin-notes-pdf-palette-reorder" });
				row.nameEl.prepend(reorder);
				const addMoveButton = (icon: string, tooltip: string, targetIndex: number) => {
					const disabled = targetIndex < 0 || targetIndex >= settings.palette.length;
					const button = reorder.createEl("button", {
						cls: "clickable-icon margin-notes-pdf-palette-move",
						attr: { type: "button", "aria-label": tooltip, "aria-disabled": String(disabled) },
					});
					setIcon(button, icon);
					button.disabled = disabled;
					if (disabled) return;
					button.addEventListener("click", () => {
						const next = [...settings.palette];
						[next[index], next[targetIndex]] = [next[targetIndex], next[index]];
						settings.palette = next;
						commit();
						renderPaletteRows();
					});
				};
				addMoveButton("arrow-up", "上移这个颜色", index - 1);
				addMoveButton("arrow-down", "下移这个颜色", index + 1);
				row.addText((input) =>
					input
						.setPlaceholder(`颜色 ${index + 1}`)
						.setValue(slot.name)
						.onChange((value) => {
							const name = value.trim();
							if (!name) return;
							settings.palette[index] = { ...settings.palette[index], name };
							commit();
						})
				);
				row.addColorPicker((picker) =>
					picker.setValue(slot.color).onChange((value) => {
						settings.palette[index] = { ...settings.palette[index], color: value };
						commit();
					})
				);
				if (settings.palette.length > 1) {
					row.addExtraButton((button) =>
						button.setIcon("trash").setTooltip("删除这个预设颜色").onClick(() => {
							this.controller.store.detachColorKey(slot.id);
							settings.palette = settings.palette.filter((_, i) => i !== index);
							commit();
							renderPaletteRows();
						})
					);
				}
			});
		};
		renderPaletteRows();

		new Setting(containerEl).setName("轨道批注颜色").addColorPicker((c) =>
			c.setValue(settings.railColor).onChange((v) => {
				settings.railColor = v;
				commit();
			})
		);

		new Setting(containerEl).setName("自由批注颜色").addColorPicker((c) =>
			c.setValue(settings.freeColor).onChange((v) => {
				settings.freeColor = v;
				commit();
			})
		);
	}
}
