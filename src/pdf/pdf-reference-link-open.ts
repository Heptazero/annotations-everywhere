import { TFile, parseLinktext, type App, type Component, type FileView, type Workspace } from "obsidian";
import { parsePdfReferenceSubpath, type PdfReferenceTarget } from "./pdf-reference-target";

/** Keep native pane/page behavior; add exact-region feedback after the native jump. */
export function registerPdfReferenceLinkOpen(app: App, owner: Pick<Component, "register">, onOpen: (view: FileView, target: PdfReferenceTarget) => void): void {
	const workspace = app.workspace;
	// Keep the exact function for restoration; every invocation below supplies its workspace.
	// eslint-disable-next-line @typescript-eslint/unbound-method -- exact identity is needed for cleanup; invoked with original.call(this, ...)
	const original = workspace.openLinkText;
	let active = true;
	const wrapped: typeof original = async function (this: Workspace, linktext, sourcePath, newLeaf, openViewState) {
		await original.call(this, linktext, sourcePath, newLeaf, openViewState);
		if (!active) return;
		const parsed = parseLinktext(linktext);
		const target = parsePdfReferenceSubpath(parsed.subpath);
		if (!target) return;
		const file = app.metadataCache.getFirstLinkpathDest(parsed.path, sourcePath);
		if (!(file instanceof TFile) || file.extension !== "pdf") return;
		const recent = workspace.getMostRecentLeaf();
		const leaf = recent && (recent.view as FileView).file?.path === file.path ? recent
			: workspace.getLeavesOfType("pdf").find((item) => (item.view as FileView).file?.path === file.path);
		if (leaf) onOpen(leaf.view as FileView, target);
	};
	workspace.openLinkText = wrapped;
	owner.register(() => {
		active = false; // remain inert if a later plugin wrapper still calls this closure
		if (workspace.openLinkText === wrapped) workspace.openLinkText = original;
	});
}
