import { isolateHistory } from '@codemirror/commands';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { type Command, type Editor, type IconName, type MarkdownFileInfo, type MarkdownView, Menu, Notice } from 'obsidian';
import { cellSelection, TABLE_CLASS } from './cells';
import { selectedTable, writesFreeze } from './decide';
import { escapeCell, noteView, wholeTable } from './extension';
import { canFreeze } from './freeze';
import { hasMark, MAX_FROZEN_COLUMNS, readFreeze } from './freeze-mark';
import { FreezeCommand, freezeAt, freezeChanges } from './freeze-write';
import { viewLayout } from './layout';
import type { Cell, Span } from './table-text';

/** The commands, which the right-click menu offers too. */
const FREEZES: { id: string; name: string; icon: IconName; command: FreezeCommand }[] = [
	{ id: 'freeze-rows', name: 'Freeze rows up to here', icon: 'lucide-panel-top', command: 'rows' },
	{ id: 'freeze-columns', name: 'Freeze columns up to here', icon: 'lucide-panel-left', command: 'columns' },
	{ id: 'freeze-rows-and-columns', name: 'Freeze rows and columns up to here', icon: 'lucide-panels-top-left', command: 'both' },
	{ id: 'unfreeze-table', name: 'Unfreeze table', icon: 'lucide-square', command: 'none' },
];

/** The right-click menu's own section for them, which keeps them together. */
const MENU_SECTION = 'selectable-tables-freeze';

/** On a table's widget while a range of cells is dragged across. */
const RANGE_CLASS = 'has-selection';

/** A cell of one of a note's tables, by its widget, which Obsidian keeps when it builds the table anew. */
interface Place {
	widget: HTMLElement;
	cell: Cell;
}

/** The cell a command acts on, in a note's table, and the cell's own editor when it's open. */
interface Target {
	table: Span;
	cell: Cell;
	open: EditorView | null;
}

/** The cell an element is in, in one of the note's own tables, not a table in some editor inside it. */
function placeOf(view: EditorView, element: Element): Place | null {
	const cell = element.closest<HTMLTableCellElement>('td, th');
	const widget = cell?.closest<HTMLElement>(`.${TABLE_CLASS}`);
	const row = cell?.parentElement as HTMLTableRowElement | null | undefined;
	if (!cell || !row || !widget || widget.parentElement !== view.contentDOM) return null;
	return { widget, cell: { row: row.rowIndex, column: cell.cellIndex } };
}

/** The note's open cell: an editor in the box Obsidian builds beside the cell's rendered text. */
function openCell(view: EditorView): { place: Place; editor: EditorView | null } | null {
	const editor = view.contentDOM.querySelector<HTMLElement>(`:scope > .${TABLE_CLASS} .table-cell-wrapper .cm-editor`);
	const place = editor && placeOf(view, editor);
	return editor && place ? { place, editor: EditorView.findFromDOM(editor) } : null;
}

/** The table a widget draws, while the widget is still in the note. */
function tableOf(view: EditorView, widget: HTMLElement): Span | null {
	return widget.parentElement === view.contentDOM ? viewLayout(view).tableAt(view.posAtDOM(widget)) : null;
}

/** The note's selected cell, or else its open one. */
function targetIn(view: EditorView): Target | null {
	const selected = view.plugin(cellSelection)?.selected;
	const table = selectedTable(view.state, viewLayout(view));
	if (table && selected) return { table, cell: selected, open: null };
	const open = openCell(view);
	const span = open && tableOf(view, open.place.widget);
	return open && span ? { table: span, cell: open.place.cell, open: open.editor } : null;
}

/** Whether a command does anything on a table: Unfreeze needs a mark. */
function offered(command: FreezeCommand, view: EditorView, table: Span): boolean {
	return command !== 'none' || hasMark(view.state.doc.lineAt(table.from).text);
}

/**
 * Writes a table's new freeze mark, in one step that Undo takes back alone. An open cell closes first, as Escape
 * closes it, and is selected: Obsidian would otherwise route the change to the cell's text through the cell's
 * own editor. The selected cell stays selected, and the whole table stays selected underneath it.
 */
function run(view: EditorView, command: FreezeCommand) {
	const found = targetIn(view);
	if (found?.open && !escapeCell(found.open)) return;
	const target = found?.open ? targetIn(view) : found;
	if (!target) return;
	const { table, cell } = target;
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

/**
 * A menu item, on the cell that was right-clicked. An open cell closes first, that one or another, and the
 * right-clicked cell is selected, as Escape leaves a cell, so the command runs from there and leaves it
 * selected, with the keyboard in the note. A table Obsidian has since taken away does nothing.
 */
function runAt(view: EditorView, { widget, cell }: Place, command: FreezeCommand) {
	const open = openCell(view);
	if (open && !(open.editor && escapeCell(open.editor))) return;
	const table = tableOf(view, widget);
	if (!table) return;
	const { main } = view.state.selection;
	if (main.from !== table.from || main.to !== table.to) view.dispatch({ selection: wholeTable(table, false), userEvent: 'select' });
	view.focus();
	view.plugin(cellSelection)?.select(cell);
	run(view, command);
}

/** The freeze items for a right-clicked cell, in a section of their own. */
function addItems(menu: Menu, view: EditorView, place: Place) {
	const table = tableOf(view, place.widget);
	if (!table) return;
	for (const { name, icon, command } of FREEZES) {
		if (!offered(command, view, table)) continue;
		menu.addItem((item) => item.setSection(MENU_SECTION).setTitle(name).setIcon(icon).onClick(() => runAt(view, place, command)));
	}
}

/**
 * The menu of an open cell, from `editor-menu`. Obsidian gives it the cell's own editor, with the note's view
 * as its info, so the info's editor is the note's. A right-click on the note's text gives the note's editor,
 * and gets nothing.
 */
export function cellMenu(menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) {
	if (!info.editor || editor === info.editor) return;
	const view = noteView(info.editor);
	const open = view && openCell(view);
	if (view && open) addItems(menu, view, open.place);
}

/**
 * Obsidian's own menu for a cell that isn't open. It comes from Menu.forEvent, which prevents the event's
 * default and gives the same menu to a later listener on that event: this one, on the note's content, hears it
 * after the cell does. A right-click inside an open cell is left to `editor-menu`, and a range dragged across
 * cells keeps Obsidian's menu for the range, where no one cell is "here".
 */
export const tableMenus = ViewPlugin.define((view) => {
	const onMenu = (event: MouseEvent) => {
		const target = event.target as Element;
		if (!event.defaultPrevented || target.closest('.cm-editor') !== view.dom) return;
		const place = placeOf(view, target);
		if (place && !place.widget.classList.contains(RANGE_CLASS)) addItems(Menu.forEvent(event), view, place);
	};
	view.contentDOM.addEventListener('contextmenu', onMenu);
	return { destroy: () => view.contentDOM.removeEventListener('contextmenu', onMenu) };
});

/** The freeze commands, offered with a cell of a table selected or open in Live Preview. */
export function freezeCommands(): Command[] {
	return FREEZES.map(({ id, name, icon, command }) => ({
		id,
		name,
		icon,
		editorCheckCallback(checking, editor) {
			const view = noteView(editor);
			const target = view && targetIn(view);
			if (!view || !target || !offered(command, view, target.table)) return false;
			if (!checking) run(view, command);
			return true;
		},
	}));
}
