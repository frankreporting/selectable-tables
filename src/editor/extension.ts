import { EditorSelection, EditorState, Extension, Prec, SelectionRange, Transaction, TransactionSpec } from '@codemirror/state';
import { EditorView, KeyBinding, keymap, ViewPlugin } from '@codemirror/view';
import { type Editor, editorEditorField, editorInfoField, editorLivePreviewField, Notice, Platform } from 'obsidian';
import { cellFollowsCaret, cellSelected, cellSelection, TABLE_CLASS } from './cells';
import { Action, arrow, backspace, blankLinesAbove, caretInTable, clearCells, Context, copied, deleteForward, Direction, enter, escape, Landing, landing, noCells, noteEnd, opensCell, option, page, rowEnd, selectedTable, shifted, shiftedRowEnd, stay, stopsEdit, tab, typeBelow, typesText, writesCell } from './decide';
import { frozenTables } from './freeze';
import { openCells, type OwnCell, ownSpans, ownTables, viewLayout } from './layout';
import type { Span } from './table-text';

/** On the editor while a table is selected; styles.css hides the caret then, as Obsidian does for images. */
export const SELECTED_CLASS = 'selectable-tables-selected';
/** On every editor while the plugin is on; styles.css scopes what it changes in Obsidian's tables to it. */
const ACTIVE_CLASS = 'selectable-tables';
/** On the scroller while Vim is driving: in its normal and visual modes, and off in insert mode. */
const VIM_CLASS = 'cm-vimMode';

/** Where Ctrl+Option types nothing, so Ctrl+Alt isn't AltGr; and where Cmd, not Ctrl, goes with Shift to the table's edge. */
const APPLE = Platform.isMacOS || Platform.isIosApp;

/** The editor Obsidian opens inside a table cell. */
function cellWidget(view: EditorView): HTMLElement | null {
	return view.dom.parentElement?.closest<HTMLElement>(`.${TABLE_CLASS}`) ?? null;
}

/** The note's own editor, in Live Preview, with the keyboard and no composition under way. */
function active(view: EditorView): boolean {
	return view.hasFocus && !view.compositionStarted && view.state.field(editorLivePreviewField, false) === true && !cellWidget(view);
}

/** Whether the key being handled is a held key's repeat, read as each key comes in, before its bindings run. */
let keyRepeat = false;

/** Whether Vim is driving: its normal and visual modes. */
const vimDriving = (view: EditorView) => view.scrollDOM.classList.contains(VIM_CLASS);

function context(view: EditorView): Context {
	const layout = viewLayout(view);
	return {
		state: view.state,
		layout,
		cells: view.plugin(cellSelection) ?? noCells,
		stops: layout.ownTables === true && !keyRepeat && !vimDriving(view),
		leavesLine(forward) {
			const range = view.state.selection.main;
			const line = view.state.doc.lineAt(range.head);
			const moved = view.moveVertically(range, forward);
			return forward ? moved.head > line.to : moved.head < line.from;
		},
	};
}

/**
 * Where a caret passing a table lands: on the line beyond it, at the same horizontal position, on the
 * row next to the table when that line wraps. Without the measurements to do that, the same column.
 */
function land(view: EditorView, range: SelectionRange, table: Span, forward: boolean): SelectionRange {
	const { doc } = view.state;
	const target = doc.lineAt(forward ? table.to + 1 : table.from - 1);
	const start = view.coordsAtPos(range.head, range.assoc || -1);
	if (start) {
		const block = view.lineBlockAt(target.from);
		const half = Math.min(view.defaultLineHeight, block.height) / 2;
		const y = view.documentTop + (forward ? block.top + half : block.bottom - half);
		const distance = forward ? y - start.bottom : start.top - y;
		if (distance > 0) {
			const moved = view.moveVertically(range, forward, distance);
			if (moved.head >= target.from && moved.head <= target.to) return moved;
		}
	}
	const column = range.head - doc.lineAt(range.head).from;
	return EditorSelection.cursor(target.from + Math.min(column, target.length), 0, undefined, range.goalColumn);
}

/**
 * Where a caret goes on from a table ↑ or ↓ stopped on: the line beyond it, at the place across that the caret had
 * before the table, `goal` px from the content's left, as CodeMirror keeps it for ↑ and ↓. On the row next to the
 * table when that line wraps.
 */
function landBeyond(view: EditorView, table: Span, forward: boolean, goal: number): SelectionRange {
	const target = view.state.doc.lineAt(forward ? table.to + 1 : table.from - 1);
	const block = view.lineBlockAt(target.from);
	const half = Math.min(view.defaultLineHeight, block.height) / 2;
	const y = view.documentTop + (forward ? block.top + half : block.bottom - half);
	const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + goal, y }, false);
	return EditorSelection.cursor(pos >= target.from && pos <= target.to ? pos : forward ? target.from : target.to, 0, undefined, goal);
}

/** The caret's place across, as CodeMirror keeps it for ↑ and ↓, or measured from where it's drawn. */
function goalOf(view: EditorView, range: SelectionRange): number | undefined {
	if (range.goalColumn !== undefined) return range.goalColumn;
	const coords = view.coordsAtPos(range.head, range.assoc || -1);
	return coords ? coords.left - view.contentDOM.getBoundingClientRect().left : undefined;
}

function caret(pos: number): TransactionSpec {
	return { selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'select' };
}

/** Selects exactly a table, scrolled to the side it was selected from, keeping a caret's place across for ↑ and ↓. */
function selecting(table: Span, fromAbove: boolean, goal?: number): TransactionSpec {
	// A range alone would be read as an anchor and a head, and lose the place across ↑ and ↓ go on at.
	return { selection: EditorSelection.create([wholeTable(table, fromAbove, goal)]), effects: EditorView.scrollIntoView(fromAbove ? table.from : table.to), userEvent: 'select' };
}

/**
 * What Backspace, Delete, Cut and Paste do to a selected cell or a range of cells of the plugin's own table, set by a
 * preview build (src/own-table/table-commands.ts), so a release carries none of it.
 */
export interface CellEdits {
	/** Empties the selected cell or the range's cells, or deletes the range's rows or columns: Delete is `forward`. */
	clear(view: EditorView, forward: boolean): void;
	/** Pastes cells copied from a table at the selected cell or the range's first, or text into the selected cell. */
	paste(view: EditorView, data: DataTransfer): void;
}

let cellEdits: CellEdits | null = null;

export function setCellEdits(edits: CellEdits | null): void {
	cellEdits = edits;
}

function run(view: EditorView, action: Action | null): boolean {
	if (!action) return false;
	const { main } = view.state.selection;
	switch (action.type) {
		case 'stay':
			return true;
		case 'caret':
			view.dispatch(caret(action.pos));
			return true;
		case 'select':
			view.dispatch(selecting(action.table, action.fromAbove));
			return true;
		case 'stop':
			view.dispatch(selecting(action.table, action.fromAbove, goalOf(view, main)));
			return true;
		case 'pass': {
			// From a table ↑ or ↓ stopped on, the caret goes on at the place it had before the table.
			const onTable = !main.empty && main.goalColumn !== undefined;
			const to = onTable ? EditorSelection.create([landBeyond(view, action.table, action.forward, main.goalColumn)]) : land(view, main, action.table, action.forward);
			view.dispatch({ selection: to, scrollIntoView: true, userEvent: 'select' });
			return true;
		}
		case 'extendPast': {
			const head = land(view, main, action.table, action.forward);
			view.dispatch({ selection: EditorSelection.range(main.anchor, head.head, head.goalColumn), scrollIntoView: true, userEvent: 'select' });
			return true;
		}
		case 'extendTo':
			view.dispatch({ selection: EditorSelection.range(main.anchor, action.pos), scrollIntoView: true, userEvent: 'select' });
			return true;
		case 'cell':
			view.plugin(cellSelection)?.select(action.cell, action.toward);
			if (action.toward) view.plugin(frozenTables)?.backToStart(action.toward);
			return true;
		case 'range':
			view.plugin(cellSelection)?.selectRange(action.anchor, action.cell, action.toward);
			return true;
		case 'table':
			view.plugin(cellSelection)?.climb();
			return true;
		case 'open':
			view.plugin(cellSelection)?.opening();
			// Obsidian scrolls the cell into view as it opens. Scrolling to a caret in a tall table wouldn't.
			view.dispatch({ selection: EditorSelection.cursor(action.pos), userEvent: 'select', annotations: opensCell.of(true) });
			return true;
		case 'edit': {
			const table = selectedTable(view.state, viewLayout(view));
			const own = table && view.state.facet(ownTables)?.table(view, table.from);
			if (!own) return true;
			view.plugin(cellSelection)?.opening();
			own.openCell(action.cell);
			return true;
		}
		case 'clear':
			cellEdits?.clear(view, action.forward);
			return true;
		case 'refuse':
			view.plugin(cellSelection)?.refuse();
			new Notice('This table can\'t open from the keyboard. Click a cell to edit it.');
			return true;
		case 'below':
			// The cell goes first, so the edit guard sees a selected table. The edit has no user event, which
			// the guard lets through where the table ends the note and the line breaks go right after it.
			// Undo still takes it away with the typing: the history joins an edit to the one before it by the
			// later edit's event, and touching edits that close together count as one.
			view.plugin(cellSelection)?.leave();
			view.dispatch({ changes: { from: action.from, to: action.to, insert: action.insert }, selection: EditorSelection.cursor(action.pos), scrollIntoView: true });
			return true;
	}
}

/**
 * The key just left to Obsidian, which moves the caret within that same key event, for the check on key
 * moves to read. It's gone once the event is over.
 */
let leftToObsidian: { view: EditorView; key: Landing['left'] } | null = null;

function leaveToObsidian(view: EditorView, key: Landing['left']): false {
	leftToObsidian = { view, key };
	queueMicrotask(() => {
		leftToObsidian = null;
	});
	return false;
}

function onArrow(direction: Direction, shift: boolean) {
	const decide = (view: EditorView): boolean => {
		if (!active(view)) return false;
		// Obsidian's own ← and → handle a selected image first.
		if ((direction === 'left' || direction === 'right') && view.dom.closest('.mod-image-selected')) return false;
		return run(view, arrow(context(view), direction, shift));
	};
	return (view: EditorView): boolean => decide(view) || leaveToObsidian(view, 'arrow');
}

/** A selection of exactly a table, from the side the keys can later go back to, with a caret's place across for ↑ and ↓. */
export function wholeTable({ from, to }: Span, fromAbove: boolean, goal?: number): SelectionRange {
	return fromAbove ? EditorSelection.range(from, to, goal) : EditorSelection.range(to, from, goal);
}

/**
 * Escape in a cell closes it and selects that cell, the way Escape in an image's link selects the image.
 * A table whose cell Enter opened keeps the side it was selected from. Gives the note's editor, or null
 * when this isn't a cell's editor.
 */
export function escapeCell(view: EditorView): EditorView | null {
	const own = openCells.get(view);
	if (own && own.view === view) return escapeOwnCell(own);
	const widget = cellWidget(view);
	const outer = widget?.parentElement?.closest<HTMLElement>('.cm-editor');
	const main = outer ? EditorView.findFromDOM(outer) : null;
	if (!widget || !main || main.state.field(editorLivePreviewField, false) !== true) return null;
	const table = viewLayout(main).tableAt(main.posAtDOM(widget));
	if (!table) return null;
	const cell = view.dom.closest<HTMLTableCellElement>('td, th');
	const row = cell?.closest<HTMLTableRowElement>('tr');
	const cells = main.plugin(cellSelection);
	const fromAbove = cells?.fromAbove(table) ?? false;
	// A range dragged across cells goes only when the selection leaves the table, so it leaves first.
	if (widget.classList.contains('has-selection')) {
		const beside = table.from > 0 ? table.from - 1 : table.to < main.state.doc.length ? table.to + 1 : null;
		if (beside !== null) main.dispatch({ selection: EditorSelection.cursor(beside), userEvent: 'select' });
	}
	main.dispatch({ selection: wholeTable(table, fromAbove), userEvent: 'select' });
	// Obsidian closes the cell when its note's editor takes the focus back. If anything in that moves
	// the table's end, the whole table is selected again from what's there now.
	main.focus();
	const now = viewLayout(main).tableAt(main.state.selection.main.from);
	if (!now) return main;
	if (main.state.selection.main.from !== now.from || main.state.selection.main.to !== now.to) {
		main.dispatch({ selection: wholeTable(now, fromAbove), userEvent: 'select' });
	}
	if (cell && row) cells?.select({ row: row.rowIndex, column: cell.cellIndex });
	return main;
}

/**
 * The same for an open cell of the plugin's own table: it closes, and the cell is selected, with its table selected
 * whole from the side it was selected from. The note takes the keyboard first, or CodeMirror would read the browser's
 * old selection back right after.
 */
function escapeOwnCell(own: OwnCell): EditorView {
	const main = own.note;
	const table = own.table();
	const { cell } = own;
	const cells = main.plugin(cellSelection);
	const fromAbove = table ? (cells?.fromAbove(table) ?? false) : false;
	own.close();
	main.contentDOM.focus({ preventScroll: true });
	if (!table) return main;
	main.dispatch({ selection: wholeTable(table, fromAbove), userEvent: 'select' });
	cells?.select(cell);
	return main;
}

type Keys = Pick<KeyBinding, 'key' | 'mac'>;
type Jump = (context: Context) => Action | null;

/** Shift with a key that does nothing on a selected cell or a range of cells, as with Option and an arrow on a Mac. */
const shiftStays: Jump = ({ cells }) => cells.selected && { type: 'stay' };

/** A key that jumps in the note's editor. With Shift, it stretches a range of cells, or does nothing, as `shift` says. */
function jumpKey(keys: Keys, jump: Jump, shift: Jump): KeyBinding {
	return {
		...keys,
		run: (view) => active(view) && run(view, jump(context(view))),
		shift: (view) => active(view) && run(view, shift(context(view))),
	};
}

/**
 * The same, for a key that also jumps out of an open cell. Obsidian binds these in a cell's editor as
 * plain keys that hand over to the note, and this runs first. It's Escape and the jump in one press,
 * which leaves a cell selected: opening the next one takes a caret, and a caret right after a cell is
 * trimmed is what can eat a table's pipes, so Enter opens it, through Enter's check.
 */
function cellJumpKey(keys: Keys, jump: (context: Context, forward: boolean) => Action | null, forward: boolean): KeyBinding {
	const go: Jump = (c) => jump(c, forward);
	return {
		...jumpKey(keys, go, (c) => shifted(c, forward ? 'down' : 'up')),
		run(view) {
			if (active(view)) return run(view, go(context(view))) || leaveToObsidian(view, forward ? 'jump down' : 'jump up');
			const main = view.hasFocus && !view.compositionStarted ? escapeCell(view) : null;
			if (main) run(main, go(context(main)));
			return main !== null;
		},
	};
}

const bindings: KeyBinding[] = [
	// Every key, before its own bindings: whether it's a held key's repeat, which ↑ and ↓ pass tables on.
	{
		any: (_, event) => {
			keyRepeat = event.repeat;
			return false;
		},
	},
	// Held down, Enter stops at the selected table or cell. Its repeats would walk on into a cell, and
	// from there add rows. This comes first so it runs ahead of the key's own binding.
	{ any: (view, event) => event.key === 'Enter' && event.repeat && active(view) && selectedTable(view.state, viewLayout(view)) !== null },
	{ key: 'ArrowDown', run: onArrow('down', false), shift: onArrow('down', true) },
	{ key: 'ArrowUp', run: onArrow('up', false), shift: onArrow('up', true) },
	{ key: 'ArrowRight', run: onArrow('right', false), shift: onArrow('right', true) },
	{ key: 'ArrowLeft', run: onArrow('left', false), shift: onArrow('left', true) },
	{
		key: 'Enter',
		run: (view) => active(view) && run(view, enter(context(view))),
		// Shift+Enter would type a line break over the table: it does nothing.
		shift: (view) => active(view) && run(view, stay(view.state, viewLayout(view))),
	},
	{ key: 'Delete', run: (view) => active(view) && run(view, clearCells(context(view), true) ?? deleteForward(view.state, viewLayout(view))) },
	{ key: 'Backspace', run: (view) => active(view) && run(view, clearCells(context(view), false) ?? backspace(view.state, viewLayout(view))) },
	{
		key: 'Escape',
		run: (view) => (active(view) ? run(view, escape(context(view))) : view.hasFocus && escapeCell(view) !== null),
	},
	{
		key: 'Tab',
		run: (view) => active(view) && run(view, tab(context(view), true)),
		shift: (view) => active(view) && run(view, tab(context(view), false)),
	},
	jumpKey({ key: 'Home' }, (c) => rowEnd(c, false), (c) => shiftedRowEnd(c, false)),
	jumpKey({ mac: 'Cmd-ArrowLeft' }, (c) => rowEnd(c, false), (c) => shiftedRowEnd(c, false)),
	jumpKey({ key: 'End' }, (c) => rowEnd(c, true), (c) => shiftedRowEnd(c, true)),
	jumpKey({ mac: 'Cmd-ArrowRight' }, (c) => rowEnd(c, true), (c) => shiftedRowEnd(c, true)),
	cellJumpKey({ key: 'PageUp' }, page, false),
	cellJumpKey({ mac: 'Ctrl-ArrowUp' }, page, false),
	cellJumpKey({ key: 'PageDown' }, page, true),
	cellJumpKey({ mac: 'Ctrl-ArrowDown' }, page, true),
	cellJumpKey({ key: 'Mod-Home' }, noteEnd, false),
	cellJumpKey({ mac: 'Cmd-ArrowUp' }, noteEnd, false),
	cellJumpKey({ key: 'Mod-End' }, noteEnd, true),
	cellJumpKey({ mac: 'Cmd-ArrowDown' }, noteEnd, true),
	// On Windows and Linux, Ctrl+Shift with an arrow stretches a range of cells to the table's edge, as in a spreadsheet, as
	// Shift+Cmd does on a Mac. Option+Shift with an arrow does nothing on a Mac.
	jumpKey({ key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft' }, (c) => option(c, false), APPLE ? shiftStays : (c) => shifted(c, 'left')),
	jumpKey({ key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight' }, (c) => option(c, true), APPLE ? shiftStays : (c) => shifted(c, 'right')),
	jumpKey({ mac: 'Alt-ArrowUp' }, (c) => option(c, false), shiftStays),
	jumpKey({ mac: 'Alt-ArrowDown' }, (c) => option(c, true), shiftStays),
	{ win: 'Shift-Ctrl-ArrowUp', linux: 'Shift-Ctrl-ArrowUp', run: (view) => active(view) && run(view, shifted(context(view), 'up')) },
	{ win: 'Shift-Ctrl-ArrowDown', linux: 'Shift-Ctrl-ArrowDown', run: (view) => active(view) && run(view, shifted(context(view), 'down')) },
];

/**
 * The selected table of each editor state, recorded as the editor draws it. The edit guard below reads
 * it, since a transaction filter sees states but not the editor that shows which tables are rendered.
 * Only drawn states are recorded, which covers every key press: keys dispatch from the drawn state.
 */
const selectedTables = new WeakMap<EditorState, Span>();

const markSelectedTable = EditorView.editorAttributes.of((view) => {
	if (view.state.selection.main.empty || view.state.field(editorLivePreviewField, false) !== true) return null;
	const table = selectedTable(view.state, viewLayout(view));
	if (!table) return null;
	selectedTables.set(view.state, table);
	return { class: SELECTED_CLASS };
});

/**
 * Whether typing on a selected table or cell can start a paragraph below it now. Vim's normal mode has its
 * own letters. This runs on every key that types, so the cheapest test comes first.
 */
function typesBelow(view: EditorView): boolean {
	return selectedTables.has(view.state) && active(view) && !vimDriving(view);
}

/**
 * A key that types on a selected table or cell starts a new paragraph below the table, and its text goes
 * there. The caret moves on the key's keydown, which comes before the text, and the browser then types at
 * the new caret, so Obsidian's own handling of typed text, such as closing brackets, still runs. An input
 * method left alone replaces a selected table with its first letter and puts the rest elsewhere; its
 * keydown comes before its composition, and that's the only safe moment to move the caret: moving it once
 * the composition runs leaves it stuck, and Live Preview stops drawing until it ends. An input method with
 * no keydown is left alone.
 *
 * Text the keydown didn't see, such as from the emoji picker or dictation, goes below the table too, and
 * other text input on a selected table stays stopped, since the browser's caret can't sit across the
 * table. On a selected cell, no other input goes through. Copy gives the cell, not the table underneath
 * it. On the plugin's own table, Cut copies, then empties the cell or deletes the range as Backspace does,
 * and Paste writes over them (`cellEdits`); on Obsidian's table they do nothing.
 */
const selectedEvents = EditorView.domEventHandlers({
	keydown(event, view) {
		if (!event.defaultPrevented && !event.isComposing && typesText(event, APPLE) && typesBelow(view)) run(view, typeBelow({ state: view.state, layout: viewLayout(view), cells: noCells }));
		return false;
	},
	beforeinput(event, view) {
		const typed = event.inputType === 'insertText' || event.inputType === 'insertReplacementText';
		if (typed && event.data && typesBelow(view) && run(view, typeBelow({ state: view.state, layout: viewLayout(view), cells: noCells }))) {
			view.dispatch({ ...view.state.replaceSelection(event.data), scrollIntoView: true, userEvent: 'input.type' });
			return true;
		}
		if (cellSelected(view.state)) return event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo';
		return typed && selectedTables.has(view.state);
	},
	copy: (event, view) => copyCells(view, event.clipboardData),
	cut(event, view) {
		if (!cellSelected(view.state)) return false;
		if (viewLayout(view).ownTables && cellEdits && copyCells(view, event.clipboardData)) cellEdits.clear(view, false);
		return true;
	},
	paste(event, view) {
		if (!cellSelected(view.state)) return false;
		if (viewLayout(view).ownTables && event.clipboardData) cellEdits?.paste(view, event.clipboardData);
		return true;
	},
});

/** Copies a selected cell's text, or a range of the plugin's own table as a table, to `data`. Says whether there was one. */
function copyCells(view: EditorView, data: DataTransfer | null): boolean {
	const what = copied(context(view));
	if (!what) return false;
	if ('text' in what) data?.setData('text/plain', what.text);
	else for (const [type, value] of view.state.facet(ownTables)?.table(view, what.table.from)?.copy(what.anchor, what.head) ?? []) data?.setData(type, value);
	return true;
}

const keepSelectedTable = EditorState.transactionFilter.of((tr) => {
	const table = tr.docChanged ? selectedTables.get(tr.startState) : undefined;
	return table && stopsEdit(tr, table, cellSelected(tr.startState)) ? [] : tr;
});

/**
 * The check on key moves, with its rule in decide.ts. It reaches the editor through a state field, since a
 * transaction filter sees only states. Each caret move a key makes pays for this: one block lookup.
 */
const keepCellsClosed = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection || tr.docChanged) return tr;
	const view = tr.startState.field(editorEditorField, false);
	if (!view || view.state !== tr.startState) return tr;
	const action = landing(tr, {
		layout: viewLayout(view),
		active: active(view),
		vim: vimDriving(view),
		left: leftToObsidian?.view === view ? leftToObsidian.key : null,
		cellSelected: cellSelected(tr.startState),
	});
	if (!action) return tr;
	if (action.type === 'caret') return caret(action.pos);
	return action.type === 'select' ? selecting(action.table, action.fromAbove) : [];
});

/**
 * The blank line above the plugin's own table stays: an edit that leaves text right against the table, such as typing
 * on that line, puts a line break back at the table's start, in the same step, so one Undo takes both back. Obsidian
 * does this for its own table only. Undo, Redo, Sync and a second pane put back text as it was, and a running
 * composition is never touched.
 */
const keepLineAbove = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged || tr.isUserEvent('input.type.compose') || tr.annotation(Transaction.remote) || ['undo', 'redo', 'set'].some((event) => tr.isUserEvent(event))) return tr;
	const tables = ownSpans(tr.startState);
	const breaks = tables?.length ? blankLinesAbove(tr, tables) : [];
	return breaks.length ? [tr, { changes: breaks.map((from) => ({ from, insert: '\n' })), sequential: true }] : tr;
});

/** A move that comes with its own rule: a press, Enter's caret that opens a cell, and an open cell's write. */
const ownRule = (tr: Transaction) => tr.isUserEvent('select.pointer') || tr.annotation(opensCell) === true || tr.annotation(writesCell) === true;

/** Whether the note's selection is in its open cell's text, where the open cell takes it, as an undo puts it back. */
function inOpenCell(view: EditorView): boolean {
	const { main } = view.state.selection;
	return !!openCells.get(view)?.holds(Math.min(main.anchor, main.head), Math.max(main.anchor, main.head));
}

/**
 * The caret rule, with its decision in decide.ts: a selection put inside the plugin's own table by anything but a key
 * or a press selects the table and the cell holding it. Keys have their rule in the check on key moves. It runs right
 * after the update, as its own step, and never during a composition or while Vim is driving.
 */
const cellsFromCarets = ViewPlugin.define((view) => ({
	update(update) {
		if (!update.selectionSet || update.transactions.some(ownRule) || view.compositionStarted || vimDriving(view)) return;
		if (inOpenCell(view) || !caretInTable(update.state, viewLayout(view))) return;
		// Read again once the task's other dispatches are in: Find's close and a Search pane result each dispatch again
		// right after putting the selection there.
		queueMicrotask(() => {
			if (view.compositionStarted || vimDriving(view) || inOpenCell(view)) return;
			const found = caretInTable(view.state, viewLayout(view));
			if (!found) return;
			view.dispatch({ selection: wholeTable(found.table, true) });
			view.plugin(cellSelection)?.select(found.cell);
		});
	},
}));

/** The editors open now, so a command can find the one behind the editor Obsidian gives it. */
const views = new Set<EditorView>();

const knownViews = ViewPlugin.define((view) => {
	views.add(view);
	return { destroy: () => views.delete(view) };
});

/**
 * The note's editor in Live Preview behind an editor Obsidian gives a command. Obsidian gives the note's
 * editor even while one of its cells is open, and a cell's editor carries the note's info too, so it's
 * left out.
 */
export function noteView(editor: Editor): EditorView | null {
	for (const view of views) {
		if (view.state.field(editorInfoField, false)?.editor === editor && view.state.field(editorLivePreviewField, false) === true && !cellWidget(view)) return view;
	}
	return null;
}

/**
 * The whole feature, for Plugin.registerEditorExtension. Obsidian adds it to cell editors too. On the plugin's own
 * table (a preview build's switch), its tables pin frozen rows and columns themselves (src/own-table/pins.ts), so
 * `frozen` is off.
 */
export function selectableTables({ frozen = true }: { frozen?: boolean } = {}): Extension {
	const freezing = frozen ? [cellFollowsCaret, frozenTables] : [];
	return [Prec.highest(keymap.of(bindings)), Prec.highest(selectedEvents), keepSelectedTable, keepCellsClosed, keepLineAbove, markSelectedTable, cellSelection, cellsFromCarets, knownViews, ...freezing, EditorView.editorAttributes.of({ class: ACTIVE_CLASS })];
}
