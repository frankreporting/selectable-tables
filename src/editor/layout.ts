import { type EditorState, Facet } from '@codemirror/state';
import { BlockInfo, BlockType, EditorView } from '@codemirror/view';
import type { Grid } from './decide';
import { type Cell, looksLikeTable, Span } from './table-text';

/** What the decisions need to know about how the note is drawn. */
export interface Layout {
	/** The rendered table whose text holds `pos` (its first or last character included), or null. */
	tableAt(pos: number): Span | null;
	/** Whether the line holding `pos` is drawn as text, not replaced by a block widget or hidden. */
	isTextLine(pos: number): boolean;
	/**
	 * Whether the plugin draws these tables itself, not Obsidian: ↑ and ↓ stop on them, Enter opens no cell of theirs
	 * yet, and the plugin keeps Obsidian's rules for the lines beside them, which Obsidian keeps only for its own.
	 */
	ownTables?: boolean;
}

/** One of the plugin's own tables, for its selected cell: the plugin's table draws it, whenever its row is drawn. */
export interface DrawnTable {
	readonly grid: Grid;
	/**
	 * Draws `cell` as the selected one, or takes the selected cell off with null. With an `anchor`, the cells from there to
	 * `cell` are drawn as a range, as Obsidian draws its own range of cells.
	 */
	markCell(cell: Cell | null, anchor?: Cell | null): void;
	/**
	 * What Copy puts on the clipboard for a range of cells, as Obsidian copies its own range: the Markdown table, as plain
	 * text and Markdown, the table as HTML, and Obsidian's table data, by type, in that order.
	 */
	copy(anchor: Cell, head: Cell): [type: string, data: string][];
	/**
	 * Brings a cell into view, down the note and sideways, drawing its row first if it isn't drawn, clear of the rows and
	 * columns that pin. A key that went up into a frozen row, or left into a frozen column (`toward`), takes the table
	 * back to its top or its start, so the rows and columns beside them show again.
	 */
	showCell(cell: Cell, toward?: 'up' | 'left'): void;
	/** Forgets a cell it was about to bring into view: a drag across cells scrolls the note itself. */
	holdStill(): void;
	/** Opens a cell for editing, with the caret at the end of its text. */
	openCell(cell: Cell): void;
	/**
	 * Opens a cell emptied for typing over, a header cell keeping its freeze mark, with the caret at the end: typing on the
	 * selected cell. Its editor takes the keyboard unless `focus` is false. Says whether it opened now, inside the key's
	 * event; a cell whose row isn't in the page opens once it's drawn.
	 */
	typeOver(cell: Cell, focus?: boolean): boolean;
	/** Runs `run` once a cell's row is drawn again, after an edit that changed the table's rows, without scrolling first. */
	afterDraw(cell: Cell, run: () => void): void;
	/** Whether the table reads right to left, from its first header cell, as Obsidian's does. */
	readonly rtl: boolean;
	/** Whether any of the table's blocks is in the page. */
	readonly shown: boolean;
}

/** On the editor of an open cell of the plugin's own table: the plugin's other editor extensions stand aside in it. */
export const inOwnCell = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** An open cell of the plugin's own table, for the keys: Escape and the jump keys close it from its editor. */
export interface OwnCell {
	/** The note's editor. */
	readonly note: EditorView;
	/** The cell's editor. */
	readonly view: EditorView;
	readonly cell: Cell;
	/** The table, where it is now. */
	table(): Span | null;
	/** Closes the cell, keeping the focus where it is. */
	close(): void;
	/** Whether a range of the note's text is in the cell's text, as the cell's caret puts the note's selection. */
	holds(from: number, to: number): boolean;
}

/** The open cell of each note's editor, and of each cell's editor. */
export const openCells = new WeakMap<EditorView, OwnCell>();

/** The plugin's own tables, in an editor that draws them: a preview build's renderer gives these (src/own-table). */
export interface OwnTables {
	/** The tables in this state, in order, each from its header's first character to its last row's last; null where Obsidian draws them. */
	spans(state: EditorState): readonly Span[] | null;
	/** The table starting at `from` in the editor's state, for its cells. */
	table(view: EditorView, from: number): DrawnTable | null;
	/** Whether this editor's tables pin their frozen rows and columns: on a computer, not a phone or tablet. */
	pins(view: EditorView): boolean;
	/** The cell an element of a drawn table is in, a pinned copy's being its real cell, and where its table is now. */
	cellAt(view: EditorView, target: Element): { table(): Span | null; cell: Cell } | null;
}

export const ownTables = Facet.define<OwnTables, OwnTables | null>({ combine: (values) => values[0] ?? null });

/** The plugin's own tables in a state, or null where Obsidian draws its own. */
export function ownSpans(state: EditorState): readonly Span[] | null {
	return state.facet(ownTables)?.spans(state) ?? null;
}

/** The span in a sorted list that holds `pos`, its edges included. */
export function spanAt(spans: readonly Span[], pos: number): Span | null {
	let lo = 0;
	let hi = spans.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (spans[mid]!.to < pos) lo = mid + 1;
		else hi = mid;
	}
	const span = spans[lo];
	return span && span.from <= pos ? span : null;
}

/**
 * A layout over the plugin's own tables: a table is the whole table, from its list, however many blocks it's drawn
 * as, so the keys never see the seams between them. Lines outside a table are as `drawn` says.
 */
export function spansLayout(spans: readonly Span[], drawn: Pick<Layout, 'isTextLine'>): Layout {
	return {
		tableAt: (pos) => spanAt(spans, pos),
		isTextLine: (pos) => !spanAt(spans, pos) && drawn.isTextLine(pos),
		ownTables: true,
	};
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
 * The layout of a live editor. Where the plugin draws its own tables, they come from its list of them. Elsewhere it's
 * read from CodeMirror's block layout at one spot per question: a table is a block widget over text that reads as a
 * Markdown table. The text check alone tells it from Obsidian's other block widgets, so nothing here depends on what
 * is drawn on screen at the moment.
 */
export function viewLayout(view: EditorView): Layout {
	const isTextLine = (pos: number) => partAt(view.lineBlockAt(pos), pos).type === BlockType.Text;
	const spans = ownSpans(view.state);
	if (spans) return spansLayout(spans, { isTextLine });
	return {
		tableAt(pos) {
			if (pos < 0 || pos > view.state.doc.length) return null;
			const block = partAt(view.lineBlockAt(pos), pos);
			if (block.type !== BlockType.WidgetRange || block.from === block.to) return null;
			const span = { from: block.from, to: block.to };
			return looksLikeTable(view.state.doc, span) ? span : null;
		},
		isTextLine,
	};
}
