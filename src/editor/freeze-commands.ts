import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { type Command, type Editor, Notice } from 'obsidian';
import { cellSelection, TABLE_CLASS } from './cells';
import { selectedTable, writesFreeze } from './decide';
import { escapeCell, noteView, wholeTable } from './extension';
import { canFreeze } from './freeze';
import { hasMark, MAX_FROZEN_COLUMNS, readFreeze } from './freeze-mark';
import { FreezeCommand, freezeAt, freezeChanges } from './freeze-write';
import { viewLayout } from './layout';
import type { Cell, Span } from './table-text';

/** The cell a command acts on, in a note's table, and the cell's own editor when it's open. */
interface Target {
	view: EditorView;
	table: Span;
	cell: Cell;
	open: EditorView | null;
}

/**
 * The selected cell, or else the open one. An open cell is an editor inside one of the note's table widgets,
 * in the box Obsidian builds beside the cell's rendered text.
 */
function targetOf(editor: Editor): Target | null {
	const view = noteView(editor);
	if (!view) return null;
	const layout = viewLayout(view);
	const selected = view.plugin(cellSelection)?.selected;
	const table = selectedTable(view.state, layout);
	if (table && selected) return { view, table, cell: selected, open: null };
	const open = view.contentDOM.querySelector<HTMLElement>(`:scope > .${TABLE_CLASS} .table-cell-wrapper .cm-editor`);
	const cell = open?.closest<HTMLTableCellElement>('td, th');
	const widget = cell?.closest<HTMLElement>(`.${TABLE_CLASS}`);
	const span = widget ? layout.tableAt(view.posAtDOM(widget)) : null;
	const row = cell?.parentElement as HTMLTableRowElement | null | undefined;
	if (!open || !cell || !row || !span) return null;
	return { view, table: span, cell: { row: row.rowIndex, column: cell.cellIndex }, open: EditorView.findFromDOM(open) };
}

/** Whether a command does anything here: Unfreeze needs a mark, and nothing lies above or left of a table's first cell. */
function offered(command: FreezeCommand, { view, table, cell }: Target): boolean {
	if (command === 'none') return hasMark(view.state.doc.lineAt(table.from).text);
	if (command === 'cell') return cell.row > 0 || cell.column > 0;
	return true;
}

/**
 * Writes a table's new freeze mark, in one step that Undo takes back alone. An open cell closes first, as Escape
 * closes it, and is selected: Obsidian would otherwise route the change to the cell's text through the cell's
 * own editor. The selected cell stays selected, and the whole table stays selected underneath it.
 */
function run(editor: Editor, command: FreezeCommand) {
	const found = targetOf(editor);
	if (found?.open && !escapeCell(found.open)) return;
	const target = found?.open ? targetOf(editor) : found;
	if (!target) return;
	const { view, table, cell } = target;
	const { freeze, clamped } = freezeAt(command, readFreeze(view.state.doc.lineAt(table.from).text), cell);
	if (clamped) new Notice(`A table can freeze up to ${MAX_FROZEN_COLUMNS} columns.`);
	const written = freezeChanges(view.state.doc, table, freeze);
	if (!written) {
		new Notice('This table\'s header row can\'t take the freeze mark where it is. Edit the mark by hand.');
		return;
	}
	if (!written.changes.length) return;
	const { main } = view.state.selection;
	// Kept apart in the history, so that Undo takes back the freeze alone, even with another edit right after it.
	view.dispatch({ changes: written.changes, selection: wholeTable({ from: table.from, to: written.to }, main.anchor < main.head), annotations: [writesFreeze.of(true), isolateHistory.of('full')] });
	if (command !== 'none' && !canFreeze()) new Notice('This device can\'t pin a table\'s rows, so its tables scroll as usual.');
}

function freezeCommand(id: string, name: string, command: FreezeCommand): Command {
	return {
		id,
		name,
		editorCheckCallback(checking, editor) {
			const target = targetOf(editor);
			if (!target || !offered(command, target)) return false;
			if (!checking) run(editor, command);
			return true;
		},
	};
}

/** The freeze commands, offered with a cell of a table selected or open in Live Preview. */
export function freezeCommands(): Command[] {
	return [
		freezeCommand('freeze-rows', 'Freeze rows up to here', 'rows'),
		freezeCommand('freeze-columns', 'Freeze columns up to here', 'columns'),
		freezeCommand('freeze-at-cell', 'Freeze at this cell', 'cell'),
		freezeCommand('unfreeze-table', 'Unfreeze table', 'none'),
	];
}
