import assert from "node:assert/strict";
import { App, Scope } from "obsidian";
import { beginTextEditorNavigationScope, TEXT_EDITOR_NAVIGATION_KEYS } from "../src/pdf/editor-key-scope";

const app = new App();
const release = beginTextEditorNavigationScope(app as never);
assert.equal(app.keymap.stack.length, 1);
const scope = app.keymap.stack[0] as Scope;
assert.deepEqual(
	scope.handlers.map((handler) => handler.key),
	[...TEXT_EDITOR_NAVIGATION_KEYS]
);

let stopped = false;
let prevented = false;
const arrow = scope.handlers.find((handler) => handler.key === "ArrowRight")!;
const handled = arrow.func(
	{
		stopPropagation: () => (stopped = true),
		preventDefault: () => (prevented = true),
	} as never,
	{}
);
assert.equal(handled, true);
assert.equal(stopped, true);
assert.equal(prevented, false);

release();
release();
assert.equal(app.keymap.stack.length, 0);
console.log("editor-key-scope: 5 cases passed");
