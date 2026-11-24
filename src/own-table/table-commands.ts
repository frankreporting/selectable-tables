import { isolateHistory } from '@codemirror/commands';
import { ChangeSet, EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { type Command, editorInfoField, htmlToMarkdown, type IconName, Menu, type MenuItem } from 'obsidian';
import { cellSelection } from '../editor/cells';
import { boundsOf, writesTable } from '../editor/decide';
import { escapeCell, noteView, wholeTable } from '../editor/extension';
import { type Place, selectAt, targetIn } from '../editor/freeze-commands';
import { hasMark, markText, readFreeze, withoutMark } from '../editor/freeze-mark';
import { type DrawnTable, openCells, type OwnCell, ownTables } from '../editor/layout';
import { type Cell, type Span, toCellSource } from '../editor/table-text';
import { cellPlace, difference, paddingFor, writeCell } from './cell-write';
import { ADDS, editCells, type Edited, editTable, type LineChange, lineChanges, readTableData, shownText, type TableEdit } from './table-edits';

/**
 * Obsidian's table controls on the plugin's own table, in a preview build: the Row, Column and Sort items of its
 * right-click menu, its 15 table commands, the row Tab and Enter add at a table's end, and Backspace, Delete, Cut and
 * Paste on a selected cell or a range of cells, as Obsidian has them (read from 1.15.1's `onContextMenu`, `makeRowMenu`,
 * `makeColMenu`, `makeSortMenu`, its `editor:table-*` commands, `deleteSelection` and `pasteSelection`). Each edit
 * writes the table's text as Obsidian would (table-edits.ts), in one step that Undo takes back alone.
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
	/** Where a drag puts its row or column. */
	to?: number;
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
	return !!target && editAt(view, target.table, target.cell, edit, { ...end, open });
}

/**
 * Runs an edit at a cell of one of the note's own tables, with no cell selected first: the drag handles' moves and the +
 * buttons' adds, which Obsidian runs from its table, not from a cell. An open cell closes first, as Escape closes it.
 * `table` is the plugin's table itself, which keeps where it is in the note.
 */
export function runEditAt(view: EditorView, table: Span, cell: Cell, edit: TableEdit, end: EditEnd = {}): boolean {
	const open = openCells.get(view);
	if (open && open.note === view && !escapeCell(open.view)) return false;
	return editAt(view, table, cell, edit, end);
}

function editAt(view: EditorView, table: Span, cell: Cell, edit: TableEdit, end: EditEnd): boolean {
	const own = ownTable(view, table);
	if (!own) return false;
	const open = !!end.open;
	const edited = editTable(linesOf(view, table), edit, cell, { rtl: own.rtl, shown: shownText, ...(end.to === undefined ? {} : { to: end.to }) });
	if (!edited) {
		// Nothing to do there: an open cell opens again.
		if (open) own.openCell(cell);
		return true;
	}
	return commit(view, table, own, edited, { opens: open || ADDS.has(edit), kind: 'rows', ...(end.column === undefined ? {} : { column: end.column }) });
}

/** A table's lines in the note. */
export function linesOf(view: EditorView, table: Span): string[] {
	const { doc } = view.state;
	const lines: string[] = [];
	for (let n = doc.lineAt(table.from).number; n <= doc.lineAt(table.to).number; n++) lines.push(doc.line(n).text);
	return lines;
}

/** How an edit's write ends: whether its cell opens, a column it goes to instead, and which kind of write it is. */
interface Commit {
	opens: boolean;
	column?: number;
	kind: 'rows' | 'cells';
	/** Where a range of cells that stays selected starts, its cell moved to last being the edit's cell. */
	anchor?: Cell | null;
}

/** Writes an edit's lines to the note, only where they differ, or takes the table away when it leaves none. */
function commit(view: EditorView, table: Span, own: DrawnTable, edited: Edited, end: Commit): boolean {
	if (!edited.lines) {
		// The table's last row or column: the table goes, as in Obsidian, and the caret goes where it was.
		view.dispatch({ changes: { from: table.from, to: table.to, insert: '' }, selection: EditorSelection.cursor(table.from), annotations: [writesTable.of(end.kind), isolateHistory.of('full')], scrollIntoView: false });
		view.focus();
		return true;
	}
	const { changes, to } = lineChanges(view.state.doc, table, edited.lines, edited.from);
	return write(view, table, own, changes, to, { row: edited.cell.row, column: end.column ?? edited.cell.column }, end);
}

/**
 * Writes changes to a table, in one step that Undo takes back alone, with the table still selected whole from the side it
 * was selected from, and the keys in the note. The cell `at` is selected, and opened, once its row is drawn from the new
 * text: right after the edit, the row drawn there can be one from before.
 */
function write(view: EditorView, table: Span, own: DrawnTable, changes: readonly LineChange[], to: number, at: Cell, end: Commit): boolean {
	const { main } = view.state.selection;
	const inTable = main.from >= table.from && main.to <= table.to;
	const annotations = [writesTable.of(end.kind), isolateHistory.of('full')];
	if (changes.length) view.dispatch({ changes, selection: wholeTable({ from: table.from, to }, inTable && main.anchor < main.head), annotations, scrollIntoView: false });
	// The keys go to the note, as they do after a menu's edit: a + button or a handle leaves them where they were.
	if (!view.hasFocus) view.focus();
	const now = changes.length ? ownTable(view, { from: table.from, to }) : own;
	const finish = () => {
		const cells = view.plugin(cellSelection);
		if (end.anchor) cells?.selectRange(end.anchor, at, undefined, false);
		else cells?.select(at);
		if (!end.opens) return;
		cells?.opening();
		now?.openCell(at);
	};
	// A table out of the page draws nothing: the cell is shown from its estimated place at once, as a key would show it.
	if (changes.length && now?.shown) now.afterDraw(at, finish);
	else finish();
	return true;
}

// A selected cell or a range of cells: Backspace, Delete, Cut and Paste --------------------------------------------------

/** The note's selected cell of the plugin's table, with the range it ends, if any, and the table. */
export function selectedCells(view: EditorView): { table: Span; own: DrawnTable; cell: Cell; anchor: Cell | null } | null {
	const cells = view.plugin(cellSelection);
	const found = targetIn(view);
	const own = found && !found.open ? ownTable(view, found.table) : null;
	if (!cells?.selected || !found || !own) return null;
	return { table: found.table, own, cell: cells.selected, anchor: cells.anchor };
}

/**
 * Writes one cell's text, as an open cell writes it: only that cell, padded as the table is, a table spaced by hand
 * keeping its spacing. A pipe or a line break stays in the cell, and a header cell's freeze mark stays before the text.
 * The cell stays selected.
 */
function writeOne(view: EditorView, table: Span, own: DrawnTable, cell: Cell, text: string): void {
	const { doc } = view.state;
	const place = cellPlace(doc, table, cell);
	if (!place) return;
	// A freeze mark belongs to its table: one in the text is left out, and the header cell's own stays before it.
	let source = toCellSource(cell.row === 0 ? withoutMark(text) : text).text;
	if (cell.row === 0 && hasMark(place.source)) {
		const mark = markText(readFreeze(place.source));
		source = source ? `${mark} ${source}` : mark;
	}
	const written = writeCell(doc, table, cell, source, paddingFor(doc, table, cell));
	if (!written) return;
	const to = ChangeSet.of(written.changes, doc.length).mapPos(table.to, 1);
	write(view, table, own, written.changes, to, cell, { opens: false, kind: 'cells' });
}

/**
 * Gives a table new lines, as many as before, changing only the characters that differ on each line, so the note stays
 * still and a caret elsewhere stays where it was: formatting on a selected cell or a range of cells. The cell, and the
 * range it ends, stay selected.
 */
export function writeLines(view: EditorView, table: Span, own: DrawnTable, lines: readonly string[], cell: Cell, anchor: Cell | null): void {
	const { doc } = view.state;
	const first = doc.lineAt(table.from).number;
	const changes: LineChange[] = [];
	let shift = 0;
	lines.forEach((text, index) => {
		const line = doc.line(first + index);
		const change = difference(line.text, text, line.from);
		if (!change) return;
		changes.push(change);
		shift += change.insert.length - (change.to - change.from);
	});
	write(view, table, own, changes, table.to + shift, cell, { opens: false, kind: 'cells', anchor });
}

/**
 * Backspace and Delete on a selected cell of the plugin's table, and Cut after its copy: one cell is emptied and stays
 * selected; a range of cells is emptied, or its rows or columns, or the whole table, deleted, as Obsidian's range does,
 * and a cell is selected where Obsidian puts it (`editCells`).
 */
export function clearCells(view: EditorView, forward: boolean): void {
	const found = selectedCells(view);
	if (!found) return;
	const { table, own, cell, anchor } = found;
	if (!anchor) {
		writeOne(view, table, own, cell, '');
		return;
	}
	const edited = editCells(linesOf(view, table), { kind: 'delete', bounds: boundsOf(anchor, cell), head: cell, forward });
	if (edited) commit(view, table, own, edited, { opens: false, kind: 'cells' });
}

/**
 * Paste on a selected cell of the plugin's table: cells copied from a table, Obsidian's or the plugin's, are written over
 * the cells from the selected one, or the range's first, on, the table growing to fit, and the last one pasted is
 * selected. Otherwise text goes into one selected cell, as a paste into its open cell would put it; on a range, nothing.
 */
export function pasteCells(view: EditorView, data: DataTransfer): void {
	const found = selectedCells(view);
	if (!found) return;
	const { table, own, cell, anchor } = found;
	const cells = readTableData(data.getData(TABLE_DATA));
	if (cells) {
		const at = anchor ? { row: Math.min(anchor.row, cell.row), column: Math.min(anchor.column, cell.column) } : cell;
		const edited = editCells(linesOf(view, table), { kind: 'paste', at, ...cells });
		if (edited) commit(view, table, own, edited, { opens: false, kind: 'cells' });
		return;
	}
	if (anchor) return;
	const text = pastedText(view, data);
	if (text !== null) writeOne(view, table, own, cell, text);
}

/**
 * Paste of cells copied from a table into an open cell of the plugin's table, as into Obsidian's: the cell closes, the
 * cells are written over it and on, and the last one pasted opens. Anything else on the clipboard is the cell editor's
 * own paste: says whether it was cells.
 */
export function pasteIntoCell(open: OwnCell, json: string): boolean {
	const cells = readTableData(json);
	if (!cells) return false;
	const { note } = open;
	if (!escapeCell(open.view)) return true;
	const target = targetIn(note);
	const own = target && ownTable(note, target.table);
	if (!target || !own) return true;
	const edited = editCells(linesOf(note, target.table), { kind: 'paste', at: target.cell, ...cells });
	if (edited) commit(note, target.table, own, edited, { opens: true, kind: 'cells' });
	return true;
}

/** Obsidian's own type for its table data on the clipboard. */
const TABLE_DATA = 'obsidian/table';
/** At the start of the HTML Obsidian copies, so its own paste takes the plain text. */
const OBSIDIAN_HTML = '<!-- obsidian -->';

/**
 * The text a paste puts in a cell, as Obsidian's editor makes it from what's on the clipboard (read from 1.15.1's
 * `handleDataTransfer`, which its cells' editors use too): plain text when the HTML is Obsidian's own, else the
 * Markdown, else the HTML as Markdown while the vault converts pasted HTML, else a link from a link's address, else the
 * plain text. Null with no text at all, such as a picture alone, which does nothing, as before.
 */
function pastedText(view: EditorView, data: DataTransfer): string | null {
	const html = data.getData('text/html');
	const plain = data.getData('text/plain');
	if (html && html.includes(OBSIDIAN_HTML) && plain) return plain.trim();
	const markdown = data.getData('text/markdown');
	if (markdown) return markdown.trim();
	if (html) return (convertsHtml(view) ? htmlText(html) : plain).trim() || null;
	const address = data.getData('text/uri-list');
	if (address && plain && address.toLowerCase() !== plain.toLowerCase() && decoded(address.toLowerCase()) !== plain.toLowerCase()) return `[${plain}](${address})`;
	return (plain || address).trim() || null;
}

/** An address with its escapes read, or as it is when they don't read. */
function decoded(address: string): string {
	try {
		return decodeURIComponent(address);
	} catch {
		return address;
	}
}

/**
 * Whether the vault converts pasted HTML to Markdown, Editor › Auto convert HTML, on unless turned off. Read through
 * the vault's private `getConfig`, as Obsidian's paste reads it, only where it's there.
 */
function convertsHtml(view: EditorView): boolean {
	const vault = view.state.field(editorInfoField, false)?.app.vault as { getConfig?: (key: string) => unknown } | undefined;
	return typeof vault?.getConfig === 'function' ? !!vault.getConfig('autoConvertHtml') : true;
}

/** HTML as Markdown, through Obsidian's public converter, leaving out large pictures held in the HTML itself, as Obsidian's paste does. */
function htmlText(html: string): string {
	const page = new DOMParser().parseFromString(html, 'text/html');
	for (const media of Array.from(page.body.querySelectorAll('img, audio, video'))) {
		const src = media.getAttribute('src') ?? '';
		if (src.startsWith('data:') && src.length > 1000) media.remove();
	}
	return htmlToMarkdown(page.body);
}

/** The + buttons: a row at the table's end, or a column, as Obsidian's buttons add them, its first cell open. */
export function addAtEnd(view: EditorView, table: Span, what: 'row' | 'column'): void {
	runEditAt(view, table, { row: 0, column: 0 }, what === 'row' ? 'row-end' : 'col-end', { open: true });
}

/**
 * A drag handle let go: its row moves to the row it was let go on, or its column to the column, and the moved row's
 * first cell, or the column's header cell, is selected, where Obsidian selects the row or column as a range of cells.
 */
export function moveTo(view: EditorView, table: Span, what: 'row' | 'column', from: number, to: number): void {
	const cell = what === 'row' ? { row: from, column: 0 } : { row: 0, column: from };
	runEditAt(view, table, cell, what === 'row' ? 'row-move' : 'col-move', { to });
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

/**
 * The Row and Column submenus and Sort, for a right-clicked cell of the plugin's table, before the freeze items. A drag
 * handle's menu is its row's items, or Sort and its column's items, in the menu itself, as Obsidian's handles have them
 * (`makeRowMenu`, then `makeSortMenu` and `makeColMenu`), with no freeze items.
 */
export function tableItems(menu: Menu, view: EditorView, place: Place, grip?: 'row' | 'column'): void {
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
	const flat = (items: Item[]) => {
		for (const each of items) if (offered(each)) menu.addItem((entry) => item(each)(entry.setSection(each.section)));
	};
	if (grip === 'row') return flat(ROW_ITEMS);
	if (grip === 'column') return flat([...SORT_ITEMS, ...COLUMN_ITEMS]);
	const rows = group(menu, 'Row', 'row');
	for (const each of ROW_ITEMS) if (offered(each)) rows(each, item(each));
	const columns = group(menu, 'Column', 'column');
	for (const each of COLUMN_ITEMS) if (offered(each)) columns(each, item(each));
	flat(SORT_ITEMS);
}

/** A drag handle's menu, at a click on it without a drag: the same items as a right-click on it. */
export function gripMenu(view: EditorView, place: Place, grip: 'row' | 'column', at: MouseEvent): void {
	if (!selectAt(view, place)) return;
	const menu = new Menu();
	tableItems(menu, view, place, grip);
	menu.showAtMouseEvent(at);
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
