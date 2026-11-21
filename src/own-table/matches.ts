import type { Text as Doc } from '@codemirror/state';
import type { Span } from '../editor/table-text';
import { linesOf } from './shape';

/** Obsidian's Find marks its match with this class, and the Search pane its result with `is-flashing`. */
export const FIND_CLASS = 'obsidian-search-match-highlight';
export const FLASH_CLASS = 'is-flashing';

/** A match Obsidian marks in the note's text: Find's, or the Search pane's, which flashes. */
export interface Match {
	from: number;
	to: number;
	flash: boolean;
}

/** A match in a row's line, from `start` to `end` in the line's text. */
export interface LineMatch {
	start: number;
	end: number;
	flash: boolean;
}

/** On a part of a cell's drawn text that a match covers. */
const MATCH_CLASS = 'selectable-tables-match';
/** On a cell whose Markdown changes the matched words as drawn: the whole cell shows the match. */
const MATCH_CELL_CLASS = 'selectable-tables-match-cell';
/** The same for a Search pane result, which Obsidian flashes. */
const FLASH_CELL_CLASS = 'selectable-tables-flash-cell';

/** Elements a row's matches are drawn with, to find them again. */
export const MATCH_SELECTOR = `.${MATCH_CLASS}, .${MATCH_CELL_CLASS}, .${FLASH_CELL_CLASS}`;

/**
 * A table's matches by body row, the header being -1, each in its row's line, cut at the line's end. A match on the
 * delimiter line has no row to show in.
 */
export function matchSpans(matches: readonly Match[], doc: Doc, table: Span): Map<number, LineMatch[]> {
	const { header } = linesOf(doc, table);
	const rows = new Map<number, LineMatch[]>();
	for (const { from, to, flash } of matches) {
		if (to < table.from || from > table.to || to <= from) continue;
		const line = doc.lineAt(Math.max(from, table.from));
		const index = line.number - header;
		if (index === 1) continue;
		const row = index === 0 ? -1 : index - 2;
		const list = rows.get(row) ?? [];
		list.push({ start: Math.max(from, line.from) - line.from, end: Math.min(to, line.to) - line.from, flash });
		rows.set(row, list);
	}
	return rows;
}

/** Where the cell holding `offset` sits in its line: between its pipes, an escaped pipe not counting. */
function cellBounds(line: string, offset: number): { column: number; from: number; to: number } {
	const row = line.trimEnd();
	let from = row.length - row.trimStart().length;
	if (row[from] === '|') from++;
	let column = 0;
	for (let i = from; i < row.length; i++) {
		if (row[i] === '\\') i++;
		else if (row[i] === '|') {
			if (offset <= i) return { column, from, to: i };
			column++;
			from = i + 1;
		}
	}
	return { column, from, to: row.length };
}

/** How many times `part`, which isn't empty, is in `text`, not overlapping, ending by `end`. */
export function count(text: string, part: string, end = text.length): number {
	if (!part) return 0;
	let n = 0;
	for (let at = text.indexOf(part); at >= 0 && at + part.length <= end; at = text.indexOf(part, at + part.length)) n++;
	return n;
}

/** The text nodes under an element, in order, walked by hand: the page keeps every node iterator it makes. */
function textNodes(node: Node, out: Text[] = []): Text[] {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.nodeType === Node.TEXT_NODE) out.push(child as Text);
		else textNodes(child, out);
	}
	return out;
}

/** Wraps the drawn text from `from` to `to`, by its characters, a span for each text node it crosses. */
function wrap(box: Element, from: number, to: number, classes: string[]): void {
	let at = 0;
	for (const node of textNodes(box)) {
		const length = node.data.length;
		const start = Math.max(from, at) - at;
		const end = Math.min(to, at + length) - at;
		at += length;
		if (end <= start) continue;
		const middle = start > 0 ? node.splitText(start) : node;
		if (end - start < middle.data.length) middle.splitText(end - start);
		const span = middle.ownerDocument.createElement('span');
		span.className = classes.join(' ');
		middle.replaceWith(span);
		span.append(middle);
	}
}

/**
 * Draws a row's matches in its cells, after taking off those it had. A match shows on the matched words where the
 * cell draws them as typed: the same words, as often, in its drawn text as in its Markdown. Elsewhere, where Markdown
 * in the cell changes them, as across `**bold**`'s stars, the whole cell shows it.
 */
export function paintMatches(tr: HTMLTableRowElement, line: string, matches: readonly LineMatch[]): void {
	for (const span of Array.from(tr.querySelectorAll(`span.${MATCH_CLASS}`))) {
		const parent = span.parentNode;
		span.replaceWith(...Array.from(span.childNodes));
		parent?.normalize();
	}
	for (const cell of Array.from(tr.querySelectorAll(`.${MATCH_CELL_CLASS}, .${FLASH_CELL_CLASS}`))) {
		cell.classList.remove(MATCH_CELL_CLASS, FLASH_CELL_CLASS);
		cell.querySelector(`:scope > .table-cell-wrapper.${FLASH_CLASS}`)?.classList.remove(FLASH_CLASS);
	}
	for (const { start, end, flash } of matches) {
		const bounds = cellBounds(line, start);
		const cell = tr.cells[bounds.column];
		if (!cell) continue;
		const box = cell.querySelector(':scope > .table-cell-wrapper') ?? cell;
		const source = line.slice(bounds.from, bounds.to);
		const text = source.trim();
		const lead = bounds.from + source.length - source.trimStart().length;
		// A match running into the cell's padding, or past its pipe, shows on the words of the cell it starts in.
		const from = Math.max(0, start - lead);
		const matched = text.slice(from, Math.max(from, Math.min(text.length, end - lead)));
		const drawn = box.textContent ?? '';
		// The match is the nth time its words come in the cell's Markdown, and so in its drawn text.
		let at = -1;
		if (matched && count(text, matched) === count(drawn, matched)) {
			const before = count(text, matched, from + matched.length) - 1;
			at = drawn.indexOf(matched);
			for (let n = 0; n < before && at >= 0; n++) at = drawn.indexOf(matched, at + matched.length);
		}
		if (at >= 0) wrap(box, at, at + matched.length, [MATCH_CLASS, flash ? FLASH_CLASS : FIND_CLASS]);
		else if (flash) {
			cell.classList.add(FLASH_CELL_CLASS);
			if (box !== cell) box.classList.add(FLASH_CLASS);
		} else cell.classList.add(MATCH_CELL_CLASS);
	}
}
