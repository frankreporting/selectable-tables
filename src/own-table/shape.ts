import type { Text } from '@codemirror/state';
import { rowCells, type Span } from '../editor/table-text';

export type Align = 'left' | 'center' | 'right' | null;

/** A column's alignment, from its cell in the delimiter row. */
export function alignOf(delimiterCell: string): Align {
	const cell = delimiterCell.trim();
	const left = cell.startsWith(':');
	const right = cell.endsWith(':');
	if (left && right) return 'center';
	return right ? 'right' : left ? 'left' : null;
}

/** A row's cells, exactly `columns` of them: a short row gets empty cells, as Obsidian draws it. */
export function cellsOf(line: string, columns: number): string[] {
	const cells = rowCells(line);
	while (cells.length < columns) cells.push('');
	return cells.length > columns ? cells.slice(0, columns) : cells;
}

/** A delimiter cell for an alignment. */
function delimiterCell(align: Align): string {
	if (align === 'center') return ':-:';
	if (align === 'right') return '-:';
	return align === 'left' ? ':-' : '-';
}

/** A row written for Markdown's renderer: its cells between pipes. An escaped pipe stays escaped. */
function rowOf(cells: readonly string[]): string {
	return `| ${cells.join(' | ')} |`;
}

/**
 * The Markdown to render for a header and some rows, written again so every row has the same cells and the table
 * starts at the line's start. A table under a list item is indented, which Markdown's renderer would take for code,
 * and a row Obsidian draws wider than the header would be cut short.
 */
export function markdownOf(header: string, rows: readonly string[], columns: number, aligns: readonly Align[]): string {
	const lines = [rowOf(cellsOf(header, columns)), rowOf(Array.from({ length: columns }, (_, c) => delimiterCell(aligns[c] ?? null)))];
	for (const row of rows) lines.push(rowOf(cellsOf(row, columns)));
	return lines.join('\n');
}

/** The cell a place in a row's text is in, by its column: the cells' pipes, but escaped ones, divide them. */
export function columnAt(line: string, offset: number): number {
	const row = line.trimEnd();
	let from = row.length - row.trimStart().length;
	if (row[from] === '|') from++;
	let column = 0;
	for (let i = from; i < Math.min(offset, row.length); i++) {
		if (row[i] === '\\') i++;
		else if (row[i] === '|') column++;
	}
	return column;
}

/** The rows taken out at `at`, and how many replace them. */
export interface Splice {
	at: number;
	removed: number;
	added: number;
}

/** A table's place by lines: its header's line number and how many body rows it has. */
export interface TableLines {
	header: number;
	count: number;
}

/** Where a table's lines are in a text. */
export function linesOf(doc: Text, table: Span): TableLines {
	const header = doc.lineAt(table.from).number;
	return { header, count: Math.max(0, doc.lineAt(table.to).number - header - 1) };
}

/** The lines a change touched, by number, in the old text and in the new. */
export interface LineChange {
	oldFirst: number;
	oldLast: number;
	first: number;
	last: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * How a change turns a table's old body rows into its new ones, as splices applied in order: the changed rows
 * are replaced, and rows the table gained or lost at its end are added or taken out there. Rows before the change
 * and after it keep what was known of them. Null when the header or the delimiter changed: every row is read again.
 */
export function rowSplices(old: TableLines, now: TableLines, change: LineChange): Splice[] | null {
	if (change.first <= now.header + 1 || change.oldFirst <= old.header + 1) return null;
	const before = clamp(change.first - now.header - 2, 0, Math.min(old.count, now.count));
	const oldAfter = clamp(old.count - (change.oldLast - old.header - 1), 0, old.count - before);
	const newAfter = clamp(now.count - (change.last - now.header - 1), 0, now.count - before);
	const common = Math.min(oldAfter, newAfter);
	const oldMiddle = old.count - before - oldAfter;
	const newMiddle = now.count - before - newAfter;
	const splices: Splice[] = [];
	if (oldMiddle || newMiddle) splices.push({ at: before, removed: oldMiddle, added: newMiddle });
	if (oldAfter !== newAfter) splices.push({ at: before + newMiddle + common, removed: oldAfter - common, added: newAfter - common });
	return splices;
}
