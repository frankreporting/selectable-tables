import type { Bounds } from '../editor/decide';
import { hasMark, markText, readFreeze, withoutMark } from '../editor/freeze-mark';
import { type Cell, onlyDashes, segmentsIn } from '../editor/table-text';

/**
 * The text side of formatting on a selected cell or a range of cells of the plugin's table: which cells Obsidian's
 * formatting acts on, the table it reads their formatting from, and their new text afterwards. Obsidian's own code
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

/** The document Obsidian's formatting reads the cells from, where each cell's text is in it, and how to read them back. */
export interface Stand {
	doc: string;
	ranges: Range[];
	/** The cells' new text, trimmed, from the document after formatting, or null when a row's cells no longer read the same. */
	textsAfter(doc: string): string[] | null;
}

/**
 * The document Obsidian's formatting reads the cells from: the table cut down to the targets' rows and columns, the
 * header and delimiter kept, after a blank line, so Obsidian's own Markdown language reads it as a table, as it reads
 * the cells of its own range. A cell's text at a line's start is then text, as in the note, not a heading, a list or a
 * quote. A header cell's freeze mark is left out, so nothing formatting does can reach it.
 */
export function documentOf(lines: readonly string[], targets: readonly Target[]): Stand {
	// Folded rather than spread: a range can hold more cells than a call takes arguments.
	const edge = (pick: (cell: Cell) => number, most: (a: number, b: number) => number) => targets.reduce((at, { cell }) => most(at, pick(cell)), pick(targets[0]!.cell));
	const left = edge(({ column }) => column, Math.min);
	const right = edge(({ column }) => column, Math.max);
	const bottom = edge(({ row }) => row, Math.max);
	const top = Math.max(1, edge(({ row }) => row, Math.min));
	const picked = [0, 1];
	for (let row = top; row <= bottom; row++) picked.push(row + 1);
	// Each picked line cut to the columns, and where each of its cells is in the cut line.
	const cut = picked.map((index) => {
		const line = lines[index] ?? '';
		const parts = segmentsIn(line)
			.slice(left, right + 1)
			.map(({ from, to }) => {
				const raw = line.slice(from, to);
				return index === 0 && hasMark(raw) ? ` ${withoutMark(raw)} ` : raw;
			});
		const starts: number[] = [];
		let at = 1;
		for (const part of parts) {
			starts.push(at);
			at += part.length + 1;
		}
		return { text: `|${parts.join('|')}|`, parts, starts };
	});
	const lineStarts: number[] = [];
	let at = 1;
	for (const { text } of cut) {
		lineStarts.push(at);
		at += text.length + 1;
	}
	// The header is the first line picked, and the rows from `top` come after the delimiter.
	const placeOf = ({ row, column }: Cell) => ({ k: row === 0 ? 0 : row - top + 2, part: column - left });
	const ranges = targets.map(({ cell }) => {
		const { k, part } = placeOf(cell);
		const raw = cut[k]!.parts[part]!;
		const from = lineStarts[k]! + cut[k]!.starts[part]! + raw.length - raw.trimStart().length;
		return { from, to: from + raw.trim().length };
	});
	return {
		doc: `\n${cut.map(({ text }) => text).join('\n')}`,
		ranges,
		textsAfter(doc) {
			const after = doc.split('\n').slice(1);
			if (after.length !== cut.length) return null;
			const segments = after.map((line) => segmentsIn(line));
			// A short row cut to no cells reads as one empty cell: compared as it read before formatting.
			if (segments.some((each, k) => each.length !== segmentsIn(cut[k]!.text).length)) return null;
			return targets.map(({ cell }) => {
				const { k, part } = placeOf(cell);
				const { from, to } = segments[k]![part]!;
				return after[k]!.slice(from, to).trim();
			});
		},
	};
}

/** A cell's new Markdown, its freeze mark put back before the text. */
export function withMark({ mark }: Target, text: string): string {
	if (!mark) return text;
	return text ? `${mark} ${text}` : mark;
}
