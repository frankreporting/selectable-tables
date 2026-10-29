import { EditorSelection, EditorState, Text } from '@codemirror/state';
import type { Layout } from '../src/editor/layout';
import { frontmatterEnd, looksLikeTable, Span } from '../src/editor/table-text';

/**
 * Builds a note from text with markers: ‸ is a caret, and ⟨ … ⟩ a selection from anchor to head (⟩
 * before ⟨ selects backwards). Several ‸ make several carets.
 */
export function note(marked: string): EditorState {
	const ranges = [];
	let text = '';
	let anchor = -1;
	let head = -1;
	for (const char of marked) {
		if (char === '‸') ranges.push(EditorSelection.cursor(text.length));
		else if (char === '⟨') anchor = text.length;
		else if (char === '⟩') head = text.length;
		else text += char;
	}
	if (anchor >= 0 && head >= 0) ranges.push(EditorSelection.range(anchor, head));
	return EditorState.create({ doc: text, selection: EditorSelection.create(ranges), extensions: EditorState.allowMultipleSelections.of(true) });
}

export interface Drawing {
	/** Obsidian shows the properties, hiding the frontmatter text. */
	properties?: boolean;
	/** Ranges drawn as other block widgets, such as a rendered callout. */
	widgets?: Span[];
}

/**
 * Finds tables the way Obsidian's parser does: a row with a pipe after a blank line, a heading, the
 * frontmatter or the note's start, followed by a delimiter row; the table runs while rows start with a
 * pipe. Lines starting with `>` or indented belong to callouts and lists, which aren't drawn as tables.
 */
export function tablesIn(doc: Text): Span[] {
	const tables: Span[] = [];
	const fmEnd = frontmatterEnd(doc);
	for (let n = 1; n < doc.lines; n++) {
		const line = doc.line(n);
		if (!line.text.startsWith('|') || line.to <= fmEnd) continue;
		const prev = n > 1 ? doc.line(n - 1) : null;
		const opens = !prev || prev.text.trim() === '' || prev.text.startsWith('#') || prev.to === fmEnd;
		if (!opens || !looksLikeTable(doc, { from: line.from, to: doc.line(n + 1).to })) continue;
		let last = n + 1;
		while (last < doc.lines && doc.line(last + 1).text.startsWith('|')) last++;
		tables.push({ from: line.from, to: doc.line(last).to });
		n = last;
	}
	return tables;
}

export function layoutOf(state: EditorState, drawing: Drawing = {}): Layout {
	const tables = tablesIn(state.doc);
	const hidden: Span[] = [...(drawing.widgets ?? [])];
	const fmEnd = frontmatterEnd(state.doc);
	if (drawing.properties && fmEnd >= 0) hidden.push({ from: 0, to: fmEnd });
	const within = (spans: Span[], pos: number) => spans.find((span) => span.from <= pos && pos <= span.to) ?? null;
	return {
		tableAt: (pos) => within(tables, pos),
		isTextLine: (pos) => !within(tables, pos) && !within(hidden, pos),
	};
}
