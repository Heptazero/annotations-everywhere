import { Scope, type App } from "obsidian";

/** Keys that belong to a multiline text editor, never to the PDF viewer. */
export const TEXT_EDITOR_NAVIGATION_KEYS = [
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
] as const;

/**
 * Obsidian's Keymap runs before a textarea's bubbling keydown listener. Push a
 * short-lived top scope while editing so PDF navigation never sees caret keys.
 * Returning true consumes the Obsidian binding without preventDefault, leaving
 * the browser's native caret/selection behavior intact.
 */
export function beginTextEditorNavigationScope(app: App): () => void {
	const scope = new Scope(app.scope);
	for (const key of TEXT_EDITOR_NAVIGATION_KEYS) {
		scope.register(null, key, (event) => {
			event.stopPropagation();
			return true;
		});
	}
	app.keymap.pushScope(scope);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		app.keymap.popScope(scope);
	};
}
