export class TFile {
	extension: string;
	basename: string;
	stat: { mtime: number; size: number };

	constructor(
		public path: string,
		mtime = 1,
		size = 1
	) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		this.extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
		this.basename = name.replace(/\.[^.]+$/, "");
		this.stat = { mtime, size };
	}
}

export class TFolder {
	constructor(public path: string) {}
}

export class Component {
	private cleanup: Array<() => void> = [];

	register(callback: () => void): void {
		this.cleanup.push(callback);
	}

	unload(): void {
		for (const callback of this.cleanup.splice(0)) callback();
	}
}

export class FileView {
	file: TFile | null = null;
	viewer?: unknown;
}

export class Scope {
	handlers: Array<{ modifiers: unknown; key: string | null; func: (event: KeyboardEvent, context: unknown) => unknown }> = [];

	constructor(public parent?: Scope) {}

	register(modifiers: unknown, key: string | null, func: (event: KeyboardEvent, context: unknown) => unknown) {
		const handler = { modifiers, key, func };
		this.handlers.push(handler);
		return handler;
	}
}

export class App {
	scope = new Scope();
	keymap = {
		stack: [] as Scope[],
		pushScope: (scope: Scope) => void this.keymap.stack.push(scope),
		popScope: (scope: Scope) => {
			const index = this.keymap.stack.lastIndexOf(scope);
			if (index >= 0) this.keymap.stack.splice(index, 1);
		},
	};
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
	return fn;
}

export async function loadPdfJs(): Promise<never> {
	throw new Error("loadPdfJs is unavailable in unit tests");
}
