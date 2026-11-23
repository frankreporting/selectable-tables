import type { Text } from '@codemirror/state';
import { type Alignment, alignmentOf, CELL_PADDING, type Cell, delimiter, MIN_COLUMN_WIDTH, padded, segmentsIn, type Span, writtenByObsidian } from '../editor/table-text';

/**
 * What an open cell writes to the note, worked out from the text alone, as Obsidian's own cell writes it (read from
 * 1.15.1's `updateCell`, `updateWidth` and `makeAlignmentRow`): the cell's text between its pipes, padded so a table
 * Obsidian wrote stays written that way. Any other table keeps its own spacing, and only the cell's row changes.
 */

/** Where a cell's text is in the note. */
export interface CellPlace {
	/** The row's line. */
	line: { from: number; text: string };
	/** The cell's padded text between its pipes, in the line, or null for a cell a short row lacks. */
	segment: Span | null;
	/** Where its text starts in the note, padding left out, and its Markdown, trimmed. */
	from: number;
	source: string;
}

/** The line a row is on, or null past the table's end: the header is row 0, and the delimiter line has no row. */
function rowLine(doc: Text, table: Span, row: number): { from: number; text: string; number: number } | null {
	const first = doc.lineAt(table.from).number;
	const number = row === 0 ? first : first + row + 1;
	return number <= doc.lineAt(table.to).number ? doc.line(number) : null;
}

/** Where a cell's text is in the note, or null for a row the table doesn't have. */
export function cellPlace(doc: Text, table: Span, { row, column }: Cell): CellPlace | null {
	const line = rowLine(doc, table, row);
	if (!line) return null;
	const segment = segmentsIn(line.text)[column] ?? null;
	if (!segment) return { line, segment: null, from: line.from + line.text.trimEnd().length, source: '' };
	const raw = line.text.slice(segment.from, segment.to);
	const source = raw.trim();
	const lead = source ? raw.length - raw.trimStart().length : Math.min(1, raw.length);
	return { line, segment, from: line.from + segment.from + lead, source };
}

/** A row's line with the spaces beside its pipes taken out and runs of spaces as one: what's left are its cells. */
const unpadded = (line: string) => line.replace(/ *\| */g, '|').replace(/ {2,}/g, ' ').trim();

/**
 * The row a body row's line went to in a change that wrote it again: Sync and a second pane send rows put in or taken
 * out above it as one change rewriting its line along with them, and a new row wider than a column pads the table
 * again. It's the row nearest its old place, within `reach` rows, whose cells read as they did; with none, or for the
 * header, the same row.
 */
export function movedRow(before: Text, was: Span, doc: Text, table: Span, row: number, reach = 200): number {
	const old = row > 0 ? rowLine(before, was, row) : null;
	if (!old) return row;
	const cells = unpadded(old.text);
	const first = doc.lineAt(table.from).number;
	const rows = doc.lineAt(table.to).number - first - 1;
	const reads = (at: number) => at >= 1 && at <= rows && unpadded(doc.line(first + at + 1).text) === cells;
	for (let step = 0; step <= reach; step++) {
		if (reads(row + step)) return row + step;
		if (step && reads(row - step)) return row - step;
	}
	return row;
}

/** How a cell's column is padded: Obsidian's way, at a width, with the widest of the column's other cells. */
export interface Padding {
	obsidian: boolean;
	align: Alignment;
	/** The column's width now, its padding included. */
	width: number;
	/** The narrowest the column can be for its other cells, padding included. */
	others: number;
}

/** How a cell's column is padded now, read once as the cell opens, and again after a change from elsewhere. */
export function paddingFor(doc: Text, table: Span, { row, column }: Cell): Padding {
	const first = doc.lineAt(table.from).number;
	const last = doc.lineAt(table.to).number;
	const align = first < last ? alignmentOf(segmentText(doc.line(first + 1).text, column) ?? '') : null;
	const obsidian = writtenByObsidian(doc, table);
	let others = MIN_COLUMN_WIDTH;
	for (let number = first; number <= last; number++) {
		if (number === first + 1 || number === (row === 0 ? first : first + row + 1)) continue;
		const text = segmentText(doc.line(number).text, column);
		if (text !== null) others = Math.max(others, text.trim().length + CELL_PADDING);
	}
	const header = segmentsIn(doc.line(first).text)[column];
	return { obsidian, align, width: header ? header.to - header.from : 0, others };
}

function segmentText(line: string, column: number): string | null {
	const segment = segmentsIn(line)[column];
	return segment ? line.slice(segment.from, segment.to) : null;
}

/** One change to the note's text. */
export interface Change {
	from: number;
	to: number;
	insert: string;
}

/** Only the characters that differ between `before` and `after`, at `at` in the note, or null for none. */
function difference(before: string, after: string, at: number): Change | null {
	if (before === after) return null;
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
	return { from: at + start, to: at + before.length - end, insert: after.slice(start, after.length - end) };
}

/** What a write changes, and where the cell's text starts once it's in. */
export interface Written {
	changes: Change[];
	from: number;
	padding: Padding;
}

const leadOf = (text: string) => text.length - text.trimStart().length;

/**
 * The changes that make a cell's Markdown `text`, as typed, untrimmed. A table Obsidian wrote is padded as Obsidian
 * pads it: the column is as wide as its longest text and two spaces, and when that changes, every row's cell in it and
 * the delimiter row are padded again. Otherwise only the cell changes, keeping its pipes where they were while the
 * text fits, and a short row gets the cells it lacks.
 */
export function writeCell(doc: Text, table: Span, cell: Cell, text: string, padding: Padding): Written | null {
	const place = cellPlace(doc, table, cell);
	if (!place) return null;
	const { line, segment } = place;
	if (!segment) return appendCell(doc, table, cell, text, padding, place);
	const old = line.text.slice(segment.from, segment.to);
	if (!padding.obsidian) {
		const trimmed = old.trim();
		const lead = trimmed ? leadOf(old) : Math.min(1, old.length);
		const trail = old.length - lead - trimmed.length;
		const right = padding.align === 'right';
		const room = old.length - text.length;
		// A backslash at the text's end would escape the pipe after it, and the row would lose a cell: a space keeps it apart.
		const apart = /(^|[^\\])(\\\\)*\\$/.test(text) ? 1 : 0;
		const before = right ? Math.max(lead ? 1 : 0, room - trail) : lead;
		const after = Math.max(apart, right ? trail : Math.max(trail ? 1 : 0, room - lead));
		const next = ' '.repeat(before) + text + ' '.repeat(after);
		const change = difference(old, next, line.from + segment.from);
		return { changes: change ? [change] : [], from: line.from + segment.from + before, padding };
	}
	const width = Math.max(MIN_COLUMN_WIDTH, padding.others, text.length + CELL_PADDING);
	const next = padded(text, width, padding.align);
	const from = line.from + segment.from + leadOf(next);
	if (width === padding.width) {
		const change = difference(old, next, line.from + segment.from);
		return { changes: change ? [change] : [], from, padding };
	}
	// The column's width changes: every row's cell in it is padded again, and the delimiter row written again.
	const changes: Change[] = [];
	const first = doc.lineAt(table.from).number;
	const last = doc.lineAt(table.to).number;
	let shift = 0;
	let textFrom = from;
	// In a table Obsidian wrote, the column's pipes sit at the same place in every row, so a row's cell is padded again by
	// spaces put in or taken out there, with no need to read the row: at the cell's end, or its start when it's aligned
	// right. A row that doesn't fit that is written by the rule. Centered columns are always written by the rule.
	const head = segmentsIn(doc.line(first).text)[cell.column];
	const delta = width - padding.width;
	const at = head && padding.align !== 'center' ? (padding.align === 'right' ? head.from : head.to) : -1;
	const quick = (text: string): Change | null => {
		if (at < 0 || !head || text.length < head.to + 1 || text.charCodeAt(head.to) !== 124 || (head.from > 0 && text.charCodeAt(head.from - 1) !== 124)) return null;
		if (delta > 0) return { from: at, to: at, insert: ' '.repeat(delta) };
		const from = padding.align === 'right' ? at : at + delta;
		const to = padding.align === 'right' ? at - delta : at;
		return /^ +$/.test(text.slice(from, to)) && text.slice(head.from, head.to).trim().length + CELL_PADDING <= width ? { from, to, insert: '' } : null;
	};
	for (let number = first; number <= last; number++) {
		const each = doc.line(number);
		const fast = number !== first + 1 && each.from !== line.from ? quick(each.text) : null;
		if (fast) {
			changes.push({ from: each.from + fast.from, to: each.from + fast.to, insert: fast.insert });
			shift += fast.insert.length - (fast.to - fast.from);
			continue;
		}
		let after: string | null;
		if (number === first + 1) after = delimiterLine(doc.line(first).text, each.text, cell.column, width);
		else {
			const at = segmentsIn(each.text)[cell.column];
			if (!at) continue;
			const mine = each.from === line.from;
			const cellText = mine ? next : padded(each.text.slice(at.from, at.to).trim(), width, padding.align);
			after = each.text.slice(0, at.from) + cellText + each.text.slice(at.to);
			if (mine) textFrom = from + shift;
		}
		const change = after === null ? null : difference(each.text, after, each.from);
		if (!change) continue;
		changes.push(change);
		shift += change.insert.length - (change.to - change.from);
	}
	return { changes, from: textFrom, padding: { ...padding, width } };
}

/** The delimiter row Obsidian writes for a table its widths: each column as wide as the header's cell, one new. */
function delimiterLine(header: string, line: string, column: number, width: number): string {
	const widths = segmentsIn(header).map(({ from, to }) => to - from);
	const aligns = segmentsIn(line).map(({ from, to }) => alignmentOf(line.slice(from, to)));
	return `|${widths.map((each, index) => delimiter(index === column ? width : each, aligns[index] ?? null)).join('|')}|`;
}

/** A cell a short row lacks: the row gets its missing cells, each padded as wide as the header's, and the text goes in its own. */
function appendCell(doc: Text, table: Span, { column }: Cell, text: string, padding: Padding, place: CellPlace): Written {
	const { line } = place;
	const row = line.text.trimEnd();
	const segments = segmentsIn(line.text);
	const closed = row.endsWith('|') && !row.endsWith('\\|') && (segments.length === 0 || segments[segments.length - 1]!.to < row.length);
	const header = segmentsIn(doc.lineAt(table.from).text);
	let insert = '';
	let from = line.from + row.length;
	for (let index = segments.length; index <= column; index++) {
		const content = index === column ? text : '';
		const above = header[index];
		const width = above ? above.to - above.from : content.length + CELL_PADDING;
		const piece = ` ${content}`.padEnd(Math.max(width, content.length + CELL_PADDING), ' ');
		if (!closed) insert += '|';
		if (index === column) from += insert.length + 1;
		insert += piece;
		if (closed) insert += '|';
	}
	return { changes: [{ from: line.from + row.length, to: line.from + row.length, insert }], from, padding };
}
