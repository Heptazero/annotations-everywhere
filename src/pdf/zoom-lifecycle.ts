const ZOOM_SETTLE_MS = 140;

/** Coordinates transient pdf.js scale frames without owning rendering logic. */
export class AnnotationZoomLifecycle {
	private timer = 0;
	private activeState = false;
	private settledState = false;

	constructor(
		private isBusy: () => boolean,
		private setHidden: (hidden: boolean) => void,
		private rebuildSettledGeometry: () => boolean
	) {}

	get active(): boolean {
		return this.activeState;
	}

	get settled(): boolean {
		return this.settledState;
	}

	begin(): void {
		if (this.isBusy()) return;
		this.activeState = true;
		this.settledState = false;
		this.setHidden(true);
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.settledState = true;
			if (!this.rebuildSettledGeometry()) this.finish();
		}, ZOOM_SETTLE_MS);
	}

	finishIfSettled(): void {
		if (this.activeState && this.settledState) this.finish();
	}

	finish(): void {
		this.activeState = false;
		this.settledState = false;
		this.setHidden(false);
	}

	destroy(): void {
		window.clearTimeout(this.timer);
		this.finish();
	}
}
