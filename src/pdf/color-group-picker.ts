import { setIcon } from "obsidian";
import { activeColorGroup, visibleColorGroups } from "./color-groups";
import type { PdfAnnotationSettings } from "./annotation-settings";

/** Short groups are directly visible in settings; popovers use one compact icon. */
export function appendColorGroupPicker(parent: HTMLElement, settings: PdfAnnotationSettings, onChange: (id: string) => void, iconOnly = false): void {
	const root = parent.createDiv("margin-notes-pdf-color-groups");
	const render = () => {
		root.empty();
		const groups = visibleColorGroups(settings);
		if (groups.length < 2) return;
		const current = activeColorGroup(settings);
		const choose = (id: string) => {
			settings.activeColorGroupId = id;
			onChange(id);
			render();
		};
		if (!iconOnly && groups.length <= 3 && groups.reduce((length, group) => length + group.name.length, 0) <= 24) {
			root.addClass("is-segmented");
			for (const group of groups) {
				const button = root.createEl("button", { text: group.name, attr: { type: "button", "aria-pressed": String(group.id === current.id) } });
				button.toggleClass("is-current", group.id === current.id);
				button.addEventListener("click", () => choose(group.id));
			}
			return;
		}
		root.removeClass("is-segmented");
		const toggle = root.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: `颜色组：${current.name}`, "aria-label": `切换颜色组：${current.name}` } });
		if (iconOnly) setIcon(toggle, "palette");
		else toggle.setText(current.name);
		toggle.addEventListener("click", () => {
			const existing = root.querySelector(".margin-notes-pdf-color-group-menu");
			if (existing) { existing.remove(); return; }
			const menu = root.createDiv("margin-notes-pdf-color-group-menu");
			const search = menu.createEl("input", { attr: { type: "search", placeholder: "搜索颜色组…", "aria-label": "搜索颜色组" } });
			const results = menu.createDiv("margin-notes-pdf-color-group-results");
			const filter = () => {
				results.empty();
				const query = search.value.trim().normalize("NFC").toLocaleLowerCase();
				for (const group of groups) {
					const name = group.name.normalize("NFC").toLocaleLowerCase();
					let cursor = 0;
					for (const ch of name) if (ch === query[cursor]) cursor++;
					if (query && !name.includes(query) && cursor !== query.length) continue;
					const button = results.createEl("button", { text: group.name, attr: { type: "button", "aria-pressed": String(group.id === current.id) } });
					button.toggleClass("is-current", group.id === current.id);
					button.addEventListener("click", () => choose(group.id));
				}
				if (!results.childElementCount) results.createDiv({ text: "没有匹配的颜色组", cls: "setting-item-description" });
			};
			search.addEventListener("input", filter);
			menu.addEventListener("keydown", (event) => {
				event.stopPropagation();
				if (event.key === "Escape") { event.preventDefault(); menu.remove(); toggle.focus(); }
				const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>("button"));
				const index = buttons.findIndex((button) => button === event.target);
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					const next = event.key === "ArrowDown" ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0);
					buttons[next]?.focus();
				}
				if (event.key === "Enter" && event.target === search) { event.preventDefault(); buttons[0]?.click(); }
			});
			filter();
			const bounds = toggle.getBoundingClientRect();
			const size = menu.getBoundingClientRect();
			menu.setCssStyles({ left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - size.width - 8))}px`, top: `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - size.height - 8))}px` });
			search.focus({ preventScroll: true });
		});
	};
	root.addEventListener("focusout", (event) => {
		if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) root.querySelector(".margin-notes-pdf-color-group-menu")?.remove();
	});
	render();
}
