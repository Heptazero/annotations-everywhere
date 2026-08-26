export interface LeaderRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface LeaderPoint {
	x: number;
	y: number;
}

export interface LeaderFraction {
	x: number;
	y: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * Chooses the closest point on all four edges, not just the left/right edge.
 * A diagonal point naturally resolves to a corner; an interior point resolves
 * to whichever edge is nearest.
 */
export function nearestPointOnRect(rect: LeaderRect, point: LeaderPoint): LeaderPoint {
	const x = clamp(point.x, rect.left, rect.right);
	const y = clamp(point.y, rect.top, rect.bottom);
	const outside = point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom;
	if (outside) return { x, y };

	const candidates = [
		{ distance: point.x - rect.left, point: { x: rect.left, y: point.y } },
		{ distance: rect.right - point.x, point: { x: rect.right, y: point.y } },
		{ distance: point.y - rect.top, point: { x: point.x, y: rect.top } },
		{ distance: rect.bottom - point.y, point: { x: point.x, y: rect.bottom } },
	];
	return candidates.reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best)).point;
}

/** Returns adaptive note/anchor endpoints for a four-direction leader line. */
export function adaptiveLeaderEndpoints(
	note: LeaderRect,
	anchor: LeaderRect,
	leaderAt?: LeaderFraction
): { start: LeaderPoint; end: LeaderPoint } {
	const noteCentre = { x: (note.left + note.right) / 2, y: (note.top + note.bottom) / 2 };
	const end = leaderAt
		? {
				x: anchor.left + clamp(leaderAt.x, 0, 1) * (anchor.right - anchor.left),
				y: anchor.top + clamp(leaderAt.y, 0, 1) * (anchor.bottom - anchor.top),
			}
		: nearestPointOnRect(anchor, noteCentre);
	return { start: nearestPointOnRect(note, end), end };
}

/** A collapsed note is one dot, so it never keeps a second arrow endpoint dot. */
export function leaderVisible(collapsed: boolean, override: boolean | undefined, lineMode: boolean): boolean {
	return !collapsed && (override ?? lineMode);
}
