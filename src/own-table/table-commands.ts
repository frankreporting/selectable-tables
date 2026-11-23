import { isolateHistory } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Command, IconName, Menu, MenuItem } from 'obsidian';
import { cellSelection } from '../editor/cells';
import { writesTable } from '../editor/decide';
import { escapeCell, noteView, wholeTable } from '../editor/extension';
import { type Place, selectAt, targetIn } from '../editor/freeze-commands';
import { type DrawnTable, openCells, type OwnCell, ownTables } from '../editor/layout';
import type { Cell, Span } from '../editor/table-text';
import { ADDS, editTable, lineChanges, shownText, type TableEdit } from './table-edits';

/**
 * Obsidian's table controls on the plugin's own table, in a preview build: the Row, Column and Sort items of its
 * right-click menu, its 15 table commands, and the row Tab and Enter add at a table's end, as Obsidian has them (read
 * from 1.15.1's `onContextMenu`, `makeRowMenu`, `makeColMenu`, `makeSortMenu` and its `editor:table-*` commands). Each
 * edit writes the table's text as Obsidian would (table-edits.ts), in one step that Undo takes back alone.
 */

interface Item {
	edit: TableEdit;
	name: string;
	icon: IconName;
	section: string;
	/** Whether it applies at a cell of a table this size: a move that would leave the table doesn't. */
	offered?: (cell: Cell, size: { rows: number; columns: number }) => boolean;
}

const ROW_ITEMS: Item[] = [
	{ edit: 'row-before', name: 'Add row above', icon: 'lucide-panel-top-close', section: 'table-add' },
	{ edit: 'row-after', name: 'Add row below', icon: 'lucide-panel-bottom-close', section: 'table-add' },
	{ edit: 'row-up', name: 'Move row up', icon: 'lucide-arrow-up', section: 'table-move', offered: ({ row }) => row > 0 },
	{ edit: 'row-down', name: 'Move row down', icon: 'lucide-arrow-down', section: 'table-move', offered: ({ row }, { rows }) => row < rows - 1 },
	{ edit: 'row-copy', name: 'Duplicate row', icon: 'lucide-copy', section: 'table-modify' },
	{ edit: 'row-delete', name: 'Delete row', icon: 'lucide-trash-2', section: 'table-modify' },
];

const ALIGN_ITEMS: Item[] = [
	{ edit: 'col-align-left', name: 'Align left', icon: 'lucide-align-left', section: 'table-align' },
	{ edit: 'col-align-center', name: 'Align center', icon: 'lucide-align-center', section: 'table-align' },
	{ edit: 'col-align-right', name: 'Align right', icon: 'lucide-align-right', section: 'table-align' },
];

const COLUMN_ITEMS: Item[] = [
	{ edit: 'col-before', name: 'Add column to the left', icon: 'lucide-panel-left-close', section: 'table-add' },
	{ edit: 'col-after', name: 'Add column to the right', icon: 'lucide-panel-right-close', section: 'table-add' },
	{ edit: 'col-left', name: 'Move column left', icon: 'lucide-arrow-left', section: 'table-move', offered: ({ column }) => column > 0 },
	{ edit: 'col-right', name: 'Move column right', icon: 'lucide-arrow-right', section: 'table-move', offered: ({ column }, { columns }) => column < columns - 1 },
	...ALIGN_ITEMS,
	{ edit: 'col-copy', name: 'Duplicate column', icon: 'lucide-copy', section: 'table-modify' },
	{ edit: 'col-delete', name: 'Delete column', icon: 'lucide-trash-2', section: 'table-modify' },
];

const SORT_ITEMS: Item[] = [
	{ edit: 'sort-az', name: 'Sort by column (A to Z)', icon: 'lucide-arrow-down-az', section: 'table-sort' },
	{ edit: 'sort-za', name: 'Sort by column (Z to A)', icon: 'lucide-arrow-up-za', section: 'table-sort' },
];

/** Obsidian's 15 table commands, in its order: the rows', the columns', then the alignments. Sort has none. */
const COMMANDS: Item[] = [...ROW_ITEMS, ...COLUMN_ITEMS.filter((item) => !ALIGN_ITEMS.includes(item)), ...ALIGN_ITEMS];

/** The plugin's own table a span is, in a note's editor. */
function ownTable(view: EditorView, table: Span): DrawnTable | null {
	return view.state.facet(ownTables)?.table(view, table.from) ?? null;
}

const sizeOf = (own: DrawnTable) => ({ rows: own.grid.rows, columns: own.grid.columns(0) });

/** How an edit ends: its cell open, as an open cell or a new row's, or selected; a row Tab adds opens at its first cell. */
interface EditEnd {
	open?: boolean;
	column?: number;
}

/**
 * Runs an edit at the note's selected or open cell of the plugin's table. An open cell closes first, as Escape closes
 * it, so the edit is the only change, and opens again in its new place afterwards. A new row's or column's cell opens,
 * ready to type in, as in Obsidian; after any other edit a selected cell stays selected, in its new place. The table
 * stays selected whole underneath, from the side it was selected from.
 */
export function runEdit(view: EditorView, edit: TableEdit, end: EditEnd = {}): boolean {
	const found = targetIn(view);
	if (!found) return false;
	const open = end.open ?? !!found.open;
	if (found.open && !escapeCell(found.open)) return false;
	const target = found.open ? targetIn(view) : found;
	const own = target && ownTable(view, target.table);
	if (!target || !own) return false;
	const { table, cell } = target;
	const { doc } = view.state;
	const lines: string[] = [];
	for (let n = doc.lineAt(table.from).number; n <= doc.lineAt(table.to).number; n++) lines.push(doc.line(n).text);
	const edited = editTable(lines, edit, cell, { rtl: own.rtl, shown: shownText });
	if (!edited) {
		// Nothing to do there: an open cell opens again.
		if (open) own.openCell(cell);
		return true;
	}
	const annotations = [writesTable.of('rows'), isolateHistory.of('full')];
	if (!edited.lines) {
		// The table's last row or column: the table goes, as in Obsidian, and the caret goes where it was.
		view.dispatch({ changes: { from: table.from, to: table.to, insert: '' }, selection: EditorSelection.cursor(table.from), annotations, scrollIntoView: false });
		view.focus();
		return true;
	}
	const { changes, to } = lineChanges(doc, table, edited.lines, edited.from);
	const { main } = view.state.selection;
	if (changes.length) view.dispatch({ changes, selection: wholeTable({ from: table.from, to }, main.anchor < main.head), annotations, scrollIntoView: false });
	const at = { row: edited.cell.row, column: end.column ?? edited.cell.column };
	const opens = open || ADDS.has(edit);
	const now = ownTable(view, { from: table.from, to });
	// The cell is selected, and opened, once its row is drawn from the new text: right after the edit, the row drawn
	// there can be one from before.
	const finish = () => {
		const cells = view.plugin(cellSelection);
		cells?.select(at);
		if (!opens) return;
		cells?.opening();
		now?.openCell(at);
	};
	// A table out of the page draws nothing: the cell is shown from its estimated place at once, as a key would show it.
	if (changes.length && now?.shown) now.afterDraw(at, finish);
	else finish();
	return true;
}

/**
 * A fresh press of Tab on a table's last cell, or of Enter on its last row, in an open cell: a row is added, below the
 * cell's, and its cell opens, the first one for Tab, as Obsidian has it. A held key's repeats never come here.
 */
export function addRowFrom(open: OwnCell, firstColumn: boolean): void {
	const { note } = open;
	runEdit(note, 'row-after', { open: true, ...(firstColumn ? { column: 0 } : {}) });
}

/** Whether a cell is the note's open cell. */
function isOpen(view: EditorView, { row, column }: Cell): boolean {
	const open = openCells.get(view);
	return !!open && open.note === view && open.cell.row === row && open.cell.column === column;
}

/**
 * A group of items under a title, as Obsidian's table menu has *Row* and *Column*: a submenu, which only Obsidian's
 * private `setSubmenu` makes. Without it, the items follow a heading in the menu itself.
 */
function group(menu: Menu, title: string, key: string): (item: Item, add: (item: MenuItem) => void) => void {
	const sub: { menu: Menu | null } = { menu: null };
	menu.addItem((item) => {
		const submenu = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
		if (typeof submenu === 'function') sub.menu = submenu.call(item);
		item.setSection(sub.menu ? 'table' : `table-${key}`).setIcon('lucide-table').setTitle(title);
		if (!sub.menu) item.setIsLabel(true);
	});
	return (each, add) => (sub.menu ?? menu).addItem((item) => add(item.setSection(sub.menu ? each.section : `table-${key}`)));
}

/** The Row and Column submenus and Sort, for a right-clicked cell of the plugin's table, before the freeze items. */
export function tableItems(menu: Menu, view: EditorView, place: Place): void {
	const table = place.table();
	const own = table && ownTable(view, table);
	if (!own) return;
	const size = sizeOf(own);
	const { cell } = place;
	const item = (each: Item) => (entry: MenuItem) =>
		entry
			.setTitle(each.name)
			.setIcon(each.icon)
			.onClick(() => {
				const open = isOpen(view, cell);
				if (selectAt(view, place)) runEdit(view, each.edit, { open });
			});
	const offered = (each: Item) => !each.offered || each.offered(cell, size);
	const rows = group(menu, 'Row', 'row');
	for (const each of ROW_ITEMS) if (offered(each)) rows(each, item(each));
	const columns = group(menu, 'Column', 'column');
	for (const each of COLUMN_ITEMS) if (offered(each)) columns(each, item(each));
	for (const each of SORT_ITEMS) menu.addItem((entry) => item(each)(entry.setSection(each.section)));
}

/** The table commands, offered with a cell of the plugin's table selected or open, under Obsidian's names. */
export function tableCommands(): Command[] {
	return COMMANDS.map((each) => ({
		id: `table-${each.edit}`,
		name: each.name,
		icon: each.icon,
		editorCheckCallback(checking, editor) {
			const view = noteView(editor);
			const target = view && targetIn(view);
			const own = view && target && ownTable(view, target.table);
			if (!view || !target || !own || (each.offered && !each.offered(target.cell, sizeOf(own)))) return false;
			if (!checking) runEdit(view, each.edit);
			return true;
		},
	}));
}
