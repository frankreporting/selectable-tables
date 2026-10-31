import { EditorState, Line, Transaction } from '@codemirror/state';
import type { Layout } from './layout';
import { Cell, cellCaret, cellSource, frontmatterEnd, Span, writtenByObsidian } from './table-text';

export type Direction = 'up' | 'down' | 'left' | 'right';

/** What a key does. A null decision steps aside and leaves the key to Obsidian. */
export type Action =
	/** The caret passes the table and lands on the line beyond it, keeping its horizontal position. */
	| { type: 'pass'; table: Span; forward: boolean }
	/** Selects exactly the table's text. Its direction records the side it was selected from. */
	| { type: 'select'; table: Span; fromAbove: boolean }
	/** A caret at `pos`. */
	| { type: 'caret'; pos: number }
	/** The selection's head passes the table onto the line beyond it, keeping its horizontal position. */
	| { type: 'extendPast'; table: Span; forward: boolean }
	/** The selection's head moves to `pos`. */
	| { type: 'extendTo'; pos: number }
	/** The key is taken, and nothing changes. */
	| { type: 'stay' }
	/** Selects a cell of the selected table. */
	| { type: 'cell'; cell: Cell }
	/** Back from a selected cell to the selected table. */
	| { type: 'table' }
	/** A caret at `pos`, in a selected cell's text, so that Obsidian opens the cell. */
	| { type: 'open'; pos: number }
	/** Enter can't safely open a cell of this table, and shows that. */
	| { type: 'refuse' };

/** A rendered table's shape. Obsidian fills short rows, but a row's own length is what counts. */
export interface Grid {
	rows: number;
	columns(row: number): number;
}

/** The selected cell of the selected table, held on the editor, not in its state. */
export interface Cells {
	selected: Cell | null;
	/** The cell Escape left, while its table stays selected: Enter goes back to it. */
	left: Cell | null;
	grid: Grid;
}

export const noCells: Cells = { selected: null, left: null, grid: { rows: 0, columns: () => 0 } };

/** What the keys on a selected table or cell need to know. */
export interface TableContext {
	state: EditorState;
	layout: Layout;
	cells: Cells;
}

export interface Context extends TableContext {
	/**
	 * Whether a plain ↑ or ↓ would take the caret off its line, rather than to another row of the same
	 * wrapped line. Asked only when a table is next to the caret, since it measures the screen.
	 */
	leavesLine: (forward: boolean) => boolean;
}

/** The table that is selected: one selection range over exactly a rendered table's text. */
export function selectedTable(state: EditorState, layout: Layout): Span | null {
	const { ranges, main } = state.selection;
	if (ranges.length !== 1 || main.empty) return null;
	const table = layout.tableAt(main.from);
	return table && table.from === main.from && table.to === main.to ? table : null;
}

/** The table that starts on the line right after `line`. */
function tableBelow(state: EditorState, layout: Layout, line: Line): Span | null {
	if (line.to >= state.doc.length) return null;
	const table = layout.tableAt(line.to + 1);
	return table && table.from === line.to + 1 ? table : null;
}

/** The table that ends on the line right before `line`. */
function tableAbove(layout: Layout, line: Line): Span | null {
	if (line.from === 0) return null;
	const table = layout.tableAt(line.from - 1);
	return table && table.to === line.from - 1 ? table : null;
}

/** Whether a caret passing the table can land on a line of text beyond it. */
function textBeyond(state: EditorState, layout: Layout, table: Span, forward: boolean): boolean {
	if (forward) return table.to < state.doc.length && layout.isTextLine(table.to + 1);
	return table.from > 0 && layout.isTextLine(table.from - 1);
}

/**
 * Whether the caret can go to the end of the line above a table. Anything there will do except the
 * frontmatter while Obsidian hides it behind the properties: a caret in that hidden text would type
 * into it unseen.
 */
function reachableAbove(state: EditorState, layout: Layout, table: Span): boolean {
	if (table.from === 0) return false;
	return layout.isTextLine(table.from - 1) || table.from - 1 > frontmatterEnd(state.doc);
}

/**
 * Where the caret goes to leave a table on one side: the start of the line below, or the end of the line
 * above. At a note's start or end, or right below the properties, there is no such line, and the key is
 * left to Obsidian. Obsidian keeps a blank line around the tables it makes, so that only happens in notes
 * written elsewhere.
 */
function beyond(state: EditorState, layout: Layout, table: Span, forward: boolean): Action | null {
	if (forward) return table.to < state.doc.length ? { type: 'caret', pos: table.to + 1 } : null;
	return reachableAbove(state, layout, table) ? { type: 'caret', pos: table.from - 1 } : null;
}

export function arrow(context: Context, direction: Direction, shift: boolean): Action | null {
	const { cells } = context;
	if (cells.selected) return shift ? { type: 'stay' } : { type: 'cell', cell: moveCell(cells.grid, cells.selected, direction) };
	if (context.state.selection.ranges.length !== 1) return null;
	return shift ? extend(context, direction) : move(context, direction);
}

/** An arrow on a selected cell: one cell along, stopping at the table's outer edge. */
function moveCell(grid: Grid, cell: Cell, direction: Direction): Cell {
	if (grid.rows === 0) return cell;
	let { row, column } = cell;
	if (direction === 'up') row = Math.max(row - 1, 0);
	else if (direction === 'down') row = Math.min(row + 1, grid.rows - 1);
	else if (direction === 'left') column = Math.max(column - 1, 0);
	else column++;
	return { row, column: Math.min(column, grid.columns(row) - 1) };
}

/** Tab on a selected cell: reading order, wrapping between rows and stopping at the table's ends. */
function tabCell(grid: Grid, cell: Cell, forward: boolean): Cell {
	if (grid.rows === 0) return cell;
	const { row, column } = cell;
	if (forward) {
		if (column + 1 < grid.columns(row)) return { row, column: column + 1 };
		return row + 1 < grid.rows ? { row: row + 1, column: 0 } : cell;
	}
	if (column > 0) return { row, column: column - 1 };
	return row > 0 ? { row: row - 1, column: grid.columns(row - 1) - 1 } : cell;
}

function move({ state, layout, leavesLine }: Context, direction: Direction): Action | null {
	const selected = selectedTable(state, layout);
	if (selected) return beyond(state, layout, selected, direction === 'down' || direction === 'right');

	const { main } = state.selection;
	if (!main.empty) return collapse(state, layout, main.from, main.to, direction);
	const line = state.doc.lineAt(main.head);
	switch (direction) {
		case 'down': {
			const table = tableBelow(state, layout, line);
			if (!table || !leavesLine(true)) return null;
			return textBeyond(state, layout, table, true) ? { type: 'pass', table, forward: true } : beyond(state, layout, table, true);
		}
		case 'up': {
			const table = tableAbove(layout, line);
			if (!table || !leavesLine(false)) return null;
			return textBeyond(state, layout, table, false) ? { type: 'pass', table, forward: false } : beyond(state, layout, table, false);
		}
		case 'right': {
			const table = main.head === line.to ? tableBelow(state, layout, line) : null;
			return table && { type: 'select', table, fromAbove: true };
		}
		case 'left': {
			const table = main.head === line.from ? tableAbove(layout, line) : null;
			return table && { type: 'select', table, fromAbove: false };
		}
	}
}

/**
 * A plain arrow on a selection collapses it to one end. When that end is a table's edge, as after Shift
 * took a table that ends the note, a caret there would open a cell, so it goes beyond the table instead.
 * Other selections are left to Obsidian.
 */
function collapse(state: EditorState, layout: Layout, from: number, to: number, direction: Direction): Action | null {
	const forward = direction === 'down' || direction === 'right';
	const end = forward ? to : from;
	const table = layout.tableAt(end);
	if (!table || (end !== table.from && end !== table.to)) return null;
	return beyond(state, layout, table, forward);
}

/** Shift with an arrow: the selection's head never stops inside a table, so a table joins it whole. */
function extend({ state, layout, leavesLine }: Context, direction: Direction): Action | null {
	const { head } = state.selection.main;
	const forward = direction === 'down' || direction === 'right';
	let table = layout.tableAt(head);
	if (table) {
		// Already at the far edge, the next move leaves the table, as it does without the plugin, except
		// into frontmatter hidden behind the properties: the head stays out of that unseen text.
		if (head === (forward ? table.to : table.from)) return forward || reachableAbove(state, layout, table) ? null : { type: 'stay' };
	} else {
		const line = state.doc.lineAt(head);
		if (direction === 'down') table = tableBelow(state, layout, line);
		else if (direction === 'up') table = tableAbove(layout, line);
		else if (direction === 'right') table = head === line.to ? tableBelow(state, layout, line) : null;
		else table = head === line.from ? tableAbove(layout, line) : null;
		if (table && (direction === 'down' || direction === 'up') && !leavesLine(forward)) return null;
	}
	if (!table) return null;

	const beyond = textBeyond(state, layout, table, forward);
	if (beyond && (direction === 'down' || direction === 'up')) return { type: 'extendPast', table, forward };
	let pos = forward ? table.to : table.from;
	if (beyond) pos += forward ? 1 : -1;
	// Shrinking a selection to nothing on the table's edge would leave a caret there, which opens a cell.
	if (pos === state.selection.main.anchor && pos >= table.from && pos <= table.to) return { type: 'select', table, fromAbove: forward };
	return { type: 'extendTo', pos };
}

/**
 * Enter on a selected table selects a cell: the one Escape left, or else the first. On a selected cell,
 * it puts the caret at the end of the cell's text, and Obsidian opens that cell, as long as Obsidian wrote
 * the table. It refuses any other. A press still opens a cell there, and tidies a malformed table.
 */
export function enter({ state, layout, cells }: TableContext): Action | null {
	const table = selectedTable(state, layout);
	if (!table) return null;
	if (!cells.selected) return { type: 'cell', cell: cells.left ?? { row: 0, column: 0 } };
	if (!writtenByObsidian(state.doc, table)) return { type: 'refuse' };
	return { type: 'open', pos: cellCaret(state.doc, table, cells.selected) };
}

/**
 * Escape on a selected cell goes back to its table. On a selected table, the caret goes back to the side
 * it was selected from, the line above or the line below, or to the other side when that one doesn't exist.
 */
export function escape({ state, layout, cells }: TableContext): Action | null {
	if (cells.selected) return { type: 'table' };
	const table = selectedTable(state, layout);
	if (!table) return escapeOntoTable(state, layout);
	const { anchor, head } = state.selection.main;
	const below = anchor > head;
	return beyond(state, layout, table, below) ?? beyond(state, layout, table, !below);
}

/**
 * Escape on another selection collapses it to its head. With the head on a table's edge, which Shift
 * leaves when it takes a table that ends the note, that caret would open a cell, so the table is
 * selected instead.
 */
function escapeOntoTable(state: EditorState, layout: Layout): Action | null {
	const { ranges, main } = state.selection;
	if (ranges.length !== 1 || main.empty) return null;
	const table = layout.tableAt(main.head);
	if (!table || (main.head !== table.from && main.head !== table.to)) return null;
	return { type: 'select', table, fromAbove: main.head === table.to };
}

/** A key that would type over a selected table does nothing, so a stray key can't change it. */
export function stay(state: EditorState, layout: Layout): Action | null {
	return selectedTable(state, layout) && { type: 'stay' };
}

/** Tab moves a selected cell. On a selected table, it does nothing. */
export function tab({ state, layout, cells }: TableContext, forward: boolean): Action | null {
	if (cells.selected) return { type: 'cell', cell: tabCell(cells.grid, cells.selected, forward) };
	return stay(state, layout);
}

/** What Copy gives for a selected cell: its Markdown. */
export function copied({ state, layout, cells }: TableContext): string | null {
	const table = selectedTable(state, layout);
	return table && cells.selected && cellSource(state.doc, table, cells.selected);
}

/**
 * Whether the edit guard drops a change to a selected table. Typing into it, as with Shift+Enter, Ctrl+O
 * or an indent key, does nothing. Deleting, cutting, pasting and dropping stay possible on a selected
 * table: those are meant for the selection. Composed input (IME) always passes: dropping it leaves the
 * composition stuck, and Live Preview stops drawing until it ends.
 *
 * A selected cell looks like one cell over a selection of the whole table, so there every edit to the
 * table is dropped, with or without a user event: Obsidian's formatting commands send none. What passes
 * doesn't come from the selection: undo and redo, a search and replace, a reload from disk, which is how
 * Sync arrives (`set`), and a remote edit, which is how a second pane arrives.
 */
export function stopsEdit(tr: Transaction, table: Span, cellSelected: boolean): boolean {
	if (!tr.changes.touchesRange(table.from, table.to) || tr.isUserEvent('input.type.compose')) return false;
	if (cellSelected) return !tr.annotation(Transaction.remote) && !['undo', 'redo', 'set', 'searchReplace'].some((event) => tr.isUserEvent(event));
	if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) return false;
	return tr.isUserEvent('input') || tr.isUserEvent('indent');
}
