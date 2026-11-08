import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { CELL_CLASS, cellSelection, pinnedTables, TABLE_CLASS } from './cells';
import { showsCellAfter } from './decide';
import { Freeze, markedCells, MAX_FROZEN_COLUMNS, readFreeze } from './freeze-mark';
import { Paint, readPaint } from './theme-paint';

/** On a table's widget while anything in it is frozen. */
const FROZEN_CLASS = 'selectable-tables-frozen';
/**
 * Also on a frozen table's widget when its theme collapses the table's borders. Collapsed borders belong to
 * the table and stay behind when cells move, so styles.css gives the cells their own then. A theme with
 * separate borders already has its cells draw them, so they're left as they are.
 */
const OWN_BORDERS_CLASS = 'selectable-tables-own-borders';
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
/**
 * On each header cell holding a mark, frozen or not, so styles.css can drop the space typed beside the mark.
 * Obsidian keeps a cell's element when it opens, closes or draws the cell again, so the class stays.
 */
const MARK_CELL_CLASS = 'selectable-tables-mark-cell';

const columnsClass = (count: number) => `${COLUMNS_CLASS}-${count}`;
const columnVariable = (column: number) => `--selectable-tables-column-${column}`;
/** How far the frozen rows travel, and how much of their animation that takes. They're on the rows: a variable on the table would restyle every cell. */
const TRAVEL_VARIABLE = '--selectable-tables-travel';
const PIN_END_VARIABLE = '--selectable-tables-pin-end';
/** On the cover, for the same reason. */
const TABLE_HEIGHT_VARIABLE = '--selectable-tables-table-height';
/** How far past the pane's top the rows' animation goes on, as in styles.css. */
export const ANIMATION_REACH = 4000;

/** How far below the pane's top the rows pin, from styles.css. Not 0 only on a phone. */
const PIN_TOP_VARIABLE = '--selectable-tables-pin-top';

/** Obsidian's, on the body of a phone or tablet. */
const MOBILE_CLASS = 'is-mobile';
/** On a widget and its rows for a moment, to take their timeline and animation off. */
const RESTARTING_CLASS = 'selectable-tables-restarting';
/**
 * The least time between two restarts. A keyboard moves the pane in steps further apart than this, and each
 * restarts the rows at once; a pane resized on every frame, as on a tablet, restarts them at most this often.
 */
const RESTART_GAP = 120;

/**
 * Whether this device can pin a table's rows: that takes scroll-driven animations, which an iPhone or iPad
 * has only from iOS 26. All of freezing hangs off what's marked here, so without them every table reads as
 * freezing nothing, and scrolls as usual rather than pinning its columns and not its rows. Its mark's cell
 * is still marked, since the mark's space shows there too.
 */
export const canFreeze = () => CSS.supports('animation-timeline', 'view()');

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function setVariable(element: HTMLElement, name: string, value: string) {
	if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

/** The editors open now, so a change of theme reaches them all. */
const editors = new Set<FrozenTables>();

/** Obsidian's `css-change`: the theme, its colors, or a snippet has changed, so frozen tables read their colors again. */
export function themeChanged() {
	for (const editor of editors) editor.repaint();
}

/** What the theme paints, by where a table sits. */
type Paints = Map<string, Paint>;
/** More places than this in one editor means classes that keep changing, so its map starts again. */
const MOST_PLACES = 32;
/**
 * Classes that come and go around a table without changing its colors: focus, a selected table, the moment
 * after switching light and dark, a phone's header hiding as you scroll. A place leaves them out.
 */
const PASSING_CLASSES = new Set(['cm-focused', 'is-focused', 'has-focus', 'no-transition', 'is-hidden-nav', 'selectable-tables-selected']);

/** Where a table sits, for its paint: the classes of everything around it. */
function placeOf(widget: HTMLElement) {
	const places: string[] = [];
	for (let at = widget.parentElement; at; at = at.parentElement) places.push(Array.from(at.classList).filter((name) => !PASSING_CLASSES.has(name)).join(' '));
	return places.join('\n');
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
	/** What the theme paints behind the cells, read before they were marked, and which of the editor's themes it was read under. */
	private paint: Paint | null = null;
	private theme = -1;

	constructor(readonly widget: HTMLElement) {
		if (widget.classList.contains(FROZEN_CLASS)) this.scrub();
	}

	/**
	 * Takes off marks another copy of the plugin left: one turned off, or updated, while this table was out
	 * of the editor's drawn range, which kept its widget. Read from what's there, since this copy never knew
	 * the table, and before anything reads its colors.
	 */
	private scrub() {
		const { widget } = this;
		widget.classList.remove(FROZEN_CLASS, OWN_BORDERS_CLASS, ROWS_CLASS, COLUMNS_CLASS, RESTARTING_CLASS, ...Array.from({ length: MAX_FROZEN_COLUMNS }, (_, index) => columnsClass(index + 1)));
		for (const name of Array.from(widget.style)) if (name.startsWith('--selectable-tables-')) widget.style.removeProperty(name);
		widget.querySelectorAll(`.${COVER_CLASS}`).forEach((cover) => cover.remove());
		widget.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`).forEach((row) => {
			row.classList.remove(ROW_CLASS, RESTARTING_CLASS);
			row.style.removeProperty(TRAVEL_VARIABLE);
			row.style.removeProperty(PIN_END_VARIABLE);
		});
	}

	/** What to watch for a change of size. */
	get watched(): HTMLElement[] {
		return this.table ? [this.widget, this.table, ...this.rows, ...this.headers] : [];
	}

	/** The rows pinned now. */
	get pinned(): HTMLElement[] {
		return this.widget.classList.contains(ROWS_CLASS) ? this.rows : [];
	}

	/**
	 * Takes off what's marked if the table, its freeze or the theme has changed since, and says whether
	 * there's anything to mark. `read` and `mark` follow. They're apart so that a batch of tables is all read
	 * before any is marked: each mark changes styles, which the next read would have to work out again.
	 */
	unmark(freeze: Freeze, theme: number): boolean {
		const table = this.widget.querySelector('table');
		if (table === this.table && freeze.rows === this.freeze.rows && freeze.columns === this.freeze.columns && this.theme === theme) return false;
		this.clear();
		this.freeze = freeze;
		if (!table || (!freeze.rows && !freeze.columns)) return false;
		this.table = table;
		return true;
	}

	/**
	 * Finds what the theme paints behind the cells, read from the first table drawn in the same place, or from
	 * this one with nothing marked: styles.css paints frozen cells over the theme's own colors.
	 */
	read(paints: Paints, theme: number) {
		const { widget, table } = this;
		if (!table) return;
		const place = placeOf(widget);
		let paint = paints.get(place);
		if (!paint) {
			paint = readPaint(widget, table);
			if (paint.typical) {
				if (paints.size >= MOST_PLACES) paints.clear();
				paints.set(place, paint);
			}
		}
		this.paint = paint;
		this.theme = theme;
	}

	/**
	 * Marks the frozen rows and columns of what's drawn now, pinned from the start: taking that up after
	 * the first layout would lay a long table out twice. `measure` unpins whatever turns out not to fit.
	 */
	mark() {
		const { widget, table, freeze, paint } = this;
		if (!table || !paint) return;
		const rows = Array.from(table.rows).slice(0, freeze.rows);
		const headers = Array.from(table.rows[0]?.cells ?? []).slice(0, freeze.columns);
		this.rows = rows;
		this.headers = headers;
		widget.classList.add(FROZEN_CLASS);
		if (paint.collapsed) widget.classList.add(OWN_BORDERS_CLASS);
		for (const [name, value] of paint.variables) setVariable(widget, name, value);
		if (rows.length) widget.classList.add(ROWS_CLASS);
		if (headers.length) {
			widget.classList.add(COLUMNS_CLASS, columnsClass(headers.length));
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
		pinnedTables.set(widget, { rows: rows.length, columns: headers.length, height: pinRows ? height : 0, width: pinColumns ? padding + sum(widths) : 0 });
	}

	/** Takes everything off. */
	clear() {
		const { widget, rows, headers, paint } = this;
		for (const row of rows) {
			row.classList.remove(ROW_CLASS);
			row.style.removeProperty(TRAVEL_VARIABLE);
			row.style.removeProperty(PIN_END_VARIABLE);
		}
		for (const [name] of paint?.variables ?? []) widget.style.removeProperty(name);
		headers.forEach((_, index) => widget.style.removeProperty(columnVariable(index + 1)));
		this.cover?.remove();
		this.cover = null;
		widget.classList.remove(FROZEN_CLASS, OWN_BORDERS_CLASS, ROWS_CLASS, COLUMNS_CLASS, columnsClass(headers.length));
		pinnedTables.delete(widget);
		this.table = null;
		this.rows = [];
		this.headers = [];
		this.paint = null;
		this.freeze = { rows: 0, columns: 0 };
	}

	/**
	 * Marks the header cells that hold a mark, and only those, by column: Obsidian's cells line up with the
	 * header line's. Every header cell is set, so a class left by another copy of the plugin, or by a mark
	 * that's gone, comes off too. A cell already right isn't touched, so it isn't styled again.
	 */
	showMarks(columns: number[]) {
		const header = this.widget.querySelector('table')?.rows[0];
		Array.from(header?.cells ?? []).forEach((cell, column) => cell.classList.toggle(MARK_CELL_CLASS, columns.includes(column)));
	}
}

/**
 * Finds a note's drawn tables and marks the frozen ones, and the header cells holding a mark; styles.css does
 * the rest. Nothing here runs as the note scrolls. The mark is read when a table is drawn, and again when a
 * change touches its header line, so typing elsewhere costs one comparison per drawn table. It runs on every
 * device, but freezes only where `canFreeze` says rows can pin.
 */
class FrozenTables implements PluginValue {
	private readonly freezes = canFreeze();
	private readonly known = new WeakMap<HTMLElement, DrawnTable>();
	/** The tables in the editor's drawn range. */
	private readonly drawn = new Set<DrawnTable>();
	private sizes: ResizeObserver | null = null;
	private paneHeight = 0;
	private restart = 0;
	/**
	 * Counts this editor's changes of theme: a table is read again when it's next marked under one it wasn't
	 * read under, which `repaint` does at once for the tables on screen.
	 */
	private theme = 0;
	/**
	 * What the theme paints, by place. Reading a table that's just been drawn works out the styles of all of
	 * it, and marking it has them worked out again, which costs as much as drawing it. Tables drawn in the same
	 * place are painted alike, so only the first is read. Kept for each editor: a canvas card's colors are its own.
	 */
	private readonly paints: Paints = new Map();
	private restarted = -Infinity;
	/**
	 * A freeze command, Undo or Redo has changed a header line, so the selected cell is shown once the new
	 * freeze is marked (`asked`), and measured after the editor's own scroll (`armed`).
	 */
	private showing: 'no' | 'asked' | 'armed' = 'no';

	private readonly onWidgets = (records: MutationRecord[]) => {
		const widgets = new Set<HTMLElement>();
		const collect = (node: Node) => {
			if (isWidget(node)) widgets.add(node);
		};
		for (const { addedNodes, removedNodes } of records) {
			addedNodes.forEach(collect);
			removedNodes.forEach(collect);
		}
		const added: DrawnTable[] = [];
		for (const widget of widgets) {
			if (widget.parentElement !== this.view.contentDOM) this.remove(widget);
			else added.push(...this.add(widget));
		}
		this.refresh(added);
	};

	/** Obsidian empties the widget and builds the table anew, so the marks on its rows have gone. */
	private readonly onRebuilt = (records: MutationRecord[]) => {
		const tables = new Set(records.map(({ target }) => this.known.get(target as HTMLElement)));
		this.refresh([...this.drawn].filter((table) => tables.has(table)));
	};

	private readonly onResized = (entries: ResizeObserverEntry[]) => {
		const paneHeight = this.view.scrollDOM.clientHeight;
		const widgets = entries.map(({ target }) => target.closest<HTMLElement>(`.${TABLE_CLASS}`));
		const tables = entries.some(({ target }) => target === this.view.scrollDOM) ? this.drawn : new Set(widgets.map((widget) => widget && this.known.get(widget)));
		for (const table of tables) table?.measure(paneHeight);
		if (this.showing === 'armed') {
			this.showing = 'no';
			this.view.plugin(cellSelection)?.showSelected();
		}
		if (paneHeight === this.paneHeight) return;
		const changed = this.paneHeight > 0;
		this.paneHeight = paneHeight;
		if (!changed || !this.view.dom.ownerDocument.body.classList.contains(MOBILE_CLASS)) return;
		// Here, before the pane is drawn at its new size, so iOS never draws a row it has lost.
		window.clearTimeout(this.restart);
		if (performance.now() - this.restarted >= RESTART_GAP) this.restartRows();
		else this.restart = window.setTimeout(this.restartRows, RESTART_GAP);
	};

	/**
	 * Starts the rows' animation again, on a new timeline. A keyboard changing an iPhone's pane with the caret
	 * in one of the table's cells can leave iOS's own copy of the animation no longer following the scroll, so
	 * it draws the rows where they sit in the table, while the page reads correct; this clears it. It runs on
	 * every change of height, since it costs about a millisecond and the trigger isn't fully known. The timeline
	 * has to be back before the animation looks for it, or the rows stay unattached. Reading a style brings
	 * both up to date without laying the page out.
	 */
	private readonly restartRows = () => {
		this.restarted = performance.now();
		const tables = [...this.drawn].filter(({ pinned }) => pinned.length);
		const rows = tables.flatMap(({ pinned }) => pinned);
		if (!rows.length) return;
		const settle = () => tables.forEach(({ widget }) => getComputedStyle(widget).getPropertyValue('view-timeline-name'));
		for (const row of rows) row.classList.add(RESTARTING_CLASS);
		for (const { widget } of tables) widget.classList.add(RESTARTING_CLASS);
		settle();
		for (const { widget } of tables) widget.classList.remove(RESTARTING_CLASS);
		settle();
		for (const row of rows) row.classList.remove(RESTARTING_CLASS);
	};

	private readonly widgets = new MutationObserver(this.onWidgets);
	private readonly rebuilds = new MutationObserver(this.onRebuilt);

	/** After the editor draws a change to a header line: the plugin's update runs before the DOM catches up. */
	private readonly reread = {
		key: 'rereadFreezes',
		read: () => undefined,
		write: () => {
			this.refresh([...this.drawn]);
			if (this.showing !== 'asked') return;
			this.showing = 'armed';
			this.measureAfterLayout();
		},
	};

	/**
	 * Has every drawn table measured once this frame is laid out, which is after the editor's own scroll:
	 * Undo and Redo scroll their selection, the whole table, into view, after anything this plugin writes.
	 * Watching the pane anew sends a size at once, even an unchanged one, and so does a table that's been
	 * marked, but an unfrozen table has nothing left to watch.
	 */
	private measureAfterLayout() {
		const { scrollDOM } = this.view;
		this.sizes ??= new (scrollDOM.ownerDocument.defaultView ?? window).ResizeObserver(this.onResized);
		this.sizes.unobserve(scrollDOM);
		this.sizes.observe(scrollDOM);
	}

	constructor(private readonly view: EditorView) {
		editors.add(this);
		this.widgets.observe(view.contentDOM, { childList: true });
		// When the plugin is turned on, the editor already holds its tables.
		view.requestMeasure({
			read: () => view.contentDOM.querySelectorAll<HTMLElement>(`:scope > .${TABLE_CLASS}`),
			write: (widgets) => this.refresh(Array.from(widgets).flatMap((widget) => this.add(widget))),
		});
	}

	/**
	 * After a change of theme, reads and marks the frozen tables on screen again, on the editor's next frame.
	 * The rest wait until they're drawn. A popout window takes on the new look a moment after the event, and
	 * a font size slider sends one on every step, so this waits for the frame, and does it once.
	 */
	private readonly repainting = {
		key: 'repaintFrozen',
		read: () => undefined,
		write: () => {
			this.theme++;
			this.paints.clear();
			this.refresh([...this.drawn]);
		},
	};

	repaint() {
		this.view.requestMeasure(this.repainting);
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
				const pinTop = parseFloat(getComputedStyle(widget).getPropertyValue(PIN_TOP_VARIABLE)) || 0;
				return { widget, past: scrollDOM.getBoundingClientRect().top + pinTop - widget.getBoundingClientRect().top };
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
		if (!header) return;
		this.view.requestMeasure(this.reread);
		if (update.transactions.some(showsCellAfter)) this.showing = 'asked';
	}

	destroy() {
		editors.delete(this);
		window.clearTimeout(this.restart);
		this.widgets.disconnect();
		this.rebuilds.disconnect();
		this.sizes?.disconnect();
		for (const table of this.drawn) {
			table.clear();
			table.showMarks([]);
		}
		this.drawn.clear();
	}

	/** Starts keeping a table that's come into the drawn range, and gives it back to be refreshed. */
	private add(widget: HTMLElement): DrawnTable[] {
		const table = this.known.get(widget) ?? new DrawnTable(widget);
		if (this.drawn.has(table)) return [];
		this.known.set(widget, table);
		this.drawn.add(table);
		this.rebuilds.observe(widget, { childList: true });
		return [table];
	}

	/** Out of the drawn range. What's marked stays, so the table comes back ready. */
	private remove(widget: HTMLElement) {
		const table = this.known.get(widget);
		if (!table || !this.drawn.delete(table)) return;
		this.unwatch(table);
	}

	/**
	 * Reads each table's mark, marks what's drawn, and watches its size. Watching starts with one measure.
	 * Every table that needs it is read before any is marked, so the page's styles are worked out once.
	 */
	private refresh(drawn: DrawnTable[]) {
		const { view } = this;
		const tables = drawn.filter(({ widget }) => widget.isConnected);
		const headerLines = new Map<DrawnTable, string>();
		const marking = tables.filter((table) => {
			table.from = view.posAtDOM(table.widget);
			this.unwatch(table);
			const header = view.state.doc.lineAt(table.from).text;
			headerLines.set(table, header);
			return table.unmark(this.freezes ? readFreeze(header) : { rows: 0, columns: 0 }, this.theme);
		});
		for (const table of marking) table.read(this.paints, this.theme);
		for (const table of marking) table.mark();
		for (const table of tables) table.showMarks(markedCells(headerLines.get(table) ?? ''));
		for (const table of tables) {
			if (!table.watched.length) continue;
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
