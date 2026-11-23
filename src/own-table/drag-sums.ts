/**
 * The sums for dragging a row or a column by its handle, as Obsidian's table drags them (read from 1.15.1's
 * `createDragHandle` and its edge-scroll helper): plain numbers, so they're tested without a page.
 */

/** How far the pointer moves before a press on a handle is a drag: a press that moves less is a click, which shows its menu. */
export const DRAG_START = 4;

/** Obsidian's edge-scroll speed, in pixels per millisecond at the very edge. */
const SPEED = 2;

/** A box on the screen. */
export interface Box {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/**
 * How far to scroll a box this frame, with the pointer at `x`, `y`, `dt` ms after the last frame: within a band at each
 * edge, a third of the box at most, it scrolls toward that edge, faster the deeper the pointer is, as Obsidian scrolls
 * a note or a table while a handle is dragged. The band is 16 CSS pixels a device pixel ratio, as Obsidian has it.
 */
export function edgeScroll(box: Box, x: number, y: number, dt: number, ratio: number): { dx: number; dy: number } {
	const zone = 16 * ratio;
	const high = Math.min((box.bottom - box.top) / 3, zone);
	const wide = Math.min((box.right - box.left) / 3, zone);
	let dy = 0;
	let dx = 0;
	if (high > 0 && y < box.top + high) dy = (-SPEED * dt * (box.top + high - y)) / high;
	else if (high > 0 && y > box.bottom - high) dy = (SPEED * dt * (y - (box.bottom - high))) / high;
	if (wide > 0 && x < box.left + wide) dx = (-SPEED * dt * (box.left + wide - x)) / wide;
	else if (wide > 0 && x > box.right - wide) dx = (SPEED * dt * (x - (box.right - wide))) / wide;
	return { dx, dy };
}

/** A row's or a column's place along the table, from the table's start: its top, or its left on the screen. */
export interface Extent {
	index: number;
	start: number;
	end: number;
}

/**
 * Where a dragged handle lands: the row or column its middle is over, `at` along the table, kept within the table, as
 * Obsidian has it. The first extent holding it wins. In the space between two cells, where a theme spaces them, the
 * nearer one.
 */
export function landing(extents: readonly Extent[], at: number, size: number): Extent | null {
	const clamped = Math.max(0, Math.min(size, at));
	let nearest: Extent | null = null;
	let away = Infinity;
	for (const extent of extents) {
		if (clamped >= extent.start && clamped <= extent.end) return extent;
		const gap = clamped < extent.start ? extent.start - clamped : clamped - extent.end;
		if (gap < away) {
			nearest = extent;
			away = gap;
		}
	}
	return nearest;
}

/**
 * Where the blue line goes for a landing: on the landing row's or column's near edge, toward where the handle came from,
 * as Obsidian draws it, or nowhere when the handle is let go where it started.
 */
export function targetEdge(land: Extent, origin: number): number | null {
	if (land.index === origin) return null;
	return land.index < origin ? land.start : land.end;
}

/** The columns of a table, from its left, given their widths, the borders' room at its ends, and the space between cells. */
export function columnExtents(widths: readonly number[], border: number, spacing: number, width: number, rtl: boolean): Extent[] {
	const out: Extent[] = [];
	let x = border / 2 + spacing;
	widths.forEach((w, index) => {
		out.push(rtl ? { index, start: width - x - w, end: width - x } : { index, start: x, end: x + w });
		x += w + spacing;
	});
	return rtl ? out.reverse() : out;
}
