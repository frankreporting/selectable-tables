import type { Line, Text } from '@codemirror/state';

/** A range of the note's text, from its first character to its last. */
export interface Span {
	from: number;
	to: number;
}

/** A cell's place in a rendered table. The header is row 0, and the delimiter line has no row. */
export interface Cell {
	row: number;
	column: number;
}

const delimiterCell = /^\s*:?-+:?\s*$/;

/**
 * Whether a range's text is a Markdown table: a first row with a pipe, then a delimiter row such as
 * `| --- | :-: |`. This tells a rendered table from the other blocks Obsidian draws as widgets
 * (callouts, embeds, math), whose text starts differently.
 */
export function looksLikeTable(doc: Text, span: Span): boolean {
	const first = doc.lineAt(span.from);
	if (first.to >= span.to || !first.text.includes('|')) return false;
	const delimiter = doc.line(first.number + 1).text.trim().replace(/^\|/, '').replace(/\|$/, '');
	return delimiter.split('|').every((cell) => delimiterCell.test(cell));
}

/** The line that holds a row. A row past the table's end, which Obsidian can draw, is on its last line. */
function rowLine(doc: Text, table: Span, row: number): Line {
	const first = doc.lineAt(table.from).number;
	return doc.line(Math.min(row === 0 ? first : first + row + 1, doc.lineAt(table.to).number));
}

/** What lies between the pipes of a row, cell by cell, padding included. */
function segmentsIn(text: string): Span[] {
	const row = text.trimEnd();
	const segments: Span[] = [];
	let from = row.length - row.trimStart().length;
	if (row[from] === '|') from++;
	for (let i = from; i < row.length; i++) {
		if (row[i] === '\\') i++;
		else if (row[i] === '|') {
			segments.push({ from, to: i });
			from = i + 1;
		}
	}
	if (from < row.length) segments.push({ from, to: row.length });
	return segments;
}

/** Where each cell of a row sits in its line: from after its pipe to the end of its text. */
function cellsIn(text: string): Span[] {
	return segmentsIn(text).map(({ from, to }) => ({ from, to: from + text.slice(from, to).trimEnd().length }));
}

/** The narrowest column Obsidian's table editor writes. */
const MIN_COLUMN_WIDTH = 5;
/** A cell's text sits between one space on each side, and the longest text sets its column's width. */
const CELL_PADDING = 2;

/**
 * Whether the table's text isn't what Obsidian's table editor writes: uneven rows, or a column padded to
 * anything but its longest text. Obsidian repairs such a table when a press opens a cell, but not when a
 * caret does. A short row's filler cells then have no text to write to, and a cell trimmed on closing
 * moves its neighbors without the note hearing of it, so typing goes astray or never reaches the note.
 */
export function needsRepair(doc: Text, table: Span): boolean {
	const first = doc.lineAt(table.from).number;
	const rows: { width: number; text: number }[][] = [];
	for (let n = first; n <= doc.lineAt(table.to).number; n++) {
		if (n === first + 1) continue;
		const { text } = doc.line(n);
		rows.push(segmentsIn(text).map(({ from, to }) => ({ width: to - from, text: text.slice(from, to).trim().length })));
	}
	const columns = Math.max(...rows.map((row) => row.length));
	if (rows.some((row) => row.length !== columns)) return true;
	for (let column = 0; column < columns; column++) {
		const width = Math.max(MIN_COLUMN_WIDTH, ...rows.map((row) => (row[column]?.text ?? 0) + CELL_PADDING));
		if (rows.some((row) => row[column]?.width !== width)) return true;
	}
	return false;
}

/**
 * Where Enter puts the caret to open a cell: the end of its text. Obsidian draws empty cells to fill a
 * short row, and those have no text, so the caret goes to the last cell the row has.
 */
export function cellCaret(doc: Text, table: Span, { row, column }: Cell): number {
	const line = rowLine(doc, table, row);
	const cells = cellsIn(line.text);
	return line.from + (cells[Math.min(column, cells.length - 1)]?.to ?? line.length);
}

/** A cell's text the way its editor shows it: `\|` is a pipe, and `<br>` outside code is a line break. */
function unescaped(text: string): string {
	const code = Array.from(text.matchAll(/(`+)[^`]+\1/g), (match) => ({ from: match.index, to: match.index + match[0].length }));
	return text.replace(/(\\+)\||<br>/gi, (match: string, slashes: string | undefined, at: number) => {
		if (slashes) return slashes.length % 2 === 1 ? `${slashes.slice(1)}|` : match;
		return code.some(({ from, to }) => from < at && to > at + match.length) ? match : '\n';
	});
}

/** A cell's Markdown, without its padding. A cell Obsidian drew to fill a short row has none. */
export function cellSource(doc: Text, table: Span, { row, column }: Cell): string {
	const { text } = rowLine(doc, table, row);
	const cell = cellsIn(text)[column];
	return cell ? unescaped(text.slice(cell.from, cell.to).trim()) : '';
}

/**
 * The end of the note's frontmatter (its closing `---`), or -1 without one. Obsidian hides this text
 * behind the properties when they show in the document.
 */
export function frontmatterEnd(doc: Text): number {
	if (doc.line(1).text !== '---') return -1;
	for (let n = 2; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (line.text === '---') return line.to;
	}
	return -1;
}
