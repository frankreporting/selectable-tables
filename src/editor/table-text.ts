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
/** A row of only such cells isn't a row to Obsidian's table editor. */
const dashCell = /^\s*:?\s*-+\s*:?\s*$/;

type Alignment = 'left' | 'center' | 'right' | null;

function alignmentOf(delimiter: string): Alignment {
	const cell = delimiter.trim();
	if (cell.startsWith(':')) return cell.endsWith(':') ? 'center' : 'left';
	return cell.endsWith(':') ? 'right' : null;
}

function padded(text: string, width: number, alignment: Alignment): string {
	const space = width - text.length;
	const before = alignment === 'right' ? space - 1 : alignment === 'center' ? Math.floor(space / 2) : 1;
	return ' '.repeat(before) + text + ' '.repeat(space - before);
}

/**
 * Whether the table's rows are exactly what Obsidian's table editor writes for their cells. Only then is
 * a caret safe in a cell. Obsidian repairs a malformed table when a press opens a cell, but not for a
 * caret: then typing can eat a pipe, or never reach the note. Obsidian's own test is private, so this
 * doesn't guess at it: it rebuilds the rows and compares. The delimiter's dashes don't count, as Obsidian
 * ignores them too and rewrites that line whole.
 */
export function writtenByObsidian(doc: Text, table: Span): boolean {
	const lines: string[] = [];
	for (let n = doc.lineAt(table.from).number; n <= doc.lineAt(table.to).number; n++) lines.push(doc.line(n).text);
	const cellsOf = (line: string) => segmentsIn(line).map(({ from, to }) => line.slice(from, to));
	const alignments = cellsOf(lines[1] ?? '').map(alignmentOf);
	const body = lines.filter((_, index) => index !== 1);
	const rows = body.map((line) => cellsOf(line).map((cell) => cell.trim()));
	if (rows.some((row) => row.length !== alignments.length || row.every((cell) => dashCell.test(cell)))) return false;
	const widths = alignments.map((_, column) => Math.max(MIN_COLUMN_WIDTH, ...rows.map((row) => (row[column]?.length ?? 0) + CELL_PADDING)));
	const written = rows.map((row) => `|${row.map((text, column) => padded(text, widths[column] ?? 0, alignments[column] ?? null)).join('|')}|`);
	return written.join('\n') === body.join('\n');
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
