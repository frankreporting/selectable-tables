import type { Text } from '@codemirror/state';

/** A range of the note's text, from its first character to its last. */
export interface Span {
	from: number;
	to: number;
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

/** Where Enter puts the caret: the end of the first cell's text, in the table's header row. */
export function firstCellCaret(doc: Text, table: Span): number {
	const { from, text } = doc.lineAt(table.from);
	let start = text.length - text.trimStart().length;
	if (text[start] === '|') start++;
	let end = text.length;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '\\') i++;
		else if (text[i] === '|') {
			end = i;
			break;
		}
	}
	let caret = end;
	while (caret > start && /\s/.test(text.charAt(caret - 1))) caret--;
	return from + caret;
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
