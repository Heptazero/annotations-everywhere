import assert from "node:assert/strict";
import { App } from "obsidian";
import { openPdfReferencePicker } from "../src/pdf/pdf-reference-picker";

// A headless event/geometry double; never opens an app or performs real mouse tests.
class Surface {
	listeners = new Map<string, Set<(event: never) => void>>();
	addEventListener(name: string, handler: (event: never) => void): void {
		if (!this.listeners.has(name)) this.listeners.set(name, new Set());
		this.listeners.get(name)!.add(handler);
	}
	removeEventListener(name: string, handler: (event: never) => void): void { this.listeners.get(name)?.delete(handler); }
	emit(name: string, event: unknown): void { for (const handler of [...this.listeners.get(name) ?? []]) handler(event as never); }
	get listenerCount(): number { return [...this.listeners.values()].reduce((n, handlers) => n + handlers.size, 0); }
}
let focused: ElementDouble;
class ElementDouble extends Surface {
	children: ElementDouble[] = [];
	parent: ElementDouble | null = null;
	value = "";
	styles: Record<string, string> = {};
	isConnected = true;
	scrolled = false;
	constructor(public tag = "div") { super(); }
	createDiv(): ElementDouble { return this.createEl("div"); }
	createEl(tag: string): ElementDouble {
		const child = new ElementDouble(tag); child.parent = this; this.children.push(child); return child;
	}
	get childElementCount(): number { return this.children.length; }
	empty(): void { this.children = []; }
	contains(node: ElementDouble | null): boolean { return node === this || this.children.some((child) => child.contains(node)); }
	querySelectorAll(tag: string): ElementDouble[] { return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
	setCssStyles(value: Record<string, string>): void { Object.assign(this.styles, value); }
	getBoundingClientRect(): { width: number; height: number } { return { width: Math.min(340, Number.parseFloat(this.styles.maxWidth) || 340), height: Math.min(380, Number.parseFloat(this.styles.maxHeight) || 380) }; }
	focus(): void { focused = this; }
	scrollIntoView(): void { this.scrolled = true; }
	remove(): void { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}

const saved = ["document", "window", "HTMLElement"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
try {
	const previous = new ElementDouble("button"); focused = previous;
	const body = new ElementDouble();
	const doc = Object.assign(new Surface(), { body });
	Object.defineProperty(doc, "activeElement", { get: () => focused });
	const visual = Object.assign(new Surface(), { offsetLeft: 0, offsetTop: 0, width: 375, height: 700 });
	const win = Object.assign(new Surface(), { innerWidth: 1024, innerHeight: 800, visualViewport: visual });
	Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
	Object.defineProperty(globalThis, "window", { configurable: true, value: win });
	Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: ElementDouble });
	const app = new App(); let closed = 0;
	const close = openPdfReferencePicker(app, [1, 2, 3].map((line) => ({ sourcePath: "note.md", line, ch: 0, link: "a", target: { page: 1 } })), { x: 350, y: 650 }, () => assert.fail("keyboard navigation must not choose a source"), () => closed++);
	const picker = body.children[0], input = picker.querySelectorAll("input")[0];
	const buttons = picker.querySelectorAll("button");
	assert.equal(focused, input);
	assert.equal(app.keymap.stack.length, 1);
	const key = (value: string, composing = false) => ({ key: value, target: focused, isComposing: composing, preventDefault() {}, stopPropagation() {} });
	const down = key("ArrowDown");
	doc.emit("keydown", down);
	assert.equal(focused, buttons[0]);
	app.keymap.stack[0].handlers.find((handler) => handler.key === "ArrowDown")!.func(down as never, undefined);
	assert.equal(focused, buttons[0], "same physical key must not run once via document and again via Scope");
	doc.emit("keydown", key("End")); assert.equal(focused, buttons[2]);
	input.focus(); doc.emit("keydown", key("ArrowUp")); assert.equal(focused, buttons[2]);
	assert.equal(buttons[2].scrolled, true);
	visual.height = 200; visual.offsetTop = 100; visual.emit("resize", {});
	assert.equal(picker.styles.maxHeight, "184px"); assert.equal(picker.styles.top, "108px");
	doc.emit("keydown", key("Escape", true)); assert.equal(closed, 0, "IME dismissal isn't popup dismissal");
	doc.emit("keydown", key("Escape"));
	assert.equal(focused, previous);
	assert.equal(closed, 1); assert.equal(app.keymap.stack.length, 0);
	assert.equal(doc.listenerCount + win.listenerCount + visual.listenerCount, 0);
	close(); assert.equal(closed, 1, "cleanup is idempotent");
	const closeAgain = openPdfReferencePicker(app, [], { x: 0, y: 0 }, () => assert.fail("empty list"), () => closed++);
	const nextPicker = body.children[0];
	doc.emit("keydown", key("ArrowDown")); assert.equal(closed, 1, "an empty list can keep keyboard focus");
	nextPicker.emit("focusout", { relatedTarget: previous });
	assert.equal(closed, 2); assert.equal(app.keymap.stack.length, 0);
	assert.equal(doc.listenerCount + win.listenerCount + visual.listenerCount, 0);
	closeAgain(); assert.equal(closed, 2);
} finally {
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
}
console.log("reference-picker: headless Scope deduplication, keyboard/IME, keyboard viewport and listener cleanup passed");
