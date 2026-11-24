import type { Text } from '@codemirror/state';
import type { Bounds } from '../editor/decide';
import { hasMark, markText, readFreeze, withoutMark } from '../editor/freeze-mark';
import { type Alignment, alignmentOf, CELL_PADDING, type Cell, delimiter, MIN_COLUMN_WIDTH, padded, segmentsIn, type Span, toCellSource } from '../editor/table-text';

/**
 * The edits Obsidian's table controls make to a table, worked out from its text alone, as Obsidian's own table writes
 * them (read from 1.15.1's `insertRow`, `moveRow`, `removeRow`, `insertColumn`, `moveColumn`, `removeColumn`,
 * `setAlignment`, `sortByColumn` and `dispatchTable`): the whole table written again from its cells, every column as
 * wide as its longest text and two spaces, so a table spaced by hand comes out tidied. The columns keep the widths they
 * were read with: Obsidian works them out as it reads a table, and an edit that takes a row out doesn't narrow them.
 */

/**
 * The edits, by the names of Obsidian's commands, with its two sorts, a drag's moves, which take the row or column to go
 * to (`EditOptions.to`), and the + buttons' adds at the table's end.
 */
export type TableEdit =
	| 'row-before'
	| 'row-after'
	| 'row-up'
	| 'row-down'
	| 'row-copy'
	| 'row-delete'
	| 'col-before'
	| 'col-after'
	| 'col-left'
	| 'col-right'
	| 'col-copy'
	| 'col-delete'
	| 'col-align-left'
	| 'col-align-center'
	| 'col-align-right'
	| 'sort-az'
	| 'sort-za'
	| 'row-move'
	| 'col-move'
	| 'row-end'
	| 'col-end';

/** The edits that add a row or a column: the new one's cell opens afterwards, ready to type in, as in Obsidian. */
export const ADDS: ReadonlySet<TableEdit> = new Set(['row-before', 'row-after', 'col-before', 'col-after', 'row-end', 'col-end']);

/** A table's cells as Obsidian's table editor holds them, each column's alignment, and the width it's written at. */
export interface Grid {
	rows: string[][];
	alignments: Alignment[];
	widths: number[];
	/**
	 * For each row as the plugin's table draws it, every line but the delimiter, the row of `rows` it is: a row of only
	 * dashes, which Obsidian drops, is the row kept before it.
	 */
	drawn: number[];
	/** The rows the plugin draws that Obsidian drops, by their place in `drawn`. */
	dropped: Set<number>;
	/** The line each of `rows` is on, in the table's lines. */
	lineOf: number[];
}

/** A row of only dashes, which Obsidian's table parser drops rather than read as a row. */
const dashCell = /^\s*:?\s*-+\s*:?\s*$/;

/**
 * A table's cells as Obsidian reads them (1.15.1's table widget): the header, then every row but the delimiter, each
 * cell's text without its padding. A row of only dashes is dropped, a row with more cells than the delimiter adds
 * columns, and a short row is filled with empty cells. Each column is as wide as its longest text and two spaces.
 */
export function readTable(lines: readonly string[]): Grid {
	const cellsOf = (line: string) => segmentsIn(line).map(({ from, to }) => line.slice(from, to));
	const alignments = cellsOf(lines[1] ?? '').map(alignmentOf);
	const rows: string[][] = [];
	const drawn: number[] = [];
	const dropped = new Set<number>();
	const lineOf: number[] = [];
	lines.forEach((line, index) => {
		if (index === 1) return;
		const cells = cellsOf(line).map((cell) => cell.trim());
		if (index === 0 || !cells.every((cell) => dashCell.test(cell))) {
			rows.push(cells);
			lineOf.push(index);
		} else dropped.add(drawn.length);
		drawn.push(rows.length - 1);
	});
	const columns = Math.max(alignments.length, ...rows.map((row) => row.length));
	while (alignments.length < columns) alignments.push(null);
	for (const row of rows) while (row.length < columns) row.push('');
	const widths = alignments.map((_, column) => Math.max(MIN_COLUMN_WIDTH, ...rows.map((row) => row[column]!.length + CELL_PADDING)));
	return { rows, alignments, widths, drawn, dropped, lineOf };
}

/** A table's lines as Obsidian's table editor writes them, the delimiter included, each column at its width. */
export function writeTable({ rows, alignments, widths }: Grid): string[] {
	const row = (cells: string[]) => `|${cells.join('|')}|`;
	const lines = rows.map((cells) => row(cells.map((text, column) => padded(text, widths[column]!, alignments[column] ?? null))));
	lines.splice(1, 0, row(alignments.map((alignment, column) => delimiter(widths[column]!, alignment))));
	return lines;
}

/**
 * What an edit leaves: the table's new lines, or null when it takes the whole table away, and the cell it goes to. `from`
 * says which of the table's lines before each new line was, or -1 for a line that's new, so lines that stay can be
 * written where they were.
 */
export interface Edited {
	lines: string[] | null;
	cell: Cell;
	from?: number[];
}

/**
 * What an edit needs besides the table: which way the table reads, for Align left and right, a cell's shown text, for
 * Sort, and where a drag puts its row or column: a row as the plugin's table draws them, the header being 0.
 */
export interface EditOptions {
	rtl?: boolean;
	shown?: (markdown: string) => string;
	to?: number;
}

/** Sorts as Obsidian's table does: case and accents aside, and numbers in number order. */
const collator = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true });

/** Moves an item in a list from one place to another, as Obsidian's helper does. */
function move<T>(list: T[], from: number, to: number): void {
	const [item] = list.splice(from, 1);
	list.splice(to, 0, item!);
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * What an edit at a cell does to a table's lines, as Obsidian's does it, or null when it doesn't apply there: Move row
 * up on the header, say. The cell it goes to is where Obsidian puts its focus afterwards: the new row or column's cell,
 * the moved cell in its new place, the cell above or to the left of one deleted, else the same place.
 *
 * Obsidian doesn't know the freeze mark, so the mark is kept in the header here: an edit that would take it out of the
 * header (taking out the header row or the mark's column, moving the header down, or adding a row above it) puts it at
 * the start of the new header's first cell, and a copy of the header row or of the mark's cell doesn't copy it.
 */
export function editTable(lines: readonly string[], edit: TableEdit, { row, column }: Cell, options: EditOptions = {}): Edited | null {
	const grid = readTable(lines);
	const { rows, alignments, widths } = grid;
	// The cell's row as the plugin draws it, among the rows Obsidian reads. Delete row on a row of dashes deletes only it:
	// writing the table again leaves it out.
	const drawnRow = clamp(row, 0, grid.drawn.length - 1);
	const onDashes = grid.dropped.has(drawnRow);
	row = grid.drawn[drawnRow] ?? 0;
	const header = lines[0] ?? '';
	const mark = hasMark(header) ? markText(readFreeze(header)) : null;
	// Which of the rows before the edit each row is, so the header's own row can be found wherever it goes.
	const origins = rows.map((_, index) => index);
	const columns = alignments.length;
	row = clamp(row, 0, rows.length - 1);
	column = clamp(column, 0, columns - 1);
	let to: Cell = { row, column };
	let copiedCell: number | null = null;
	switch (edit) {
		case 'row-before':
		case 'row-after':
		case 'row-copy': {
			const at = edit === 'row-after' ? row + 1 : row;
			const copy = edit === 'row-copy';
			rows.splice(at, 0, copy ? [...rows[row]!] : alignments.map(() => ''));
			origins.splice(at, 0, copy ? row : -1);
			to = { row: copy ? at + 1 : at, column };
			break;
		}
		case 'row-up':
		case 'row-down': {
			const at = edit === 'row-up' ? row - 1 : row + 1;
			if (at < 0 || at >= rows.length) return null;
			move(rows, row, at);
			move(origins, row, at);
			to = { row: at, column };
			break;
		}
		case 'row-move': {
			// A row dragged into place, as Obsidian's `moveRow` puts it: at the row it was let go on, its first cell after.
			const at = clamp(grid.drawn[clamp(options.to ?? row, 0, grid.drawn.length - 1)] ?? 0, 0, rows.length - 1);
			if (at === row) return null;
			move(rows, row, at);
			move(origins, row, at);
			to = { row: at, column: 0 };
			break;
		}
		case 'row-end':
			// The + below the table: a row at its end, and its first cell.
			rows.push(alignments.map(() => ''));
			origins.push(-1);
			to = { row: rows.length - 1, column: 0 };
			break;
		case 'row-delete':
			if (onDashes) break;
			rows.splice(row, 1);
			origins.splice(row, 1);
			if (!rows.length) return { lines: null, cell: { row: 0, column: 0 } };
			to = { row: row - 1, column };
			break;
		case 'col-before':
		case 'col-after':
		case 'col-copy': {
			const at = edit === 'col-after' ? column + 1 : column;
			const copy = edit === 'col-copy';
			alignments.splice(at, 0, alignments[column] ?? null);
			widths.splice(at, 0, copy ? widths[column]! : MIN_COLUMN_WIDTH);
			for (const cells of rows) cells.splice(at, 0, copy ? cells[column]! : '');
			if (copy) copiedCell = at;
			to = { row, column: copy ? at + 1 : at };
			break;
		}
		case 'col-left':
		case 'col-right': {
			const at = edit === 'col-left' ? column - 1 : column + 1;
			if (at < 0 || at >= columns) return null;
			move(alignments, column, at);
			move(widths, column, at);
			for (const cells of rows) move(cells, column, at);
			to = { row, column: at };
			break;
		}
		case 'col-move': {
			// A column dragged into place, as Obsidian's `moveColumn` puts it: at the column it was let go on, its header after.
			const at = clamp(options.to ?? column, 0, columns - 1);
			if (at === column) return null;
			move(alignments, column, at);
			move(widths, column, at);
			for (const cells of rows) move(cells, column, at);
			to = { row: 0, column: at };
			break;
		}
		case 'col-end':
			// The + at the table's side: a column at its end with no alignment, and its header cell.
			alignments.push(null);
			widths.push(MIN_COLUMN_WIDTH);
			for (const cells of rows) cells.push('');
			to = { row: 0, column: columns };
			break;
		case 'col-delete':
			if (columns === 1) return { lines: null, cell: { row: 0, column: 0 } };
			alignments.splice(column, 1);
			widths.splice(column, 1);
			for (const cells of rows) cells.splice(column, 1);
			to = { row, column: column - 1 };
			break;
		case 'col-align-left':
		case 'col-align-center':
		case 'col-align-right': {
			// Obsidian aligns to the start or the end of the table's direction: left is right in a right-to-left table.
			const start: Alignment = options.rtl ? 'right' : 'left';
			const end: Alignment = options.rtl ? 'left' : 'right';
			alignments[column] = edit === 'col-align-center' ? 'center' : edit === 'col-align-left' ? start : end;
			break;
		}
		case 'sort-az':
		case 'sort-za': {
			const shown = options.shown ?? ((text: string) => text);
			const keys = new Map(rows.map((cells) => [cells, shown(cells[column]!)]));
			const order = (a: string[], b: string[]) => collator.compare(keys.get(a)!, keys.get(b)!);
			const body = rows.slice(1).map((cells, index) => ({ cells, origin: origins[index + 1]! }));
			body.sort((a, b) => (edit === 'sort-az' ? order(a.cells, b.cells) : order(b.cells, a.cells)));
			rows.splice(1, body.length, ...body.map(({ cells }) => cells));
			origins.splice(1, body.length, ...body.map(({ origin }) => origin));
			break;
		}
	}
	return finish(grid, origins, to, mark, copiedCell);
}

/**
 * An edit's lines from the cells it left: the freeze mark kept in the header, each column at least as wide as its
 * longest text, the cell it goes to kept within the table, and which line each new line was. `origins` says which of
 * the rows read each row was, or -1 for a new one.
 */
function finish(grid: Grid, origins: number[], to: Cell, mark: string | null, copiedCell: number | null = null): Edited {
	const { rows, alignments, widths } = grid;
	if (mark !== null) keepMark(rows, origins, mark, copiedCell);
	// A cell that took the mark is wider: its column grows to fit, as typing it would have it.
	widths.forEach((width, index) => (widths[index] = Math.max(width, ...rows.map((cells) => cells[index]!.length + CELL_PADDING))));
	const cell = { row: clamp(to.row, 0, rows.length - 1), column: clamp(to.column, 0, alignments.length - 1) };
	// Which line each new line was: the delimiter stays the delimiter while the header is the same row, and a row's copy
	// is new.
	const used = new Set<number>();
	const lineFrom = (origin: number) => {
		const line = origin >= 0 ? grid.lineOf[origin] ?? -1 : -1;
		if (line < 0 || used.has(line)) return -1;
		used.add(line);
		return line;
	};
	const from = origins.map(lineFrom);
	from.splice(1, 0, origins[0] === 0 ? 1 : -1);
	return { lines: writeTable(grid), cell, from };
}

// A range of cells ----------------------------------------------------------------------------------------------------

/**
 * What Backspace, Delete, Cut and Paste do to a range of cells, or Paste to one cell, as Obsidian's range does (read from
 * 1.15.1's `deleteSelection` and `pasteSelection`). Rows are as the plugin's table draws them, the header being 0.
 *
 * - `delete`: across every column, the range's rows go, and across every row too, the whole table; across every row
 *   alone, its columns go; else its cells are emptied. Backspace goes on from the range's start, Delete (`forward`) from
 *   its end: the cell selected afterwards is its first cell or its last, or the one beside the rows or columns that went.
 *   `head` is the cell moved to last, whose column or row is kept when rows or columns go.
 * - `paste`: cells copied from a table, written over the cells from `at` on, the table growing rows and columns to fit.
 *   Onto the header, they bring their columns' alignments; elsewhere only new columns take any. The cell afterwards is
 *   the last one pasted.
 */
export type CellsEdit = { kind: 'delete'; bounds: Bounds; head: Cell; forward: boolean } | { kind: 'paste'; at: Cell } & TableData;

/** Obsidian's table data on the clipboard: each cell's Markdown, row by row, and each column's alignment. */
export interface TableData {
	rows: string[][];
	alignment: Alignment[];
}

const ALIGNMENTS: readonly unknown[] = ['left', 'center', 'right', null];

/**
 * Obsidian's table data from the clipboard (`obsidian/table`, JSON of `{rows, alignment}`), or null when it isn't that
 * shape: an array of rows, each an array of strings, and an alignment per column, `left`, `center`, `right` or null.
 * Obsidian's paste takes every column the alignments name, so there's at least one, and at least one row.
 */
export function readTableData(json: string): TableData | null {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const { rows, alignment } = data as { rows?: unknown; alignment?: unknown };
	if (!Array.isArray(rows) || !rows.length || !rows.every((row) => Array.isArray(row) && row.every((text) => typeof text === 'string'))) return null;
	if (!Array.isArray(alignment) || !alignment.length || !alignment.every((each) => ALIGNMENTS.includes(each))) return null;
	return { rows, alignment: alignment as Alignment[] };
}

/** The longest text in a column and two spaces, as Obsidian works a column's width out after a cell in it changes. */
function widthOf(rows: readonly string[][], column: number): number {
	return Math.max(MIN_COLUMN_WIDTH, ...rows.map((cells) => (cells[column] ?? '').length + CELL_PADDING));
}

export function editCells(lines: readonly string[], edit: CellsEdit): Edited | null {
	const grid = readTable(lines);
	const { rows, alignments, widths } = grid;
	const header = lines[0] ?? '';
	const mark = hasMark(header) ? markText(readFreeze(header)) : null;
	// The header cell holding the mark: written over, it keeps the mark, before what's written.
	const markColumn = mark === null ? -1 : rows[0]!.findIndex(hasMark);
	const set = (row: number, column: number, text: string) => {
		rows[row]![column] = row === 0 && column === markColumn ? (text ? `${mark} ${text}` : mark!) : text;
	};
	const origins = rows.map((_, index) => index);
	// A row as the plugin draws it, among the rows Obsidian reads: a row of dashes, which Obsidian drops, is the row before.
	const rowOf = (drawn: number) => clamp(grid.drawn[clamp(drawn, 0, grid.drawn.length - 1)] ?? 0, 0, rows.length - 1);
	const columns = alignments.length;
	if (edit.kind === 'paste') {
		const column = clamp(edit.at.column, 0, columns - 1);
		// Onto a row of dashes, the row after it: the row before it isn't the one pasted on.
		const drawn = clamp(edit.at.row, 0, grid.drawn.length - 1);
		const row = grid.dropped.has(drawn) ? Math.min(rowOf(drawn) + 1, rows.length) : rowOf(drawn);
		const right = column + edit.alignment.length - 1;
		const bottom = row + edit.rows.length - 1;
		// As 1.15.1 has it: onto the header the pasted columns take the clipboard's alignments, and elsewhere a new column
		// takes the clipboard's from its first, whichever column it lands under.
		if (row === 0) for (let at = column; at <= right; at++) alignments[at] = edit.alignment[at - column] ?? null;
		else for (let at = columns; at <= right; at++) alignments[at] = edit.alignment[at - columns] ?? null;
		const width = alignments.length;
		for (let at = 0; at < Math.max(bottom + 1, rows.length); at++) {
			if (!rows[at]) {
				rows[at] = [];
				origins[at] = -1;
			}
			const cells = rows[at]!;
			while (cells.length < width) cells.push('');
			if (at < row || at > bottom) continue;
			// A cell's text can't hold a raw pipe or line break, and a freeze mark belongs to the table it came from.
			for (let each = column; each <= right; each++) set(at, each, toCellSource(withoutMark(edit.rows[at - row]![each - column] ?? '')).text);
		}
		for (let at = column; at <= right; at++) widths[at] = widthOf(rows, at);
		return finish(grid, origins, { row: bottom, column: right }, mark);
	}
	const { bounds, head, forward } = edit;
	// The range among Obsidian's rows: a row of dashes at its top isn't in it.
	const top = grid.dropped.has(clamp(bounds.top, 0, grid.drawn.length - 1)) ? rowOf(bounds.top) + 1 : rowOf(bounds.top);
	const bottom = rowOf(bounds.bottom);
	const left = clamp(bounds.left, 0, columns - 1);
	const right = clamp(bounds.right, 0, columns - 1);
	const headRow = rowOf(head.row);
	const last = rows.length - 1;
	if (top > bottom) return null;
	let to: Cell;
	if (left === 0 && right === columns - 1) {
		if (top === 0 && bottom === last) return { lines: null, cell: { row: 0, column: 0 } };
		rows.splice(top, bottom - top + 1);
		origins.splice(top, bottom - top + 1);
		// Beside the rows that went: the new header, the row above the table's new end, or the row before or after them.
		const row = top === 0 ? 0 : bottom === last ? top - 1 : forward ? top : top - 1;
		to = { row, column: head.column };
	} else if (top === 0 && bottom === last) {
		const count = right - left + 1;
		alignments.splice(left, count);
		widths.splice(left, count);
		for (const cells of rows) cells.splice(left, count);
		to = { row: headRow, column: forward ? left : left - 1 };
	} else {
		for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) set(row, column, '');
		for (let column = left; column <= right; column++) widths[column] = widthOf(rows, column);
		to = forward ? { row: bottom, column: right } : { row: top, column: left };
	}
	return finish(grid, origins, to, mark);
}

/**
 * Keeps the freeze mark in the header, once: rows below that came from the header lose theirs, so do a copied header
 * cell, and a header without one takes it at its first cell's start.
 */
function keepMark(rows: string[][], origins: number[], mark: string, copiedCell: number | null): void {
	rows.forEach((cells, index) => {
		if (index > 0 && origins[index] === 0) rows[index] = cells.map(withoutMark);
	});
	const head = rows[0]!;
	if (copiedCell !== null && head[copiedCell] !== undefined) head[copiedCell] = withoutMark(head[copiedCell]);
	if (!head.some(hasMark)) head[0] = head[0] ? `${mark} ${head[0]}` : mark;
}

/** One change to the note's text. */
export interface LineChange {
	from: number;
	to: number;
	insert: string;
}

/**
 * The changes that give a table new lines, only where they differ, so a caret elsewhere in the table, a second pane's
 * say, stays where it was: one change for each line that differs when there are as many lines as before, else one for
 * the lines between those that stay the same at either end. Also where the table ends after them.
 */
export function lineChanges(doc: Text, table: Span, lines: readonly string[], from?: readonly number[]): { changes: LineChange[]; to: number } {
	const first = doc.lineAt(table.from).number;
	const old: string[] = [];
	for (let n = first; n <= doc.lineAt(table.to).number; n++) old.push(doc.line(n).text);
	const changes: LineChange[] = [];
	const to = table.to + lines.join('\n').length - old.join('\n').length;
	if (old.length === lines.length) {
		lines.forEach((text, index) => {
			const line = doc.line(first + index);
			if (line.text !== text) changes.push({ from: line.from, to: line.to, insert: text });
		});
		return { changes, to };
	}
	const aligned = from && alignedChanges(doc, first, old, lines, from);
	if (aligned) return { changes: aligned, to };
	let start = 0;
	while (start < old.length && start < lines.length && old[start] === lines[start]) start++;
	let end = 0;
	while (end < old.length - start && end < lines.length - start && old[old.length - 1 - end] === lines[lines.length - 1 - end]) end++;
	const removed = old.slice(start, old.length - end);
	const added = lines.slice(start, lines.length - end);
	if (removed.length && added.length) {
		changes.push({ from: doc.line(first + start).from, to: doc.line(first + old.length - 1 - end).to, insert: added.join('\n') });
	} else if (added.length) {
		// Lines put in between lines that stay: before the first line after them, or after the table's last line.
		if (start < old.length) changes.push({ from: doc.line(first + start).from, to: doc.line(first + start).from, insert: `${added.join('\n')}\n` });
		else changes.push({ from: doc.line(first + old.length - 1).to, to: doc.line(first + old.length - 1).to, insert: `\n${added.join('\n')}` });
	} else if (removed.length) {
		// Lines taken out, with the line break before them, or after them for the table's first lines.
		const last = first + old.length - 1 - end;
		if (start > 0) changes.push({ from: doc.line(first + start - 1).to, to: doc.line(last).to, insert: '' });
		else changes.push({ from: doc.line(first).from, to: doc.line(last + 1).from, insert: '' });
	}
	return { changes, to };
}

/**
 * The changes for a row added or taken out, line by line: a line that stays is rewritten in place when it differs, a
 * new line goes in between, and a line that goes is taken out with its line break. Each line that stays maps to itself,
 * so CodeMirror, which keeps the note still by a place in its text, keeps it still: one change over the stretch from
 * the first line that differs to the last would move that place to the stretch's edge. Null when the lines that stay
 * don't keep their order.
 */
function alignedChanges(doc: Text, first: number, old: readonly string[], lines: readonly string[], from: readonly number[]): LineChange[] | null {
	let last = -1;
	for (const line of from) {
		if (line < 0) continue;
		if (line <= last) return null;
		last = line;
	}
	const kept = new Set(from.filter((line) => line >= 0));
	const changes: LineChange[] = [];
	const lineAt = (index: number) => doc.line(first + index);
	let i = 0;
	let j = 0;
	while (i < old.length || j < lines.length) {
		if (i < old.length && !kept.has(i)) {
			// A line that goes, with the line break after it, or before it for the table's last line, which needs the line
			// before it to stay: else the two would overlap.
			const line = lineAt(i);
			if (i + 1 < old.length) changes.push({ from: line.from, to: lineAt(i + 1).from, insert: '' });
			else if (i > 0 && kept.has(i - 1)) changes.push({ from: lineAt(i - 1).to, to: line.to, insert: '' });
			else return null;
			i++;
		} else if (j < lines.length && from[j] !== i) {
			// A new line, before the next line that stays, or after the table's last line.
			if (i < old.length) changes.push({ from: lineAt(i).from, to: lineAt(i).from, insert: `${lines[j]}\n` });
			else changes.push({ from: lineAt(old.length - 1).to, to: lineAt(old.length - 1).to, insert: `\n${lines[j]}` });
			j++;
		} else {
			if (i >= old.length || j >= lines.length) return null;
			const line = lineAt(i);
			if (line.text !== lines[j]) changes.push({ from: line.from, to: line.to, insert: lines[j]! });
			i++;
			j++;
		}
	}
	return changes;
}

// What a cell shows -------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Emphasis, strikethrough and highlights, by their markers, innermost last. */
const EMPHASIS: [RegExp, string][] = [
	[/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2'],
	[/~~(?=\S)([\s\S]*?\S)~~/g, '$1'],
	[/==(?=\S)([\s\S]*?\S)==/g, '$1'],
	[/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '$1'],
	[/(^|[^\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1$2'],
];

/**
 * The text a cell shows for its Markdown, as Obsidian's Sort reads it from the drawn cell (its `innerText`), without
 * drawing it: a table of 2,000 rows can't be drawn to sort it. Code shows as it's typed; links and wikilinks show their
 * text, a wikilink to a heading as `note > heading`; emphasis, highlights, strikethrough, HTML tags, comments and
 * pictures show nothing of their own; `<br>` is a line break, and an escaped character is itself. Tags keep their `#`.
 */
export function shownText(markdown: string): string {
	let out = '';
	const code = /(`+)([\s\S]*?[^`])\1(?!`)/g;
	let at = 0;
	for (const match of markdown.matchAll(code)) {
		out += shownInline(markdown.slice(at, match.index));
		out += match[2]!.replace(/^ ([\s\S]*[^ ][\s\S]*) $/, '$1');
		at = match.index + match[0].length;
	}
	out += shownInline(markdown.slice(at));
	return out.trim();
}

/** What Markdown outside code shows. */
function shownInline(text: string): string {
	// Escaped characters are themselves, and none of what follows: they're kept aside, then put back.
	const escaped: string[] = [];
	let shown = text.replace(/\\([!-/:-@[-`{-~])/g, (_, char: string) => `\uE000${escaped.push(char) - 1}\uE000`);
	shown = shown
		.replace(/%%[\s\S]*?%%/g, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/!\[\[[^\]]*\]\]/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/\[\[([^\]]*)\]\]/g, (_, target: string) => target.split('#').filter(Boolean).join(' > '))
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^>]*>/g, '')
		.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity: string, name: string) => {
			if (name.startsWith('#')) {
				const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
				return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
			}
			return ENTITIES[name.toLowerCase()] ?? entity;
		});
	for (let pass = 0; pass < 3; pass++) {
		const before = shown;
		for (const [pattern, keep] of EMPHASIS) shown = shown.replace(pattern, keep);
		if (shown === before) break;
	}
	return shown.replace(/\uE000(\d+)\uE000/g, (_, index: string) => escaped[Number(index)] ?? '');
}
