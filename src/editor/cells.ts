import type { EditorState } from '@codemirror/state';
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Cells, Grid, selectedTable } from './decide';
import { viewLayout } from './layout';
import type { Cell, Span } from './table-text';

/** On Obsidian's table widget, which holds the table element. */
export const TABLE_CLASS = 'cm-table-widget';
/** On the selected cell; styles.css draws it the way Obsidian draws selected cells. */
const CELL_CLASS = 'selectable-tables-cell';
/** On a table while one of its cells is selected; styles.css takes the table's own tint off then. */
const HOLDS_CELL_CLASS = 'selectable-tables-holds-cell';

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

	/** The same for anything inside the content taking the focus, such as a cell's editor. */
	private readonly onFocus = (event: FocusEvent) => {
		if (event.target !== this.view.contentDOM) this.onLeave();
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

	/** Shows the selected cell, sideways in a wide table and down the note in a tall one. */
	private readonly reveal = {
		key: 'reveal',
		read: () => undefined,
		write: () => this.cell?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
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
			this.cell?.classList.remove(CELL_CLASS);
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
