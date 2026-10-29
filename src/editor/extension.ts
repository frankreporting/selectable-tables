import { EditorSelection, EditorState, Extension, Prec, SelectionRange } from '@codemirror/state';
import { EditorView, KeyBinding, keymap } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { Action, arrow, Context, Direction, enter, escape, selectedTable, tab } from './decide';
import { viewLayout } from './layout';
import type { Span } from './table-text';

/** On the editor while a table is selected; styles.css hides the caret then, as Obsidian does for images. */
export const SELECTED_CLASS = 'selectable-tables-selected';
const TABLE_CLASS = 'cm-table-widget';

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

function run(view: EditorView, action: Action | null): boolean {
	if (!action) return false;
	const { main } = view.state.selection;
	switch (action.type) {
		case 'stay':
			return true;
		case 'caret':
			view.dispatch({ selection: EditorSelection.cursor(action.pos), scrollIntoView: true, userEvent: 'select' });
			return true;
		case 'select': {
			const { table, fromAbove } = action;
			view.dispatch({
				selection: fromAbove ? EditorSelection.range(table.from, table.to) : EditorSelection.range(table.to, table.from),
				effects: EditorView.scrollIntoView(fromAbove ? table.from : table.to),
				userEvent: 'select',
			});
			return true;
		}
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
	}
}

function onArrow(direction: Direction, shift: boolean) {
	return (view: EditorView): boolean => {
		if (!active(view)) return false;
		// Obsidian's own ← and → handle a selected image first.
		if ((direction === 'left' || direction === 'right') && view.dom.closest('.mod-image-selected')) return false;
		return run(view, arrow(context(view), direction, shift));
	};
}

/** Escape in a cell closes it and selects the whole table, the way Escape in an image's link does. */
function escapeCell(view: EditorView): boolean {
	const widget = cellWidget(view);
	const outer = widget?.parentElement?.closest<HTMLElement>('.cm-editor');
	const main = outer ? EditorView.findFromDOM(outer) : null;
	if (!widget || !main || main.state.field(editorLivePreviewField, false) !== true) return false;
	const table = viewLayout(main).tableAt(main.posAtDOM(widget));
	if (!table) return false;
	main.dispatch({ selection: EditorSelection.range(table.to, table.from), userEvent: 'select' });
	// Obsidian closes the cell when its note's editor takes the focus back. If anything in that moves
	// the table's end, the whole table is selected again from what's there now.
	main.focus();
	const now = viewLayout(main).tableAt(main.state.selection.main.from);
	if (now && (main.state.selection.main.from !== now.from || main.state.selection.main.to !== now.to)) {
		main.dispatch({ selection: EditorSelection.range(now.to, now.from), userEvent: 'select' });
	}
	return true;
}

const bindings: KeyBinding[] = [
	{ key: 'ArrowDown', run: onArrow('down', false), shift: onArrow('down', true) },
	{ key: 'ArrowUp', run: onArrow('up', false), shift: onArrow('up', true) },
	{ key: 'ArrowRight', run: onArrow('right', false), shift: onArrow('right', true) },
	{ key: 'ArrowLeft', run: onArrow('left', false), shift: onArrow('left', true) },
	{
		key: 'Enter',
		run: (view) => active(view) && run(view, enter(view.state, viewLayout(view))),
		// Shift+Enter would type a line break over the table: it does nothing, like Tab.
		shift: (view) => active(view) && run(view, tab(view.state, viewLayout(view))),
	},
	{
		key: 'Escape',
		run: (view) => (active(view) ? run(view, escape(view.state, viewLayout(view))) : view.hasFocus && escapeCell(view)),
	},
	{
		key: 'Tab',
		run: (view) => active(view) && run(view, tab(view.state, viewLayout(view))),
		shift: (view) => active(view) && run(view, tab(view.state, viewLayout(view))),
	},
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
 * a typed character would otherwise land on the line below.
 */
const stopTyping = EditorView.domEventHandlers({
	beforeinput(event, view) {
		if (event.inputType !== 'insertText' && event.inputType !== 'insertReplacementText') return false;
		return selectedTables.has(view.state);
	},
});

/**
 * Nor can any other key that types into the selected table, such as Shift+Enter, Ctrl+O or an indent
 * key. Edits elsewhere in the note pass. Deleting, cutting, pasting and dropping stay possible: those
 * are meant for the selection. Composed input (IME) is left alone, because dropping it would leave the
 * screen out of step with the note.
 */
const keepSelectedTable = EditorState.transactionFilter.of((tr) => {
	const table = tr.docChanged ? selectedTables.get(tr.startState) : undefined;
	if (!table || !tr.changes.touchesRange(table.from, table.to)) return tr;
	if (tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') || tr.isUserEvent('input.type.compose')) return tr;
	return tr.isUserEvent('input') || tr.isUserEvent('indent') ? [] : tr;
});

/** The whole feature, for Plugin.registerEditorExtension. Obsidian adds it to cell editors too. */
export function selectableTables(): Extension {
	return [Prec.highest(keymap.of(bindings)), Prec.highest(stopTyping), keepSelectedTable, markSelectedTable];
}
