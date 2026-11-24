import type { Bounds } from '../editor/decide';
import { withoutMark } from '../editor/freeze-mark';
import { type Alignment, CELL_PADDING, type Cell, MIN_COLUMN_WIDTH } from '../editor/table-text';
import { readTable, writeTable } from './table-edits';

/**
 * A range of cells on the plugin's own table, drawn and copied as Obsidian draws and copies its own (read from 1.15.1's
 * `selectCells` and `copySelection`).
 */

/** On each cell of a range; app.css tints it and draws the range's frame from its edges' classes. */
const SELECTED = 'is-selected';
/** Obsidian's classes for a range's edges: its first and last columns, and its first and last rows. */
const START = 'start';
const END = 'end';
const TOP = 'top';
const BOTTOM = 'bottom';
/** Every class a range puts on a cell, for a copy of the cell to drop. */
export const RANGE_CLASSES = [SELECTED, START, END, TOP, BOTTOM];

/**
 * Puts a range's classes on a drawn row's cells, `row` being its row in the table, the header 0, and takes them off cells
 * outside it. Only the first `columns` cells are the table's: a copy of a row's frozen cells ends with a hidden filler.
 */
export function paintRange(tr: HTMLTableRowElement, row: number, range: Bounds | null, columns = tr.cells.length): void {
	const rows = range && row >= range.top && row <= range.bottom ? range : null;
	const count = Math.min(columns, tr.cells.length);
	for (let column = 0; column < count; column++) {
		const { classList } = tr.cells[column]!;
		const inside = !!rows && column >= rows.left && column <= rows.right;
		classList.toggle(SELECTED, inside);
		classList.toggle(START, inside && column === rows.left);
		classList.toggle(END, inside && column === rows.right);
		classList.toggle(TOP, inside && row === rows.top);
		classList.toggle(BOTTOM, inside && row === rows.bottom);
	}
}

/** What a row of a range looks like, to tell when a drawn row's classes need changing: empty outside the range. */
export function rangeKey(row: number, range: Bounds | null): string {
	if (!range || row < range.top || row > range.bottom) return '';
	return `${range.left} ${range.right} ${row === range.top ? 1 : 0}${row === range.bottom ? 1 : 0}`;
}

/** A range of cells as Copy puts it on the clipboard. */
export interface RangeCopy {
	/** The range as a Markdown table: plain text and Markdown. */
	markdown: string;
	/** Obsidian's own table data, which a paste into one of its tables reads: each cell's text, and each column's alignment. */
	rows: string[][];
	alignment: Alignment[];
}

/**
 * A range of a table's cells as Obsidian's range copies it (1.15.1's `getTableString` and `copySelection`): the range's
 * rows, its first row as the header, with an alignment row after it, and each cell at its whole column's width, padded by
 * the column's alignment. `anchor` and `head` are cells as the plugin's table draws them, the header being row 0. A row
 * of only dashes, which the plugin draws and Obsidian drops, isn't copied. The freeze mark belongs to the table, so it's
 * left out, and the widths are worked out without it: the copy is what Obsidian copies from the table without its mark.
 */
export function copyRange(lines: readonly string[], anchor: Cell, head: Cell): RangeCopy {
	const grid = readTable(lines);
	grid.rows[0] = grid.rows[0]!.map(withoutMark);
	const columns = grid.alignments.length;
	const widths = grid.alignments.map((_, column) => Math.max(MIN_COLUMN_WIDTH, ...grid.rows.map((cells) => cells[column]!.length + CELL_PADDING)));
	const left = Math.min(Math.min(anchor.column, head.column), columns - 1);
	const right = Math.min(Math.max(anchor.column, head.column), columns - 1);
	const rows: string[][] = [];
	for (let drawn = Math.min(anchor.row, head.row); drawn <= Math.max(anchor.row, head.row) && drawn < grid.drawn.length; drawn++) {
		if (!grid.dropped.has(drawn)) rows.push(grid.rows[grid.drawn[drawn]!]!.slice(left, right + 1));
	}
	const alignment = grid.alignments.slice(left, right + 1);
	const markdown = writeTable({ ...grid, rows, alignments: alignment, widths: widths.slice(left, right + 1) }).join('\n');
	return { markdown, rows, alignment };
}
