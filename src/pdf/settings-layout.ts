import { Menu, Setting, prepareFuzzySearch, setIcon } from "obsidian";

export type SettingsPage = "common" | "references" | "appearance" | "management";
export interface SettingsLayoutState { page: SettingsPage; open: Record<string, boolean> }
const PAGES: { id: SettingsPage; name: string }[] = [
	{ id: "common", name: "常用" }, { id: "references", name: "引用" },
	{ id: "appearance", name: "外观" }, { id: "management", name: "管理" },
];

/** Presentation only: no showcase demo state, data migration or extra product features. */
export function createSettingsLayout(container: HTMLElement, state: SettingsLayoutState): { section(id: string, title: string, page: SettingsPage): HTMLElement; refresh(): void } {
	const root = container.createDiv("margin-notes-settings-root");
	new Setting(root).setName("批注设置").setHeading();
	const search = root.createDiv("margin-notes-settings-search");
	setIcon(search.createSpan(), "search");
	const input = search.createEl("input", { attr: { type: "search", placeholder: "搜索设置…", "aria-label": "搜索设置" } });
	const clear = search.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: "清除搜索", "aria-label": "清除搜索" } });
	setIcon(clear, "x");
	const tabs = root.createDiv({ cls: "margin-notes-settings-tabs", attr: { role: "tablist", "aria-label": "设置分类" } });
	const panel = root.createDiv("margin-notes-settings-panel");
	panel.id = "margin-notes-settings-panel";
	const empty = root.createDiv({ cls: "setting-item-description", text: "没有匹配的设置" });
	const sections: { el: HTMLDetailsElement; body: HTMLElement; page: SettingsPage; id: string }[] = [];
	const buttons = new Map<SettingsPage, HTMLButtonElement>();
	const refresh = () => {
		const query = input.value.trim();
		panel.setAttribute("role", query ? "region" : "tabpanel");
		panel.setAttribute("aria-label", query ? "搜索结果" : PAGES.find((page) => page.id === state.page)!.name);
		const match = prepareFuzzySearch(query.normalize("NFC"));
		tabs.hidden = !!query; clear.hidden = !query;
		let visible = 0;
		for (const section of sections) {
			const text = section.el.textContent?.normalize("NFC") ?? "";
			section.el.hidden = query ? !match(text) : section.page !== state.page;
			if (!section.el.hidden) visible++;
			section.el.open = query ? true : state.open[section.id] ?? true;
		}
		empty.hidden = visible > 0;
		for (const [id, button] of buttons) {
			button.setAttribute("aria-selected", String(state.page === id));
			button.tabIndex = state.page === id ? 0 : -1;
		}
	};
	for (const page of PAGES) {
		const button = tabs.createEl("button", { text: page.name, attr: { type: "button", role: "tab", "aria-controls": panel.id } });
		buttons.set(page.id, button);
		button.addEventListener("click", () => { state.page = page.id; refresh(); });
		button.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			const next = PAGES[(PAGES.findIndex((item) => item.id === page.id) + (event.key === "ArrowRight" ? 1 : -1) + PAGES.length) % PAGES.length];
			state.page = next.id; refresh(); buttons.get(next.id)?.focus();
		});
	}
	input.addEventListener("input", refresh);
	clear.addEventListener("click", () => { input.value = ""; refresh(); input.focus(); });
	input.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; refresh(); } });
	return { refresh, section: (id, title, page) => {
		const el = panel.createEl("details", { cls: "margin-notes-settings-section" });
		const summary = el.createEl("summary");
		new Setting(summary).setName(title).setHeading();
		const body = el.createDiv("margin-notes-settings-section-body");
		sections.push({ el, body, page, id });
		el.open = state.open[id] ?? true;
		el.addEventListener("toggle", () => { if (!input.value.trim() && !el.hidden) state.open[id] = el.open; });
		return body;
	} };
}

export function renderSettingChoice<T extends string>(host: HTMLElement, label: string, choices: readonly { value: T; label: string }[], initial: T, change: (value: T) => void): void {
	let value = initial;
	if (choices.length <= 3) {
		const group = host.createDiv({ cls: "margin-notes-settings-segmented", attr: { role: "group", "aria-label": label } });
		for (const choice of choices) {
			const button = group.createEl("button", { text: choice.label, attr: { type: "button", "aria-pressed": String(choice.value === value) } });
			button.addEventListener("click", () => {
				value = choice.value;
				for (const item of group.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button));
				change(value);
			});
		}
		return;
	}
	const button = host.createEl("button", { cls: "margin-notes-settings-choice", attr: { type: "button", "aria-label": label, "aria-haspopup": "menu" } });
	const update = () => { button.setText(choices.find((choice) => choice.value === value)?.label ?? value); };
	button.addEventListener("click", () => {
		const menu = new Menu();
		for (const choice of choices) menu.addItem((item) => item.setTitle(choice.label).setChecked(choice.value === value).onClick(() => { value = choice.value; update(); change(value); }));
		const bounds = button.getBoundingClientRect(); menu.showAtPosition({ x: bounds.left, y: bounds.bottom });
	});
	update();
}
