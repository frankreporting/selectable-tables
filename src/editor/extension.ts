import { EditorSelection, EditorState, Extension, Prec, SelectionRange, TransactionSpec } from '@codemirror/state';
import { EditorView, KeyBinding, keymap } from '@codemirror/view';
import { editorEditorField, editorLivePreviewField, Notice } from 'obsidian';
import { cellSelected, cellSelection, TABLE_CLASS } from './cells';
import { Action, arrow, Context, copied, deleteForward, Direction, enter, escape, Landing, landing, noCells, noteEnd, opensCell, option, page, rowEnd, selectedTable, shifted, stay, stopsEdit, tab } from './decide';
import { viewLayout } from './layout';
import type { Span } from './table-text';

/** On the editor while a table is selected; styles.css hides the caret then, as Obsidian does for images. */
export const SELECTED_CLASS = 'selectable-tables-selected';
/** On every editor while the plugin is on; styles.css scopes what it changes in Obsidian's tables to it. */
const ACTIVE_CLASS = 'selectable-tables';
/** On the scroller while Vim is driving: in its normal and visual modes, and off in insert mode. */
const VIM_CLASS = 'cm-vimMode';

/** The editor Obsidian opens inside a table cell. */
function cellWidget(view: EditorView): HTMLElement | null {
	return view.dom.parentElement?.closest<HTMLElement>(`.${TABLE_CLASS}`) ?? null;
}

/** The note's own editor, in Live Preview, with the keyboard and no composition under way. */
function active(view: EditorView): boolean {
	return view.hasFocus && !view.composing && view.state.field(editorLivePreviewField, false) === true && !cellWidget(view);
}

function context(view: EditorView): Context {
	return {
		state: view.state,
		layout: viewLayout(view),
		cells: view.plugin(cellSelection) ?? noCells,
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

function caret(pos: number): TransactionSpec {
	return { selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'select' };
}

/** Selects exactly a table, scrolled to the side it was selected from. */
function selecting(table: Span, fromAbove: boolean): TransactionSpec {
	return { selection: wholeTable(table, fromAbove), effects: EditorView.scrollIntoView(fromAbove ? table.from : table.to), userEvent: 'select' };
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
		case 'pass':
			view.dispatch({ selection: land(view, main, action.table, action.forward), scrollIntoView: true, userEvent: 'select' });
			return true;
		case 'extendPast': {
			const head = land(view, main, action.table, action.forward);
			view.dispatch({ selection: EditorSelection.range(main.anchor, head.head, head.goalColumn), scrollIntoView: true, userEvent: 'select' });
			return true;
		}
		case 'extendTo':
			view.dispatch({ selection: EditorSelection.range(main.anchor, action.pos), scrollIntoView: true, userEvent: 'select' });
			return true;
		case 'cell':
			view.plugin(cellSelection)?.select(action.cell);
			return true;
		case 'table':
			view.plugin(cellSelection)?.climb();
			return true;
		case 'open':
			view.plugin(cellSelection)?.opening();
			// Obsidian scrolls the cell into view as it opens. Scrolling to a caret in a tall table wouldn't.
			view.dispatch({ selection: EditorSelection.cursor(action.pos), userEvent: 'select', annotations: opensCell.of(true) });
			return true;
		case 'refuse':
			view.plugin(cellSelection)?.refuse();
			new Notice('This table can\'t open from the keyboard. Click a cell to edit it.');
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

/** A selection of exactly a table, from the side the keys can later go back to. */
function wholeTable({ from, to }: Span, fromAbove: boolean): SelectionRange {
	return fromAbove ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
}

/**
 * Escape in a cell closes it and selects that cell, the way Escape in an image's link selects the image.
 * A table whose cell Enter opened keeps the side it was selected from. Gives the note's editor, or null
 * when this isn't a cell's editor.
 */
function escapeCell(view: EditorView): EditorView | null {
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

type Jump = (context: Context) => Action | null;

/** A key that jumps in the note's editor. With Shift, it does nothing on a selected cell. */
function jumpKey(keys: Pick<KeyBinding, 'key' | 'mac'>, jump: Jump): KeyBinding {
	return {
		...keys,
		run: (view) => active(view) && run(view, jump(context(view))),
		shift: (view) => active(view) && run(view, shifted(context(view))),
	};
}

/**
 * The same, for a key that also jumps out of an open cell. Obsidian binds these in a cell's editor as
 * plain keys that hand over to the note, and this runs first. It's Escape and the jump in one press,
 * which leaves a cell selected: opening the next one takes a caret, and a caret right after a cell is
 * trimmed is what can eat a table's pipes, so Enter opens it, through Enter's check.
 */
function cellJumpKey(keys: Pick<KeyBinding, 'key' | 'mac'>, jump: Jump): KeyBinding {
	return {
		...jumpKey(keys, jump),
		run(view) {
			if (active(view)) return run(view, jump(context(view))) || leaveToObsidian(view, 'big jump');
			const main = view.hasFocus && !view.composing ? escapeCell(view) : null;
			if (main) run(main, jump(context(main)));
			return main !== null;
		},
	};
}

const bindings: KeyBinding[] = [
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
	{ key: 'Delete', run: (view) => active(view) && run(view, deleteForward(view.state, viewLayout(view))) },
	{
		key: 'Escape',
		run: (view) => (active(view) ? run(view, escape(context(view))) : view.hasFocus && escapeCell(view) !== null),
	},
	{
		key: 'Tab',
		run: (view) => active(view) && run(view, tab(context(view), true)),
		shift: (view) => active(view) && run(view, tab(context(view), false)),
	},
	jumpKey({ key: 'Home' }, (c) => rowEnd(c, false)),
	jumpKey({ mac: 'Cmd-ArrowLeft' }, (c) => rowEnd(c, false)),
	jumpKey({ key: 'End' }, (c) => rowEnd(c, true)),
	jumpKey({ mac: 'Cmd-ArrowRight' }, (c) => rowEnd(c, true)),
	cellJumpKey({ key: 'PageUp' }, (c) => page(c, false)),
	cellJumpKey({ mac: 'Ctrl-ArrowUp' }, (c) => page(c, false)),
	cellJumpKey({ key: 'PageDown' }, (c) => page(c, true)),
	cellJumpKey({ mac: 'Ctrl-ArrowDown' }, (c) => page(c, true)),
	cellJumpKey({ key: 'Mod-Home' }, (c) => noteEnd(c, false)),
	cellJumpKey({ mac: 'Cmd-ArrowUp' }, (c) => noteEnd(c, false)),
	cellJumpKey({ key: 'Mod-End' }, (c) => noteEnd(c, true)),
	cellJumpKey({ mac: 'Cmd-ArrowDown' }, (c) => noteEnd(c, true)),
	jumpKey({ key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft' }, (c) => option(c, false)),
	jumpKey({ key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight' }, (c) => option(c, true)),
	jumpKey({ mac: 'Alt-ArrowUp' }, (c) => option(c, false)),
	jumpKey({ mac: 'Alt-ArrowDown' }, (c) => option(c, true)),
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
 * Typing on a selected table does nothing, so a stray key can't change it. This stops the browser's
 * text input itself: with the table selected, the browser's own caret can't sit across the table, so
 * a typed character would otherwise land on the line below. On a selected cell, no input goes through.
 * Copy gives the cell, not the table underneath it, and Cut and Paste do nothing.
 */
const selectedEvents = EditorView.domEventHandlers({
	beforeinput(event, view) {
		if (cellSelected(view.state)) return event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo';
		if (event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText') return false;
		return selectedTables.has(view.state);
	},
	// An input method composes past beforeinput, and at a note's start or right below the properties it
	// would replace the selected table. Its keydown comes first, with key code 229, and the caret steps
	// beside the table then. Moving the selection any later leaves the composition stuck, and Live Preview
	// stops drawing until it ends, so an input method with no keydown is left alone.
	keydown(event, view) {
		if (event.keyCode === 229 && !view.compositionStarted && selectedTables.has(view.state)) run(view, escape({ ...context(view), cells: noCells }));
		return false;
	},
	copy(event, view) {
		const text = copied(context(view));
		if (text === null) return false;
		event.clipboardData?.setData('text/plain', text);
		return true;
	},
	cut: (_, view) => cellSelected(view.state),
	paste: (_, view) => cellSelected(view.state),
});

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
		vim: view.scrollDOM.classList.contains(VIM_CLASS),
		left: leftToObsidian?.view === view ? leftToObsidian.key : null,
		cellSelected: cellSelected(tr.startState),
	});
	if (!action) return tr;
	if (action.type === 'caret') return caret(action.pos);
	return action.type === 'select' ? selecting(action.table, action.fromAbove) : [];
});

/** The whole feature, for Plugin.registerEditorExtension. Obsidian adds it to cell editors too. */
export function selectableTables(): Extension {
	return [Prec.highest(keymap.of(bindings)), Prec.highest(selectedEvents), keepSelectedTable, keepCellsClosed, markSelectedTable, cellSelection, EditorView.editorAttributes.of({ class: ACTIVE_CLASS })];
}
