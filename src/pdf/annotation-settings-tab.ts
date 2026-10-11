import { App, Notice, PluginSettingTab, Setting, setIcon, type Plugin } from "obsidian";
import {
	DEFAULT_PDF_ANNOTATION_SETTINGS,
	HIGHLIGHT_MODE_LABELS,
	type HighlightMode,
	type PdfAnnotationSettings,
} from "./annotation-settings";
import { makeAnnotationLayerId } from "./annotation-layers";
import { resolveDataFilePath } from "./annotation-store";
import { FolderPathSuggest } from "./folder-path-suggest";
import type { PdfAnnotationsController } from "./controller";
import { LayerDeleteModal } from "./layer-delete-modal";
import { AnnotationPropertySyncModal } from "./annotation-property-sync-modal";
import { normalizeAnnotationPropertyName } from "./source-annotation-sync";
import { renderColorGroupSettings } from "./color-group-settings";
import { createSettingsLayout, renderSettingChoice, type SettingsLayoutState } from "./settings-layout";
import { renderReferenceSettings } from "./pdf-reference-settings";

export class PdfAnnotationSettingTab extends PluginSettingTab {
	private folderPathSuggest: FolderPathSuggest | null = null;
	private layoutState: SettingsLayoutState = { page: "common", open: {} };

	constructor(
		app: App,
		plugin: Plugin,
		private controller: PdfAnnotationsController
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		this.folderPathSuggest?.close();
		this.folderPathSuggest = null;
		containerEl.empty();

		const settings: PdfAnnotationSettings = {
			...this.controller.settings,
			palette: this.controller.settings.palette.map((slot) => ({ ...slot })),
			colorGroups: this.controller.settings.colorGroups.map((group) => ({ ...group, colorKeys: [...group.colorKeys] })),
			layers: this.controller.settings.layers.map((layer) => ({ ...layer })),
		};
		const commit = () => void this.controller.saveSettings(settings);
		const layout = createSettingsLayout(containerEl, this.layoutState);
		const selectionSection = layout.section("selection", "划词工具栏", "common");
		const colorSection = layout.section("colors", "颜色与语义组", "common");
		const referenceSection = layout.section("references", "引用标记", "references");
		const templateSection = layout.section("templates", "复制格式", "references");
		const railsSection = layout.section("rails", "左右轨道", "appearance");
		const appearanceSection = layout.section("notes", "批注外观", "appearance");
		const highlightSection = layout.section("highlights", "普通批注高亮", "appearance");
		const dataSection = layout.section("data", "批注数据", "management");
		const syncSection = layout.section("sync", "笔记属性同步", "management");
		const layerSection = layout.section("layers", "批注图层", "management");
		let pendingDataPath = settings.dataPath;

		const pathSetting = new Setting(dataSection)
			.setName("批注存放位置")
			.setDesc(
				"搜索并选择库内文件夹，也可以填写新文件夹路径；电脑和手机须一致。" +
					"旧格式使用 annotations.json；分文件格式使用同目录的 revisions 文件夹。点击「应用位置」后才更改。"
			)
			.setClass("margin-notes-pdf-data-path-setting")
			.addText((t) => {
				t
					.setPlaceholder(DEFAULT_PDF_ANNOTATION_SETTINGS.dataPath)
					.setValue(settings.dataPath)
					.onChange((v) => {
						pendingDataPath = v.trim();
						resolved.setText(pendingDataPath
							? `待应用：${resolveDataFilePath(pendingDataPath)}`
							: "请输入文件夹路径");
					});
				t.inputEl.setAttribute("aria-label", "搜索库内文件夹路径");
				this.folderPathSuggest = new FolderPathSuggest(this.app, t.inputEl, settings.dataPath, (path) => {
					pendingDataPath = path;
					resolved.setText(`待应用：${resolveDataFilePath(path)}`);
				});
			})
			.addButton((button) => button.setButtonText("应用位置").onClick(async () => {
				if (!pendingDataPath) {
					new Notice("请输入库内文件夹路径");
					return;
				}
				if (pendingDataPath.toLowerCase().endsWith(".json") && pendingDataPath !== settings.dataPath) {
					new Notice("请填写文件夹路径，不要填写 annotations.json 文件名");
					return;
				}
				if (/^(?:\/|[A-Za-z]:[\\/])/.test(pendingDataPath) || pendingDataPath.split(/[\\/]/).includes("..")) {
					new Notice("请填写库内相对文件夹路径");
					return;
				}
				const previous = settings.dataPath;
				settings.dataPath = pendingDataPath;
				try {
					await this.controller.saveSettings(settings);
					resolved.setText(this.controller.store.usesRevisionFiles
						? `修订目录：${this.controller.store.revisionFolder}`
						: `实际文件：${this.controller.store.filePath}`);
					await refreshDataStatus();
				} catch (error) {
					settings.dataPath = previous;
					new Notice(`批注位置未更改：${String(error instanceof Error ? error.message : error)}`);
				}
			}));
		const resolved = pathSetting.descEl.createDiv({ cls: "setting-item-description" });
		resolved.setText(this.controller.store.usesRevisionFiles
			? `修订目录：${this.controller.store.revisionFolder}`
			: `实际文件：${this.controller.store.filePath}`);
		const dataStatus = pathSetting.descEl.createDiv({ cls: "setting-item-description" });
		const refreshDataStatus = async (): Promise<void> => {
			if (this.controller.store.waitingForRevisionFiles) {
				dataStatus.setText("分文件批注基线尚未同步完成；当前暂停写入");
				return;
			}
			const path = this.controller.store.filePath;
			const exists = await this.app.vault.adapter.exists(path);
			dataStatus.setText(exists
				? `数据文件已找到；已载入 ${this.controller.store.totalAnnotationCount} 条批注${this.controller.store.usesRevisionFiles ? "；分文件模式" : ""}`
				: "数据文件尚未同步到此设备；请检查同步后重新打开设置");
		};
		void refreshDataStatus();

		new Setting(selectionSection)
			.setName("手机划词后显示批注工具栏")
			.setDesc("选中文字后显示一排预设颜色和添加批注按钮。颜色在下方「预设颜色」中设置；关闭工具栏不会保存。")
			.addToggle((toggle) => toggle.setValue(settings.mobileSelectionPalette).onChange((value) => {
				settings.mobileSelectionPalette = value;
				commit();
			}));
		new Setting(selectionSection)
			.setName("电脑划词后显示批注工具栏")
			.setDesc("鼠标选中文字或用键盘调整选区后，显示与手机相同的工具栏。")
			.addToggle((toggle) => toggle.setValue(settings.desktopSelectionPalette).onChange((value) => {
				settings.desktopSelectionPalette = value;
				commit();
			}));

		renderReferenceSettings(referenceSection, templateSection, settings, commit);

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

		new Setting(syncSection)
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

		new Setting(syncSection)
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

		const layerHeader = new Setting(layerSection)
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
		const layerRows = layerSection.createDiv("margin-notes-pdf-layer-settings");
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

		railsSection.createEl("p", {
			cls: "setting-item-description",
			text:
				"「固定」的批注不是自己记住位置,而是排在页面左右两条轨道里——所以轨道的宽度和" +
				"离页面的距离是这一条轨道自己的设置,左右两侧互不影响。单位都是 PDF 点" +
				"(100% 缩放时的像素),会跟着页面一起缩放,不会因为你放大缩小而变形。",
		});

		new Setting(railsSection).setName("左侧轨道").setHeading();

		new Setting(railsSection)
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

		new Setting(railsSection)
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

		new Setting(railsSection).setName("右侧轨道").setHeading();

		new Setting(railsSection)
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

		new Setting(railsSection)
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

		new Setting(appearanceSection)
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

		new Setting(appearanceSection)
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

		new Setting(appearanceSection)
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

		highlightSection.createEl("p", {
			cls: "setting-item-description",
			text:
				"高亮指的是批注在原文上对应的那一段文字/区域。高亮的颜色跟随批注自己的颜色," +
				"所以同一页上有多条批注时,一眼就能看出哪条对应哪段。",
		});

		const highlightChoice = new Setting(highlightSection)
			.setName("显示方式")
			.setDesc("也可以用命令面板里的「切换高亮显示方式」随时改。");
		renderSettingChoice<HighlightMode>(highlightChoice.controlEl, "高亮显示方式", (Object.entries(HIGHLIGHT_MODE_LABELS) as [HighlightMode, string][]).map(([value, label]) => ({ value, label })), settings.highlightMode, (value) => {
			settings.highlightMode = value; commit();
		});

		new Setting(highlightSection)
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

		renderColorGroupSettings(colorSection, this.app, settings, commit);

		new Setting(colorSection).setName("轨道批注颜色").addColorPicker((c) =>
			c.setValue(settings.railColor).onChange((v) => {
				settings.railColor = v;
				commit();
			})
		);

		new Setting(colorSection).setName("自由批注颜色").addColorPicker((c) =>
			c.setValue(settings.freeColor).onChange((v) => {
				settings.freeColor = v;
				commit();
			})
		);
		layout.refresh();
	}

	hide(): void {
		this.folderPathSuggest?.close();
		this.folderPathSuggest = null;
		super.hide();
	}
}
