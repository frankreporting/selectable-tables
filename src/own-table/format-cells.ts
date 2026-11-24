import type { Bounds } from '../editor/decide';
import { hasMark, markText, readFreeze, withoutMark } from '../editor/freeze-mark';
import { type Cell, onlyDashes, segmentsIn } from '../editor/table-text';

/**
 * The text side of formatting on a selected cell or a range of cells of the plugin's table: which cells Obsidian's
 * formatting acts on, the document it reads their formatting from, and their new text afterwards. Obsidian's own code
 * works the formatting out (formatting.ts); this module only takes the cells out of the table and puts them back.
 */

/** A cell formatting acts on: its Markdown as the note holds it, trimmed, a header cell's freeze mark left out. */
export interface Target {
	cell: Cell;
	text: string;
	/** The header cell's freeze mark, which stays before the text, or null. */
	mark: string | null;
}

/** A range's cells, row by row from its top left, as Obsidian lists the cells of its own range (1.15.1's `selectCells`). */
export function cellsIn({ top, bottom, left, right }: Bounds): Cell[] {
	const cells: Cell[] = [];
	for (let row = top; row <= bottom; row++) for (let column = left; column <= right; column++) cells.push({ row, column });
	return cells;
}

/**
 * The cells formatting acts on, from a table's lines, in their order: an empty cell is skipped, as Obsidian's range
 * skips it, and so is a row of only dashes, which Obsidian's table doesn't have. A header cell's freeze mark belongs to
 * the table, so formatting acts on the text after it, and the mark stays.
 */
export function targetsIn(lines: readonly string[], cells: readonly Cell[]): Target[] {
	const targets: Target[] = [];
	for (const cell of cells) {
		const line = lines[cell.row === 0 ? 0 : cell.row + 1];
		if (line === undefined || (cell.row > 0 && onlyDashes(line))) continue;
		const segment = segmentsIn(line)[cell.column];
		if (!segment) continue;
		const source = line.slice(segment.from, segment.to).trim();
		const mark = cell.row === 0 && hasMark(source) ? markText(readFreeze(source)) : null;
		const text = mark ? withoutMark(source) : source;
		if (text) targets.push({ cell, text, mark });
	}
	return targets;
}

/** A span of a document. */
export interface Range {
	from: number;
	to: number;
}

/**
 * The document Obsidian's formatting reads the cells from: each cell's text on a line of its own, with a blank line
 * between, so nothing one cell opens runs on into the next. Also where each cell's text is in it.
 */
export function documentOf(texts: readonly string[]): { doc: string; ranges: Range[] } {
	const ranges: Range[] = [];
	let at = 0;
	for (const text of texts) {
		ranges.push({ from: at, to: at + text.length });
		at += text.length + 2;
	}
	return { doc: texts.join('\n\n'), ranges };
}

/**
 * The cells' new text from that document after formatting, trimmed, or null when the lines between cells didn't stay
 * blank and single: formatting puts in and takes out only its marks, so anything else means a cell's text ran on.
 */
export function textsIn(doc: string, count: number): string[] | null {
	const lines = doc.split('\n');
	if (lines.length !== count * 2 - 1 || lines.some((line, index) => index % 2 === 1 && line !== '')) return null;
	return lines.filter((_, index) => index % 2 === 0).map((line) => line.trim());
}

/** A cell's new Markdown, its freeze mark put back before the text. */
export function withMark({ mark }: Target, text: string): string {
	if (!mark) return text;
	return text ? `${mark} ${text}` : mark;
}
