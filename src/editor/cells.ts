import type { EditorState } from '@codemirror/state';
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Cells, Grid, selectedTable } from './decide';
import { viewLayout } from './layout';
import type { Cell, Span } from './table-text';

/** On Obsidian's table widget, which holds the table element. */
export const TABLE_CLASS = 'cm-table-widget';
/** On the selected cell; styles.css draws it the way Obsidian draws selected cells. */
export const CELL_CLASS = 'selectable-tables-cell';
/** On the selected cell when Enter can't open it; styles.css turns its border red. */
const REFUSED_CLASS = 'selectable-tables-refused';
/** On a table while one of its cells is selected; styles.css takes the table's own tint off then. */
const HOLDS_CELL_CLASS = 'selectable-tables-holds-cell';

/** What a frozen table has pinned: how many rows and columns, and the room they take. */
export interface Pinned {
	rows: number;
	columns: number;
	/** Down from where they pin. None while the rows aren't pinned. */
	height: number;
	/** In from the widget's start, its padding included. None while the columns aren't pinned. */
	width: number;
}

/** A frozen table's pinned rows and columns, by its widget, kept measured by freeze.ts. */
export const pinnedTables = new WeakMap<HTMLElement, Pinned>();

/** The room a cell has to stay clear of. A row or column can't cover its own cells: they move with it. */
export function clearance({ row, column }: Cell, { rows, columns, height, width }: Pinned): { block: number; inline: number } {
	return { block: row < rows ? 0 : height, inline: column < columns ? 0 : width };
}

/**
 * Shows a cell, sideways in a wide table and down the note in a tall one. Pinned rows and columns cover
 * what passes under them, and neither the browser's scroll nor Obsidian's knows it, so for this one scroll
 * the cell's margins reach past them. Nothing else reads a scroll margin, and these are on the one cell:
 * a size kept on the table would restyle every cell when it changed.
 */
function show(cell: HTMLTableCellElement) {
	const widget = cell.closest<HTMLElement>(`.${TABLE_CLASS}`);
	const pinned = widget && pinnedTables.get(widget);
	const row = (cell.parentElement as HTMLTableRowElement).rowIndex;
	const { block, inline } = pinned ? clearance({ row, column: cell.cellIndex }, pinned) : { block: 0, inline: 0 };
	const { style } = cell;
	if (block) style.scrollMarginBlockStart = `calc(${block}px + var(--size-4-2) + var(--selectable-tables-pin-top))`;
	if (inline) style.scrollMarginInlineStart = `calc(${inline}px + var(--size-4-2))`;
	cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	style.scrollMarginBlockStart = '';
	style.scrollMarginInlineStart = '';
}

/** The cell an element sits in, if its table has rows or columns pinned. */
function frozenCell(element: Element): HTMLTableCellElement | null {
	const cell = element.closest<HTMLTableCellElement>('td, th');
	const widget = cell?.closest<HTMLElement>(`.${TABLE_CLASS}`);
	return widget && pinnedTables.has(widget) ? cell : null;
}

/**
 * Shows a frozen table's cell on the next frame, after a scroll that can't see what's pinned has run. That
 * still comes before anything is painted, so the cell doesn't appear under the rows first.
 */
function showAfterScroll(view: EditorView, cell: HTMLTableCellElement) {
	view.requestMeasure({
		key: 'showCell',
		read: () => undefined,
		write: () => {
			if (cell.isConnected) show(cell);
		},
	});
}

/**
 * A cell's editor scrolls its caret into view as you type, and it takes a caret under a pinned row for one
 * that's on screen. At a frozen column's cell it stops at the cell, which is sticky, and the note doesn't
 * scroll at all. So the cell is shown after that scroll, and only when there is one: an edit that reaches an
 * open cell from Sync doesn't move the note.
 */
export const cellFollowsCaret = EditorView.updateListener.of((update) => {
	if (!update.transactions.some((transaction) => transaction.scrollIntoView)) return;
	const cell = frozenCell(update.view.dom);
	if (cell) showAfterScroll(update.view, cell);
});

/** The editor states with a cell selected, for the edit guard, which sees states but not editors. */
const statesWithCell = new WeakSet<EditorState>();

export function cellSelected(state: EditorState): boolean {
	return statesWithCell.has(state);
}

/**
 * The selected cell of an editor's selected table. The note's selection stays on the whole table, so
 * Obsidian opens no cell, and the selected cell is only a class on it. A move dispatches no transaction:
 * in Live Preview each one walks the whole note and runs every plugin's listeners, while swapping a class
 * inside a widget costs the same on any note, and CodeMirror doesn't take it for an edit.
 */
class CellSelection implements PluginValue, Cells {
	selected: Cell | null = null;
	left: Cell | null = null;
	/** Where the table all this belongs to starts. */
	private start: number | null = null;
	/** Whether the table was selected from above, kept while a cell is open so Escape can come back to it. */
	private side: boolean | null = null;
	private table: HTMLTableElement | null = null;
	private cell: HTMLTableCellElement | null = null;

	constructor(private readonly view: EditorView) {
		view.contentDOM.addEventListener('pointerdown', this.onLeave, true);
		view.contentDOM.addEventListener('dragenter', this.onLeave, true);
		view.contentDOM.addEventListener('focusin', this.onFocus, true);
	}

	get grid(): Grid {
		const table = this.tableElement();
		return { rows: table?.rows.length ?? 0, columns: (row) => table?.rows[row]?.cells.length ?? 0 };
	}

	select(cell: Cell) {
		const { view } = this;
		this.start ??= selectedTable(view.state, viewLayout(view))?.from ?? null;
		this.selected = cell;
		this.left = null;
		statesWithCell.add(view.state);
		this.mark(this.tableElement());
		view.requestMeasure(this.reveal);
	}

	/** Escape on the selected cell: back to the selected table, remembering the cell for Enter. */
	climb() {
		this.left = this.selected;
		this.deselect();
	}

	/**
	 * Enter on the selected cell. Opening it takes the note's selection off the table, and Obsidian
	 * focuses the cell's editor before this plugin hears of that, so the cell comes off first.
	 */
	opening() {
		const { main } = this.view.state.selection;
		this.side = main.anchor < main.head;
		this.deselect();
	}

	/** Enter can't open the selected cell. It says so until the selection moves on. */
	refuse() {
		this.cell?.classList.add(REFUSED_CLASS);
	}

	/** Whether the table whose cell is closing was selected from above. */
	fromAbove(table: Span): boolean {
		return this.start === table.from && this.side === true;
	}

	update(update: ViewUpdate) {
		if (this.start === null) return;
		const layout = viewLayout(this.view);
		const start = update.changes.mapPos(this.start, 1);
		const { head } = update.state.selection.main;
		if (selectedTable(update.state, layout)?.from === start) {
			this.start = start;
			if (this.selected) {
				statesWithCell.add(update.state);
				this.view.requestMeasure(this.redraw);
			}
		} else if (this.side !== null && layout.tableAt(head)?.from === start) {
			// A cell is open: the note's caret is in the table's text.
			this.start = start;
			this.left = null;
			this.deselect();
		} else {
			this.forget();
		}
	}

	destroy() {
		const { contentDOM } = this.view;
		contentDOM.removeEventListener('pointerdown', this.onLeave, true);
		contentDOM.removeEventListener('dragenter', this.onLeave, true);
		contentDOM.removeEventListener('focusin', this.onFocus, true);
		this.forget();
	}

	/**
	 * A press or a drag in the note takes the cell off before anything else sees it. Obsidian's table
	 * menus, buttons and drop targets edit the table with no user event, and the edit guard must not stop
	 * those: Obsidian has already changed the drawn table by then. This runs in the capture phase, since
	 * widgets keep their events from the editor.
	 */
	private readonly onLeave = () => {
		if (this.selected) this.forget();
	};

	/**
	 * The same for anything inside the content taking the focus, such as a cell's editor. Obsidian scrolls to
	 * a cell as it opens, right after this, and it takes a cell under a pinned row for one that's on screen.
	 */
	private readonly onFocus = (event: FocusEvent) => {
		const target = event.target as HTMLElement;
		if (target === this.view.contentDOM) return;
		this.onLeave();
		const cell = frozenCell(target);
		if (cell) showAfterScroll(this.view, cell);
	};

	private deselect() {
		this.selected = null;
		statesWithCell.delete(this.view.state);
		this.mark(null);
	}

	private forget() {
		this.start = null;
		this.side = null;
		this.left = null;
		this.deselect();
	}

	/** After the editor draws an update: Obsidian may have built the table anew, without the marks. */
	private readonly redraw = {
		key: 'redraw',
		read: () => this.tableElement(),
		write: (table: HTMLTableElement | null) => {
			if (this.selected) this.mark(table);
		},
	};

	private readonly reveal = {
		key: 'reveal',
		read: () => undefined,
		write: () => {
			if (this.cell) show(this.cell);
		},
	};

	/** The selected table's element, found in the content's own block widgets when it's new. */
	private tableElement(): HTMLTableElement | null {
		if (this.table?.isConnected) return this.table;
		const { view } = this;
		const layout = viewLayout(view);
		const table = selectedTable(view.state, layout);
		if (!table) return null;
		for (const widget of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(`:scope > .${TABLE_CLASS}`))) {
			if (layout.tableAt(view.posAtDOM(widget))?.from === table.from) return widget.querySelector('table');
		}
		return null;
	}

	/** Moves the classes onto the selected cell, or off everything. A cell that's gone leaves its table selected. */
	private mark(table: HTMLTableElement | null) {
		const { selected } = this;
		const cell = selected ? (table?.rows[selected.row]?.cells[selected.column] ?? null) : null;
		if (selected && table && !cell) {
			this.left = null;
			this.deselect();
			return;
		}
		if (cell !== this.cell) {
			this.cell?.classList.remove(CELL_CLASS, REFUSED_CLASS);
			cell?.classList.add(CELL_CLASS);
			this.cell = cell;
		}
		if (table !== this.table) {
			this.table?.classList.remove(HOLDS_CELL_CLASS);
			table?.classList.add(HOLDS_CELL_CLASS);
			this.table = table;
		}
	}
}

export const cellSelection = ViewPlugin.fromClass(CellSelection);
