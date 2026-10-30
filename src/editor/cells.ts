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
	/** The side the table was selected from, kept while a cell is open so Escape can come back to it. */
	private side: { table: number; fromAbove: boolean } | null = null;
	private table: HTMLTableElement | null = null;
	private cell: HTMLTableCellElement | null = null;

	constructor(private readonly view: EditorView) {
		view.contentDOM.addEventListener('pointerdown', this.onPress, true);
	}

	get grid(): Grid {
		const table = this.tableElement();
		return { rows: table?.rows.length ?? 0, columns: (row) => table?.rows[row]?.cells.length ?? 0 };
	}

	select(cell: Cell) {
		this.selected = cell;
		this.left = null;
		statesWithCell.add(this.view.state);
		this.mark(this.tableElement());
		this.view.requestMeasure(this.reveal);
	}

	/** Escape on the selected cell: back to the selected table, remembering the cell for Enter. */
	climb() {
		this.left = this.selected;
		this.deselect();
	}

	/** Enter on the selected cell. Opening it takes the note's selection off the table. */
	opening() {
		const { main } = this.view.state.selection;
		this.side = { table: main.from, fromAbove: main.anchor < main.head };
	}

	/** Whether the table whose cell is closing was selected from above. */
	fromAbove(table: Span): boolean {
		return this.side?.table === table.from && this.side.fromAbove;
	}

	update(update: ViewUpdate) {
		if (!this.selected && !this.left && !this.side) return;
		const layout = viewLayout(this.view);
		if (this.side) {
			const table = update.changes.mapPos(this.side.table);
			this.side = layout.tableAt(update.state.selection.main.head)?.from === table ? { ...this.side, table } : null;
		}
		if (!selectedTable(update.state, layout)) {
			this.left = null;
			this.deselect();
		} else if (this.selected) {
			statesWithCell.add(update.state);
			if (update.docChanged || update.viewportChanged) this.view.requestMeasure(this.redraw);
		}
	}

	destroy() {
		this.view.contentDOM.removeEventListener('pointerdown', this.onPress, true);
		this.deselect();
	}

	/**
	 * A press in the note takes the cell off before anything else sees it. Obsidian's table menus and
	 * buttons edit the table with no user event, and the edit guard must not stop those: Obsidian has
	 * already changed the drawn table by then. It runs on the capture phase, as widgets keep their events.
	 */
	private readonly onPress = () => {
		this.left = null;
		if (this.selected) this.deselect();
	};

	private deselect() {
		this.selected = null;
		statesWithCell.delete(this.view.state);
		this.mark(null);
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
