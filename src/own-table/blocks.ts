import type { Text } from '@codemirror/state';
import type { Span } from '../editor/table-text';
import type { Heights, RowRange } from './heights';

/**
 * A table of more rows than this is drawn as one block per this many rows, each a block of its own in the editor,
 * so CodeMirror counts only the blocks near the pane as on screen, and the parser and Live Preview do only that
 * much after each key (STA-74). One block over a whole table counts all of it as on screen. A table of up to this
 * many rows is one block, drawn whole.
 */
export const BLOCK_ROWS = 100;

/** How many blocks a table of `rows` body rows is drawn as. */
export function blockCount(rows: number): number {
	return rows <= BLOCK_ROWS ? 1 : Math.ceil(rows / BLOCK_ROWS);
}

/** A block's body rows. Block 0 also holds the header. */
export function blockRows(rows: number, block: number): RowRange {
	if (rows <= BLOCK_ROWS) return { first: 0, end: rows };
	return { first: block * BLOCK_ROWS, end: Math.min(rows, (block + 1) * BLOCK_ROWS) };
}

/** The block a body row is in. */
export function blockOf(rows: number, row: number): number {
	return rows <= BLOCK_ROWS ? 0 : Math.max(0, Math.min(Math.floor(row / BLOCK_ROWS), blockCount(rows) - 1));
}

/**
 * Where each of a table's blocks is in the note's text: block 0 from the header's line, each later block from its
 * first row's line, each to its last row's line's end, and the last to the table's end.
 */
export function blockSpans(doc: Text, table: Span): Span[] {
	const header = doc.lineAt(table.from).number;
	const rows = Math.max(0, doc.lineAt(table.to).number - header - 1);
	const count = blockCount(rows);
	if (count === 1) return [{ from: table.from, to: table.to }];
	const line = (row: number) => doc.line(header + 2 + row);
	return Array.from({ length: count }, (_, block) => {
		const { first, end } = blockRows(rows, block);
		return { from: block === 0 ? table.from : line(first).from, to: block === count - 1 ? table.to : line(end - 1).to };
	});
}

/** A block's estimated height: its rows, with the header and the box's padding above in block 0, and below in the last. */
export function blockHeight(heights: Heights, block: number, head: number, padTop: number, padBottom: number): number {
	const count = blockCount(heights.count);
	const { first, end } = blockRows(heights.count, block);
	return heights.top(end) - heights.top(first) + (block === 0 ? padTop + head : 0) + (block === count - 1 ? padBottom : 0);
}

/** Where a body row starts in its block's table: below the header in block 0, else below the block's first row's top. */
export function topInBlock(heights: Heights, row: number, head: number): number {
	const block = blockOf(heights.count, row);
	return (block === 0 ? head : 0) + heights.top(row) - heights.top(blockRows(heights.count, block).first);
}

/** What a block's body holds, in order, around the rows drawn in it. */
export interface BodyLayout {
	/** A hidden first row, in every block after the first: a theme's rules for a table's first row land on it. */
	lead: boolean;
	/** A spacer standing in for the block's rows above those drawn, this tall; 0 for none. */
	above: number | null;
	/** A hidden row that keeps each drawn row odd or even, as in one table, for themes that stripe rows. */
	parity: boolean;
	/** The rows drawn, [first, end): the first and last rows in the page of those wanted here. */
	rows: RowRange;
	/** A spacer for the block's rows below those drawn, this tall; null for none. */
	below: number | null;
	/** A hidden last row, in every block before the last: a theme's rules for a table's last row land on it. */
	tail: boolean;
}

/**
 * A block's body, for the rows wanted in the page, `drawn`, of which those `has` says are rendered. Rows above
 * and below those drawn are spacers, so the block is always as tall as all its rows, and the first drawn row sits
 * at an odd or even place among the body's rows as it does in the whole table.
 */
export function bodyLayout(heights: Heights, block: number, drawn: RowRange, has: (row: number) => boolean): BodyLayout {
	const count = blockCount(heights.count);
	const { first, end } = blockRows(heights.count, block);
	let lo = Math.max(first, Math.min(end, drawn.first));
	let hi = Math.max(lo, Math.min(end, drawn.end));
	while (lo < hi && !has(lo)) lo++;
	while (hi > lo && !has(hi - 1)) hi--;
	const lead = block > 0;
	const above = lo > first ? heights.top(lo) - heights.top(first) : null;
	// Row r is the table's (r + 1)th body row: the rows before it in the body are as many, or one fewer with the parity row.
	const before = (lead ? 1 : 0) + (above !== null ? 1 : 0);
	const parity = (((lo - before) % 2) + 2) % 2 === 1;
	const below = hi < end ? heights.top(end) - heights.top(hi) : null;
	return { lead, above, parity, rows: { first: lo, end: hi }, below, tail: block < count - 1 };
}
