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

/**
 * Where a table and what pins it lie on the screen, for a drag across its cells (cell-drag.ts). `pane` is the note's pane,
 * its bottom above the status bar where that floats over it; `table` the table as laid out, its top and bottom where its
 * rows run without pinning, its sides where its slide puts them; `box` the box that clips it sideways. `rows` is where the
 * pinned rows cover the pane, from where rows pin to their bottom, only while they're pinned, and `strip` the frozen
 * columns' inner edge, only while they pin.
 */
export interface DragArea {
	pane: Box;
	table: Box;
	box: { left: number; right: number };
	rows: { top: number; bottom: number } | null;
	strip: number | null;
	rtl: boolean;
}

/**
 * Where to look for the cell under the pointer: the pointer kept a pixel inside the part of the table on the screen, so a
 * pointer past the table's edge takes the nearest cell in its row or column, and one above the pinned rows, in the band
 * left for their grips, takes the pinned header.
 */
export function lookAt(area: DragArea, x: number, y: number): { x: number; y: number } {
	const { pane, table, box, rows } = area;
	const top = Math.max(table.top, pane.top, rows?.top ?? -Infinity) + 1;
	const bottom = Math.min(table.bottom, pane.bottom) - 1;
	const left = Math.max(table.left, box.left, pane.left) + 1;
	const right = Math.min(table.right, box.right, pane.right) - 1;
	return { x: Math.max(left, Math.min(right, x)), y: top > bottom ? top : Math.max(top, Math.min(bottom, y)) };
}

/** Whether a place is on what pins: the pinned rows, or the frozen columns' strip. */
export function overPinned(area: DragArea, x: number, y: number): boolean {
	const { rows, strip, rtl } = area;
	if (rows && y >= rows.top && y < rows.bottom) return true;
	return strip !== null && (rtl ? x > strip : x < strip);
}

/**
 * How far a drag across cells scrolls this frame: the note near the pane's bottom, or just under the pinned rows (the pane's
 * top with none pinned), and the table near its box's sides, or just beside the frozen columns, at the speeds a dragged
 * handle scrolls at (`edgeScroll`), the fastest once the pointer is past the edge. A pointer on what pins scrolls nothing
 * that way, and the note scrolls only while there are rows of the table beyond the pane that way.
 */
export function zoneScroll(area: DragArea, x: number, y: number, dt: number, ratio: number): { dx: number; dy: number } {
	const { pane, table, box, rows, strip, rtl } = area;
	const top = rows ? rows.bottom : pane.top;
	let dy = 0;
	if (!(rows && y < rows.bottom)) {
		const at = Math.max(top, Math.min(pane.bottom, y));
		dy = edgeScroll({ top, bottom: pane.bottom, left: 0, right: 0 }, 0, at, dt, ratio).dy;
		if (dy > 0 && table.bottom <= pane.bottom) dy = 0;
		if (dy < 0 && !rows && table.top >= pane.top) dy = 0;
	}
	const left = !rtl && strip !== null ? strip : box.left;
	const right = rtl && strip !== null ? strip : box.right;
	const onStrip = strip !== null && (rtl ? x > strip : x < strip);
	const dx = onStrip ? 0 : edgeScroll({ top: 0, bottom: 0, left, right }, Math.max(left, Math.min(right, x)), 0, dt, ratio).dx;
	return { dx, dy };
}

/** What a click on a cell that's already there knows: how many quick clicks it is, and the cell's state. */
export interface CellClick {
	/** The setting *Click to select a cell*: a click selects a cell, and a double-click opens it. */
	selects: boolean;
	/** The click's count: 2 for a double-click's second. */
	count: number;
	/** The cell clicked is the open cell. */
	open: boolean;
	/** The cell clicked is the selected cell, alone, not part of a range. */
	selectedAlone: boolean;
}

/**
 * Whether a click on a cell of the plugin's table opens it, or only selects it. With the setting on, a click selects
 * the cell, and opens it only as a double-click, on the cell already selected alone (as in Numbers, which also covers
 * a slow double-click), or on the open cell, which stays open. With it off, every click opens, as in Obsidian.
 */
export function clickOpens({ selects, count, open, selectedAlone }: CellClick): boolean {
	return !selects || count > 1 || open || selectedAlone;
}
