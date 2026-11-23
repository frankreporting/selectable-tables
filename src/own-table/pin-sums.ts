import type { Freeze } from '../editor/freeze-mark';

/**
 * The sums behind frozen rows and columns in the plugin's table, apart from the page so they can be tested. Rows pin
 * with plain `position: sticky`, since on a computer no box scrolls the table sideways (bar.ts). The frozen columns
 * are a strip beside the table, which doesn't take the table's sideways move.
 */

/** What a table freezes, within its size: a freeze of more rows or columns than it has freezes them all. */
export function frozenIn(freeze: Freeze, rows: number, columns: number): Freeze {
	return { rows: Math.max(0, Math.min(freeze.rows, rows)), columns: Math.max(0, Math.min(freeze.columns, columns)) };
}

/** Where each frozen row sticks, down from where rows pin: the header at 0, and each row after it below those before. */
export function stickyTops(heights: readonly number[]): number[] {
	const tops: number[] = [];
	let at = 0;
	for (const height of heights) {
		tops.push(at);
		at += height;
	}
	return tops;
}

export interface FitSizes {
	/** The frozen rows' height together. */
	rows: number;
	/** The table's height, its frozen rows included. */
	table: number;
	/** The pane's height. */
	pane: number;
	/** The frozen columns' width together. */
	columns: number;
	/** The width the table's box has for it. */
	room: number;
	/** Whether the table moves sideways: frozen columns only matter for a table wider than its box. */
	slides: boolean;
}

/**
 * Pins only what leaves room, as for Obsidian's table: rows taller than half the pane, or columns as wide as the
 * table's box, would fill it, with nothing able to pass under them.
 */
export function pinsFit(freeze: Freeze, sizes: FitSizes): { rows: boolean; columns: boolean } {
	return {
		rows: freeze.rows > 0 && sizes.rows > 0 && sizes.table > sizes.rows && sizes.rows * 2 <= sizes.pane,
		columns: freeze.columns > 0 && sizes.slides && sizes.columns > 0 && sizes.columns < sizes.room,
	};
}

export interface RailBlock {
	first: boolean;
	last: boolean;
	/** Where the block's table starts and ends, down from the block's top. */
	tableTop: number;
	tableBottom: number;
	/** The block's own height. */
	height: number;
}

/**
 * Where a block's copy of the frozen rows can ride, as the `top` and `bottom` of its rail in the block, for rows
 * `pinned` px tall together, with a shadow `shade` px deep under them. The copy has no height and sticks where rows
 * pin, so it's there while the rail crosses that line, and the block clips the rest. The first block's rail starts at
 * the table's top, so the copy lies over the real rows there. Every other block's starts the rows' height and the
 * shadow's depth above its top, and every block but the last ends the rows' height below its bottom: across a seam,
 * one block's copy and shadow slide out of its block as the next one's slide in, and the two halves make one. Started
 * only the rows' height above, the next block's shadow would ride in at its top while the seam crosses the shadow, a
 * band of its own below the one sliding out (STA-41). The last block's ends the rows' height above the table's end,
 * so the rows leave with it.
 */
export function railOf(block: RailBlock, pinned: number, shade = 0): { top: number; bottom: number } {
	return {
		top: block.first ? block.tableTop : -(pinned + shade),
		bottom: block.last ? block.height - block.tableBottom + pinned : -pinned,
	};
}

/** What carrying an open frozen row down a table of more blocks reads, all on the screen but `scroll`. */
export interface CarrySizes {
	/** The note's scroll offset when this was read. */
	scroll: number;
	/** The row's top where the table lays it out, without the move. */
	rowTop: number;
	/** Where rows pin, and the frozen rows' height above this one. */
	pinAt: number;
	above: number;
	/** The table's last row's bottom, and the frozen rows' height together. */
	tableBottom: number;
	pinned: number;
}

/**
 * The note's scroll offsets between which an open frozen row of a table of more blocks moves down with the note, so it
 * lies where the blocks' copies of the frozen rows pin (STA-93): from where it reaches its place under the rows above
 * it, to where the last block's copies leave with the table's end (`railOf`). Between them the row moves as far as
 * the note scrolls; it rests at its place in the table before, and that far down after.
 */
export function carryRange(at: CarrySizes): { from: number; to: number } {
	const from = at.scroll + at.rowTop - (at.pinAt + at.above);
	return { from, to: Math.max(from, at.scroll + at.tableBottom - at.pinned - at.pinAt) };
}

/** Where a cell to show is, down the pane, and what it has to stay clear of, all on the screen. */
export interface ShowDown {
	/** The pane's top and bottom, the bottom above a status bar floating over it. */
	top: number;
	bottom: number;
	cellTop: number;
	cellBottom: number;
	/** The cell's own scroll margin. */
	margin: number;
	/** How far down from the pane's top the pinned rows cover, for a cell that passes under them. */
	under: number;
	/** Whether the cell is in the pinned rows, which always show while the table crosses the pane's top. */
	pinned: boolean;
	/** For a key that went up into the pinned rows: where the table's top is, to take it back there. */
	tableTop: number | null;
}

/**
 * How far to scroll the note to show a cell, as `scrollIntoView` with `nearest` would, clear of the pinned rows: a cell
 * that passes under them stays below them, and one of them is scrolled to only when it's out of the pane altogether, as
 * past the table's end, since a scroll margin would move the note on every key there. A key that went up into them
 * takes the table back to its top. Positive scrolls down.
 */
export function showDown(at: ShowDown): number {
	const { bottom, cellTop, cellBottom } = at;
	if (at.pinned) {
		if (at.tableTop !== null && at.tableTop < at.top) return at.tableTop - at.top;
		if (cellBottom <= at.top) return cellTop - at.top;
		if (cellTop >= bottom) return cellBottom - bottom;
		return 0;
	}
	const top = at.top + at.under;
	const { margin } = at;
	if (cellTop - margin < top || cellBottom - cellTop + 2 * margin > bottom - top) return cellTop - margin - top;
	if (cellBottom + margin > bottom) return cellBottom + margin - bottom;
	return 0;
}

/**
 * How wide the strip of frozen columns is: their widths, the space between them and before the first, and the
 * table's border at its start. It has none at its end, inside the table.
 */
export function stripWidth(widths: readonly number[], columns: number, spacing: number, startBorder: number): number {
	let width = startBorder + spacing;
	for (let column = 0; column < columns; column++) width += (widths[column] ?? 0) + spacing;
	return width;
}
