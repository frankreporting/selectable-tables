import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { CELL_CLASS, TABLE_CLASS } from './cells';
import { Freeze, readFreeze } from './freeze-mark';

/** On a table's widget while anything in it is frozen. styles.css gives its cells their own borders then. */
const FROZEN_CLASS = 'selectable-tables-frozen';
/** On the widget while its frozen rows are pinned. */
const ROWS_CLASS = 'selectable-tables-frozen-rows';
/** On each frozen row. They're few, so script can mark them one at a time. */
const ROW_CLASS = 'selectable-tables-frozen-row';
/**
 * On the widget while its frozen columns are pinned, with a second class for how many: styles.css picks
 * their cells by position, since a class on every cell of a long table would cost too much.
 */
const COLUMNS_CLASS = 'selectable-tables-frozen-columns';

/** Before the table, on a table with frozen columns. styles.css keeps the selected table's tint out of the strip beside them with it. */
const COVER_CLASS = 'selectable-tables-tint-cover';

const columnsClass = (count: number) => `${COLUMNS_CLASS}-${count}`;
const columnVariable = (column: number) => `--selectable-tables-column-${column}`;
/** How far the frozen rows travel, and how much of their animation that takes. They're on the rows: a variable on the table would restyle every cell. */
const TRAVEL_VARIABLE = '--selectable-tables-travel';
const PIN_END_VARIABLE = '--selectable-tables-pin-end';
/** On the cover, for the same reason. */
const TABLE_HEIGHT_VARIABLE = '--selectable-tables-table-height';
/** How far past the pane's top the rows' animation goes on, as in styles.css. */
export const ANIMATION_REACH = 4000;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function setVariable(element: HTMLElement, name: string, value: string) {
	if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

const isWidget = (node: Node): node is HTMLElement => node.nodeType === Node.ELEMENT_NODE && (node as Element).classList.contains(TABLE_CLASS);

/**
 * A table the editor has drawn, and what's marked on it. Obsidian keeps the widget when it rebuilds the
 * table inside it, and hands the same widget back when the table scrolls out of the editor's drawn range
 * and returns, so what's marked here is still there when it does.
 */
class DrawnTable {
	/** Where the table's text starts, kept up to date as the note changes. */
	from = 0;
	private freeze: Freeze = { rows: 0, columns: 0 };
	private table: HTMLTableElement | null = null;
	private rows: HTMLTableRowElement[] = [];
	/** The header cells of the frozen columns. */
	private headers: HTMLTableCellElement[] = [];
	private cover: HTMLElement | null = null;

	constructor(readonly widget: HTMLElement) {}

	/** What to watch for a change of size. */
	get watched(): HTMLElement[] {
		return this.table ? [this.widget, this.table, ...this.rows, ...this.headers] : [];
	}

	/**
	 * Marks the frozen rows and columns of what's drawn now, pinned from the start: taking that up after
	 * the first layout would lay a long table out twice. `measure` unpins whatever turns out not to fit.
	 */
	mark(freeze: Freeze) {
		const table = this.widget.querySelector('table');
		if (table === this.table && freeze.rows === this.freeze.rows && freeze.columns === this.freeze.columns) return;
		this.clear();
		this.freeze = freeze;
		if (!table || (!freeze.rows && !freeze.columns)) return;
		const rows = Array.from(table.rows).slice(0, freeze.rows);
		const headers = Array.from(table.rows[0]?.cells ?? []).slice(0, freeze.columns);
		this.table = table;
		this.rows = rows;
		this.headers = headers;
		this.widget.classList.add(FROZEN_CLASS);
		if (rows.length) this.widget.classList.add(ROWS_CLASS);
		if (headers.length) {
			this.widget.classList.add(COLUMNS_CLASS, columnsClass(headers.length));
			this.cover = table.parentElement?.createDiv({ cls: COVER_CLASS, prepend: true }) ?? null;
		}
		for (const row of rows) row.classList.add(ROW_CLASS);
	}

	/**
	 * Sets the sizes the CSS needs, and pins only what leaves room: rows taller than half the pane, or
	 * columns as wide as the table's box, would fill it, with nothing able to scroll past them.
	 */
	measure(paneHeight: number) {
		const { widget, table, rows, headers } = this;
		if (!table?.isConnected) return;
		const padding = parseFloat(getComputedStyle(widget).paddingInlineStart) || 0;
		const height = sum(rows.map((row) => row.offsetHeight));
		const travel = table.offsetHeight - height;
		const pinRows = travel > 0 && height > 0 && height * 2 <= paneHeight;
		if (pinRows) {
			const animation = widget.offsetHeight - padding + ANIMATION_REACH;
			for (const row of rows) {
				setVariable(row, TRAVEL_VARIABLE, `${travel}px`);
				setVariable(row, PIN_END_VARIABLE, `${((travel / animation) * 100).toFixed(4)}%`);
			}
		}
		widget.classList.toggle(ROWS_CLASS, pinRows);

		if (this.cover) setVariable(this.cover, TABLE_HEIGHT_VARIABLE, `${table.offsetHeight}px`);

		// Real widths, not rounded ones: rounded up, an offset leaves a gap between frozen columns that passing
		// text shows through. The scale is for a table drawn smaller or larger, as on a canvas.
		const scale = widget.getBoundingClientRect().width / widget.offsetWidth || 1;
		const widths = headers.map((cell) => cell.getBoundingClientRect().width / scale);
		const pinColumns = headers.length > 0 && sum(widths) < widget.clientWidth - 2 * padding;
		// The first column sits at 0, and each later one past the columns before it. This has to be above
		// all of a column's cells, but it changes only when a frozen column changes width.
		widths.forEach((_, index) => {
			if (index > 0) setVariable(widget, columnVariable(index + 1), `${sum(widths.slice(0, index))}px`);
		});
		widget.classList.toggle(COLUMNS_CLASS, pinColumns);
		if (headers.length) widget.classList.toggle(columnsClass(headers.length), pinColumns);
	}

	/** Takes everything off. */
	clear() {
		const { widget, rows, headers } = this;
		for (const row of rows) {
			row.classList.remove(ROW_CLASS);
			row.style.removeProperty(TRAVEL_VARIABLE);
			row.style.removeProperty(PIN_END_VARIABLE);
		}
		headers.forEach((_, index) => widget.style.removeProperty(columnVariable(index + 1)));
		this.cover?.remove();
		this.cover = null;
		widget.classList.remove(FROZEN_CLASS, ROWS_CLASS, COLUMNS_CLASS, columnsClass(headers.length));
		this.table = null;
		this.rows = [];
		this.headers = [];
		this.freeze = { rows: 0, columns: 0 };
	}
}

/**
 * Finds a note's drawn tables and marks the frozen ones; styles.css does the rest. Nothing here runs as the
 * note scrolls. The mark is read when a table is drawn, and again when a change touches its header line, so
 * typing elsewhere costs one comparison per drawn table.
 */
class FrozenTables implements PluginValue {
	private readonly known = new WeakMap<HTMLElement, DrawnTable>();
	/** The tables in the editor's drawn range. */
	private readonly drawn = new Set<DrawnTable>();
	private sizes: ResizeObserver | null = null;

	private readonly onWidgets = (records: MutationRecord[]) => {
		const widgets = new Set<HTMLElement>();
		const collect = (node: Node) => {
			if (isWidget(node)) widgets.add(node);
		};
		for (const { addedNodes, removedNodes } of records) {
			addedNodes.forEach(collect);
			removedNodes.forEach(collect);
		}
		for (const widget of widgets) {
			if (widget.parentElement === this.view.contentDOM) this.add(widget);
			else this.remove(widget);
		}
	};

	/** Obsidian empties the widget and builds the table anew, so the marks on its rows have gone. */
	private readonly onRebuilt = (records: MutationRecord[]) => {
		for (const widget of new Set(records.map(({ target }) => target))) {
			const table = this.known.get(widget as HTMLElement);
			if (table && this.drawn.has(table)) this.refresh(table);
		}
	};

	private readonly onResized = (entries: ResizeObserverEntry[]) => {
		const paneHeight = this.view.scrollDOM.clientHeight;
		const widgets = entries.map(({ target }) => target.closest<HTMLElement>(`.${TABLE_CLASS}`));
		const tables = entries.some(({ target }) => target === this.view.scrollDOM) ? this.drawn : new Set(widgets.map((widget) => widget && this.known.get(widget)));
		for (const table of tables) table?.measure(paneHeight);
	};

	private readonly widgets = new MutationObserver(this.onWidgets);
	private readonly rebuilds = new MutationObserver(this.onRebuilt);

	/** After the editor draws a change to a header line: the plugin's update runs before the DOM catches up. */
	private readonly reread = {
		key: 'rereadFreezes',
		read: () => undefined,
		write: () => this.drawn.forEach((table) => this.refresh(table)),
	};

	constructor(private readonly view: EditorView) {
		this.widgets.observe(view.contentDOM, { childList: true });
		// When the plugin is turned on, the editor already holds its tables.
		view.requestMeasure({
			read: () => view.contentDOM.querySelectorAll<HTMLElement>(`:scope > .${TABLE_CLASS}`),
			write: (widgets) => widgets.forEach((widget) => this.add(widget)),
		});
	}

	/**
	 * A key moved the selected cell up or left. A frozen cell is always in view, so the rows and columns that
	 * belong beside it stay hidden, with no key to reach them, unless the table goes back to that end.
	 */
	backToStart(toward: 'up' | 'left') {
		const { contentDOM, scrollDOM } = this.view;
		this.view.requestMeasure({
			key: 'backToStart',
			read: () => {
				const cell = contentDOM.querySelector<HTMLElement>(`.${CELL_CLASS}`);
				const widget = cell?.closest<HTMLElement>(`.${TABLE_CLASS}`);
				if (!cell || !widget) return null;
				if (toward === 'left') return getComputedStyle(cell).position === 'sticky' ? { widget, past: 0 } : null;
				if (!widget.classList.contains(ROWS_CLASS) || !cell.parentElement?.classList.contains(ROW_CLASS)) return null;
				return { widget, past: scrollDOM.getBoundingClientRect().top - widget.getBoundingClientRect().top };
			},
			write: (found) => {
				if (found && toward === 'left') found.widget.scrollLeft = 0;
				if (found && found.past > 0) scrollDOM.scrollTop -= found.past;
			},
		});
	}

	update(update: ViewUpdate) {
		if (!update.docChanged) return;
		let header = false;
		for (const table of this.drawn) {
			const line = update.startState.doc.lineAt(table.from);
			header ||= update.changes.touchesRange(line.from, line.to) !== false;
			table.from = update.changes.mapPos(table.from, 1);
		}
		if (header) this.view.requestMeasure(this.reread);
	}

	destroy() {
		this.widgets.disconnect();
		this.rebuilds.disconnect();
		this.sizes?.disconnect();
		for (const table of this.drawn) table.clear();
		this.drawn.clear();
	}

	private add(widget: HTMLElement) {
		const table = this.known.get(widget) ?? new DrawnTable(widget);
		if (this.drawn.has(table)) return;
		this.known.set(widget, table);
		this.drawn.add(table);
		this.rebuilds.observe(widget, { childList: true });
		this.refresh(table);
	}

	/** Out of the drawn range. What's marked stays, so the table comes back ready. */
	private remove(widget: HTMLElement) {
		const table = this.known.get(widget);
		if (!table || !this.drawn.delete(table)) return;
		this.unwatch(table);
	}

	/** Reads the table's mark, marks what's drawn, and watches its size. Watching starts with one measure. */
	private refresh(table: DrawnTable) {
		const { view } = this;
		table.from = view.posAtDOM(table.widget);
		this.unwatch(table);
		table.mark(readFreeze(view.state.doc.lineAt(table.from).text));
		if (table.watched.length) {
			this.sizes ??= new (table.widget.ownerDocument.defaultView ?? window).ResizeObserver(this.onResized);
			this.sizes.observe(view.scrollDOM);
			for (const element of table.watched) this.sizes.observe(element);
		}
	}

	private unwatch(table: DrawnTable) {
		for (const element of table.watched) this.sizes?.unobserve(element);
	}
}

export const frozenTables = ViewPlugin.fromClass(FrozenTables);
