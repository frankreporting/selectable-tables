import { BlockInfo, BlockType, EditorView } from '@codemirror/view';
import { looksLikeTable, Span } from './table-text';

/** What the decisions need to know about how the note is drawn. */
export interface Layout {
	/** The rendered table whose text holds `pos` (its first or last character included), or null. */
	tableAt(pos: number): Span | null;
	/** Whether the line holding `pos` is drawn as text, not replaced by a block widget or hidden. */
	isTextLine(pos: number): boolean;
}

/**
 * The block that holds `pos`, from a line block that may be made of several. A block widget whose
 * start is exclusive comes with an empty text part at its start, and Obsidian draws a table that way
 * at a note's start or right below the frontmatter, so a widget part wins over a text part.
 */
export function partAt(line: BlockInfo, pos: number): BlockInfo {
	const parts: BlockType | readonly BlockInfo[] = line.type;
	if (typeof parts === 'number') return line;
	const holds = (part: BlockInfo) => part.from <= pos && pos <= part.to;
	return parts.find((part) => holds(part) && part.type === BlockType.WidgetRange) ?? parts.find((part) => holds(part) && part.type === BlockType.Text) ?? line;
}

/**
 * The layout of a live editor, read from CodeMirror's block layout at one spot per question. A table is
 * a block widget over text that reads as a Markdown table. The text check alone tells it from Obsidian's
 * other block widgets, so nothing here depends on what is drawn on screen at the moment.
 */
export function viewLayout(view: EditorView): Layout {
	return {
		tableAt(pos) {
			if (pos < 0 || pos > view.state.doc.length) return null;
			const block = partAt(view.lineBlockAt(pos), pos);
			if (block.type !== BlockType.WidgetRange || block.from === block.to) return null;
			const span = { from: block.from, to: block.to };
			return looksLikeTable(view.state.doc, span) ? span : null;
		},
		isTextLine(pos) {
			return partAt(view.lineBlockAt(pos), pos).type === BlockType.Text;
		},
	};
}
