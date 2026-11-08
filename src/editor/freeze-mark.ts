import { rowCells } from './table-text';

/** How many of a table's first rows and columns stay in view as it scrolls. */
export interface Freeze {
	rows: number;
	columns: number;
}

/** The most columns a table can freeze. styles.css has a rule for each count, up to this. */
export const MAX_FROZEN_COLUMNS = 9;

const NOTHING_FROZEN: Freeze = { rows: 0, columns: 0 };

const codeSpan = /(`+)[^`]+\1/g;
const mark = /%%\s*freeze\s+(\d+)\s+(\d+)\s*%%/g;
const space = /[ \t]/;

interface Found {
	from: number;
	to: number;
	freeze: Freeze;
}

/** The marks in a line of text, in order. Code shows its text, so a mark in a code span is a table talking about the mark. */
function marksIn(text: string): Found[] {
	const code = Array.from(text.matchAll(codeSpan), (match) => ({ from: match.index, to: match.index + match[0].length }));
	const found: Found[] = [];
	for (const match of text.matchAll(mark)) {
		const from = match.index;
		const to = from + match[0].length;
		if (code.some((span) => span.from < to && span.to > from)) continue;
		found.push({ from, to, freeze: { rows: Number(match[1]), columns: Math.min(Number(match[2]), MAX_FROZEN_COLUMNS) } });
	}
	return found;
}

/**
 * What a table's header row freezes. `%%freeze 2 1%%` in any of its cells is 2 rows and 1 column: a comment
 * draws as nothing, and it's part of the cell's text, which Obsidian writes back when it rewrites the table.
 * This is the only place a freeze is stored, so nothing can disagree with it. The first mark counts. Rows are
 * clamped by whoever knows the table's size.
 */
export function readFreeze(header: string): Freeze {
	return marksIn(header)[0]?.freeze ?? NOTHING_FROZEN;
}

/** Whether a header row holds a mark, even one that freezes nothing. */
export function hasMark(header: string): boolean {
	return marksIn(header).length > 0;
}

/**
 * The header cells holding a mark, by column. A mark draws nothing, but the space typed beside it stays in
 * its cell, and Obsidian's cells keep every space, so styles.css has these cells drop it.
 */
export function markedCells(header: string): number[] {
	return rowCells(header).flatMap((cell, column) => (hasMark(cell) ? [column] : []));
}

/** The mark as the commands write it. */
export function markText({ rows, columns }: Freeze): string {
	return `%%freeze ${rows} ${columns}%%`;
}

/** Takes a mark out of a line, with the spaces after it, or else the spaces before it. */
function withoutOne(text: string, { from, to }: Found): string {
	let start = from;
	let end = to;
	while (end < text.length && space.test(text.charAt(end))) end++;
	if (end === to) while (start > 0 && space.test(text.charAt(start - 1))) start--;
	return text.slice(0, start) + text.slice(end);
}

/** Takes the marks out of a line, last first, so the positions of those before stay as they were. */
function withoutMarks(text: string, marks: Found[] = marksIn(text)): string {
	return [...marks].reverse().reduce(withoutOne, text);
}

/** A cell's text without its marks, for copying a header cell: the mark belongs to the table, not to the cell. */
export function withoutMark(text: string): string {
	return withoutMarks(text).trim();
}

/**
 * Where a mark goes in a header row with none: the start of the first cell's text, or its padding when it has
 * none. A line starting with `%%` is a comment, not a table, so a row with no leading pipe takes it after the
 * first cell's text.
 */
function firstCell(text: string): number {
	const lead = text.length - text.trimStart().length;
	const piped = text.charAt(lead) === '|';
	const start = piped ? lead + 1 : lead;
	const inside = text.slice(start, pipeAfter(text, start));
	if (!piped) return start + inside.trimEnd().length;
	if (!inside.trim()) return start + Math.min(1, inside.length);
	return start + inside.length - inside.trimStart().length;
}

/** The first pipe from `from` that ends a cell, or the line's end: `\|` is a pipe in the cell's text. */
function pipeAfter(text: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === '\\') i++;
		else if (text[i] === '|') return i;
	}
	return text.length;
}

/**
 * A table's header row with a new freeze. The first mark is written over, just its own text, and any other
 * goes, so the one written is the one that counts. With no mark, one goes at the start of the first cell's
 * text, with a space on each side: commands write it there because the first column is the least likely to be
 * deleted, which would end the freeze. Freezing nothing takes every mark out.
 */
export function withFreeze(header: string, freeze: Freeze): string {
	const [first, ...others] = marksIn(header);
	if (!freeze.rows && !freeze.columns) return withoutMarks(header);
	if (first) {
		const text = withoutMarks(header, others);
		return text.slice(0, first.from) + markText(freeze) + text.slice(first.to);
	}
	const pos = firstCell(header);
	const before = pos > 0 && !space.test(header.charAt(pos - 1)) ? ' ' : '';
	const after = pos < header.length && !space.test(header.charAt(pos)) ? ' ' : '';
	return header.slice(0, pos) + before + markText(freeze) + after + header.slice(pos);
}
