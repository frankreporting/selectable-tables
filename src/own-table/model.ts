import type { Text } from '@codemirror/state';
import type { EditorView, Rect } from '@codemirror/view';
import { type App, Component, editorInfoField, getLinkpath, MarkdownRenderer } from 'obsidian';
import { markedCells } from '../editor/freeze-mark';
import { rowCells, type Span } from '../editor/table-text';
import { fitColumns, measureCell, type Metrics, rowHeight, type Words } from './estimate';
import { covers, Heights, type RowRange, type Visible, wanted } from './heights';
import { measure } from './metrics';
import { timed } from './profile';
import { type Align, alignOf, cellsOf, columnAt, type LineChange, linesOf, markdownOf, rowSplices, type TableLines } from './shape';

/** Rows are drawn to OVER px past the pane, and drawn again once those drawn reach less than MARGIN past it. */
const OVER = 1000;
const MARGIN = 900;
/** A table of no more rows than this is drawn whole, as Obsidian draws it: no rows come in as it scrolls. */
const WHOLE = 100;
/** Rows that leave the page are kept, to put back without rendering again; past this many, the oldest go. */
const SPARE = 400;

/** On the plugin's table's box, beside Obsidian's own classes for its table. */
export const OWN_CLASS = 'selectable-tables-own';
/** On rows that stand in for rows not drawn, above and below those that are. */
const SPACER_CLASS = 'selectable-tables-spacer';
/** On a hidden row that only keeps the drawn rows odd or even, for themes that stripe rows. */
const PARITY_CLASS = 'selectable-tables-parity';
/** On a header cell holding a freeze mark: styles.css has it drop the space beside the mark. */
const MARK_CELL_CLASS = 'selectable-tables-mark-cell';

let ids = 0;

/** For the check script only: puts each row's estimated height off by up to this fraction, to test the corrections. */
let skew = 0;
export function skewEstimates(fraction: number): void {
	skew = fraction;
}
const skewed = (height: number, row: number) => (skew ? height * (1 + skew * Math.sin(row * 12.9898)) : height);

/** A spacer row: one cell across the table. */
function spacer(...classes: string[]): HTMLTableRowElement {
	const tr = createEl('tr', { cls: [SPACER_CLASS, ...classes] });
	tr.createEl('td');
	return tr;
}

/** The renderer's children for a batch of rendered rows, such as embeds, and how many of its rows are still kept. */
interface Batch {
	component: Component;
	rows: number;
}

/** The heights a draw reads back from the page. */
interface Measured {
	rows: [number, number][];
	head: number;
}

/**
 * One table in one editor, drawn by the plugin: the note's text decides what it shows, and only the rows near the
 * pane are in the page, with spacers standing in for the rest. It lives as long as the table does, across changes
 * to the note, and its DOM is kept while it lives, so CodeMirror can put it back when the table scrolls into view.
 */
export class Model implements Span {
	readonly id = ++ids;
	view: EditorView | null = null;
	private readonly component = new Component();

	// The shape, from the text.
	private columns = 0;
	private aligns: Align[] = [];
	private widths: number[] = [];
	private headWords: Words[] = [];
	private rowWords: Words[][] = [];
	readonly heights = new Heights();
	private headHeight = 0;
	private metrics: Metrics | null = null;
	/** The shape is to be worked out again from the whole text. */
	private stale = true;
	/** The note's text the shape holds for. A change from any other text works the shape out again. */
	private text: Text | null = null;

	// The page.
	private dom: HTMLElement | null = null;
	private table: HTMLTableElement | null = null;
	private colgroup: HTMLTableColElement | null = null;
	private thead: HTMLTableSectionElement | null = null;
	private tbody: HTMLTableSectionElement | null = null;
	private readonly above = spacer();
	private readonly parity = spacer(PARITY_CLASS);
	private readonly below = spacer();
	/** The widths and columns on the page, to tell when the shape's differ. */
	private applied = '';
	private readonly rendered = new Map<number, HTMLTableRowElement>();
	private readonly spare = new Map<number, HTMLTableRowElement>();
	/** The text each drawn row was drawn from. */
	private readonly drawnFrom = new WeakMap<HTMLTableRowElement, string>();
	/** The batch each rendered row came from, unloaded once none of its rows is kept. */
	private readonly batchOf = new WeakMap<HTMLTableRowElement, Batch>();
	private headText: string | null = null;
	private drawn: RowRange = { first: 0, end: 0 };
	private readonly dirty = new Set<number>();
	private checkRows = false;
	/** Something changed that the page doesn't show yet. */
	private todo = true;
	/** The rows' heights are estimates again, and the drawn rows are to be measured. */
	private remeasure = false;
	private pending = false;
	private force = false;
	private readonly drawKey = {};
	private readonly heightKey = {};

	constructor(
		private readonly app: App,
		public from: number,
		public to: number,
		/** Selects the table whole. */
		private readonly select: (model: Model) => void,
	) {
		this.component.load();
	}

	get count(): number {
		return this.heights.count;
	}

	/** Whether the table's box is in the page now. */
	get shown(): boolean {
		return !!this.dom?.isConnected;
	}

	/** The table's box, if built. */
	get box(): HTMLElement | null {
		return this.dom;
	}

	destroy(): void {
		this.component.unload();
		this.view = null;
	}

	// The shape --------------------------------------------------------------------------------------------------

	/** Works out the whole shape from the text, if it's stale or the sizes it was worked out with changed. */
	ensureShape(doc: Text, metrics: Metrics | null): void {
		if (!metrics) return;
		if (this.stale || this.metrics !== metrics) this.shape(doc, metrics);
	}

	/** Whether the shape is known, so the table's height can be given before it's drawn. */
	get shaped(): boolean {
		return !this.stale && !!this.metrics;
	}

	/** The table's height with its box's padding, as estimated. */
	get height(): number {
		return (this.metrics?.pad ?? 0) + this.headHeight + this.heights.total();
	}

	private shape(doc: Text, metrics: Metrics): void {
		const { header, count } = linesOf(doc, this);
		const lines = Array.from({ length: count }, (_, r) => doc.line(header + 2 + r).text);
		const headLine = doc.line(header).text;
		const delimiter = rowCells(header < doc.lines ? doc.line(header + 1).text : '');
		let columns = Math.max(delimiter.length, rowCells(headLine).length);
		for (const line of lines) columns = Math.max(columns, rowCells(line).length);
		const changedColumns = columns !== this.columns;
		this.columns = columns;
		this.aligns = Array.from({ length: columns }, (_, c) => alignOf(delimiter[c] ?? ''));
		this.metrics = metrics;
		this.headWords = cellsOf(headLine, columns).map((text) => measureCell(text, metrics, true, measure));
		this.rowWords = lines.map((line) => this.measureRow(line));
		this.widths = this.fit();
		this.headHeight = rowHeight(this.headWords, this.widths, metrics, true);
		this.heights.splice(0, this.heights.count, this.rowWords.map((cells, r) => skewed(rowHeight(cells, this.widths, metrics, false), r)));
		this.stale = false;
		this.text = doc;
		if (changedColumns) this.redrawAll();
		this.checkRows = true;
		this.todo = true;
		this.remeasure = true;
	}

	private measureRow(line: string): Words[] {
		return cellsOf(line, this.columns).map((text) => measureCell(text, this.metrics!, false, measure));
	}

	/** Column widths from every cell's size. */
	private fit(): number[] {
		const mins = this.headWords.map((w) => w.min);
		const maxs = this.headWords.map((w) => w.max);
		for (const cells of this.rowWords) {
			cells.forEach((w, c) => {
				if (w.min > mins[c]!) mins[c] = w.min;
				if (w.max > maxs[c]!) maxs[c] = w.max;
			});
		}
		return fitColumns(mins, maxs, this.metrics!);
	}

	/**
	 * The note changed, from `oldDoc` to `doc`: the table, already placed at its new span, follows it. Untouched,
	 * it keeps its shape. A change in it measures the rows the change touched again. A change from a text other
	 * than the one the shape holds for, such as a transaction worked out and then replaced, starts again from the
	 * whole text.
	 */
	track(oldDoc: Text, doc: Text, before: TableLines, change: LineChange | null): void {
		if (this.text !== oldDoc) {
			this.stale = true;
			this.checkRows = true;
			this.todo = true;
		} else if (change || linesOf(doc, this).count !== before.count) this.edit(doc, before, change);
		this.text = doc;
	}

	/**
	 * The table's text changed: rows a change touched are measured again, and the rest keep their sizes. A change
	 * to the header, the delimiter or the number of columns works the whole shape out again.
	 */
	private edit(doc: Text, before: TableLines, change: LineChange | null): void {
		this.checkRows = true;
		this.todo = true;
		if (this.stale || !this.metrics) return;
		const now = linesOf(doc, this);
		const splices = change ? rowSplices(before, now, change) : before.count === now.count ? [] : null;
		if (!splices) {
			this.stale = true;
			return;
		}
		for (const { at, removed, added } of splices) {
			const lines = Array.from({ length: added }, (_, i) => doc.line(now.header + 2 + at + i).text);
			if (lines.some((line) => rowCells(line).length > this.columns)) {
				this.stale = true;
				return;
			}
			const words = lines.map((line) => this.measureRow(line));
			this.rowWords.splice(at, removed, ...words);
			this.heights.splice(at, removed, words.map((cells) => rowHeight(cells, this.widths, this.metrics!, false)));
			this.shiftRows(at, removed, added);
		}
		const widths = this.fit();
		if (widths.join(',') !== this.widths.join(',')) {
			this.widths = widths;
			this.headHeight = rowHeight(this.headWords, widths, this.metrics, true);
			this.rowWords.forEach((cells, r) => this.heights.set(r, rowHeight(cells, widths, this.metrics!, false), false));
			this.remeasure = true;
		}
	}

	/**
	 * Drawn rows past a splice move with their rows; those it took out leave the page, and the rows it added are
	 * drawn on the next measure.
	 */
	private shiftRows(at: number, removed: number, added: number): void {
		for (const tr of this.spare.values()) this.release(tr);
		this.spare.clear();
		if (added) this.remeasure = true;
		if (removed === added) return;
		const moved: [number, HTMLTableRowElement][] = [];
		for (const [row, tr] of this.rendered) {
			if (row < at) continue;
			this.rendered.delete(row);
			if (row < at + removed) {
				tr.remove();
				this.release(tr);
			} else moved.push([row + added - removed, tr]);
		}
		for (const [row, tr] of moved) this.rendered.set(row, tr);
		const shift = (row: number) => (row < at ? row : Math.max(at, row + added - removed));
		this.drawn = { first: shift(this.drawn.first), end: shift(this.drawn.end) };
		this.dirty.clear();
	}

	/** The sizes changed, the theme's or the pane's: the shape is worked out again. */
	resize(): void {
		this.stale = true;
		this.metrics = null;
		this.todo = true;
	}

	/** Whether the page has something to catch up on. */
	get behind(): boolean {
		return this.todo;
	}

	// The page ---------------------------------------------------------------------------------------------------

	/** The table's box for CodeMirror, built the first time and kept. Without sizes yet, its rows come later. */
	mount(view: EditorView, metrics: Metrics | null): HTMLElement {
		return timed('mount', () => this.mountNow(view, metrics));
	}

	private mountNow(view: EditorView, metrics: Metrics | null): HTMLElement {
		this.view = view;
		this.ensureShape(view.state.doc, metrics);
		if (!this.dom) this.build();
		this.refresh();
		return this.dom!;
	}

	private build(): void {
		const dom = createDiv({ cls: ['cm-embed-block', 'cm-table-widget', 'markdown-rendered', OWN_CLASS] });
		const table = dom.createDiv('table-wrapper').createEl('table', { cls: 'table-editor' });
		this.colgroup = table.createEl('colgroup');
		this.thead = table.createEl('thead');
		this.tbody = table.createEl('tbody');
		// A press anywhere but a link selects the whole table. The browser moves no caret and starts no selection:
		// the press's default is prevented, apart from the table's own scrollbar.
		const onScrollbar = (event: MouseEvent) => event.target === dom && (event.offsetX >= dom.clientWidth || event.offsetY >= dom.clientHeight);
		const leftAlone = (event: MouseEvent) => event.button !== 0 || onScrollbar(event) || !!(event.target as Element).closest('a');
		const hold = (event: MouseEvent) => {
			if (!leftAlone(event)) event.preventDefault();
		};
		dom.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse') hold(event);
		});
		dom.addEventListener('mousedown', hold);
		dom.addEventListener('click', (event) => {
			if (!leftAlone(event)) this.select(this);
		});
		// A picture that loads changes its row's height.
		dom.addEventListener('load', () => this.schedule(true), true);
		this.dom = dom;
		this.table = table;
	}

	/** Puts what changed on the page: new widths, the header, rows whose text changed, then the rows near the pane. */
	refresh(): void {
		const view = this.view;
		if (!view || !this.dom || !this.metrics || this.stale) return;
		this.todo = false;
		this.apply();
		const doc = view.state.doc;
		if (this.checkRows) {
			this.checkRows = false;
			const { header } = linesOf(doc, this);
			for (const [row, tr] of this.rendered) {
				if (row >= this.count || doc.line(header + 2 + row).text !== this.drawnFrom.get(tr)) this.dirty.add(row);
			}
		}
		if (doc.lineAt(this.from).text !== this.headText) this.renderHead();
		this.arrange();
		this.schedule(this.dirty.size > 0 || this.remeasure);
		this.remeasure = false;
	}

	/** Every row drawn again, after the columns changed. */
	private redrawAll(): void {
		for (const tr of this.rendered.values()) {
			tr.remove();
			this.release(tr);
		}
		for (const tr of this.spare.values()) this.release(tr);
		this.rendered.clear();
		this.spare.clear();
		this.drawn = { first: 0, end: 0 };
		this.headText = null;
		this.todo = true;
	}

	/** The columns' widths on the page. Fixed widths keep columns still as rows come and go. */
	private apply(): void {
		const key = `${this.columns}:${this.widths.join(',')}`;
		if (key === this.applied || !this.colgroup || !this.table) return;
		this.colgroup.empty();
		for (const width of this.widths) this.colgroup.createEl('col').style.width = `${width}px`;
		this.table.style.width = `${this.widths.reduce((sum, width) => sum + width, 0)}px`;
		for (const row of [this.above, this.parity, this.below]) (row.firstChild as HTMLTableCellElement).colSpan = Math.max(1, this.columns);
		if (this.applied) this.schedule(true);
		this.applied = key;
	}

	/**
	 * The body's rows in order: a spacer for the rows above those drawn, a hidden row when needed to keep each
	 * drawn row odd or even as in the whole table, the drawn rows, and a spacer for the rows below.
	 */
	private arrange(): void {
		const body = this.tbody;
		if (!body) return;
		let { first, end } = this.drawn;
		while (first < end && !this.rendered.has(first)) first++;
		while (end > first && !this.rendered.has(end - 1)) end--;
		const want: HTMLTableRowElement[] = [];
		const above = first > 0 ? 1 : 0;
		if (above) want.push(this.above);
		if ((first - above) % 2 !== 0) want.push(this.parity);
		// A row an edit added isn't drawn until the next measure: until then, the rows around it close up.
		for (let row = first; row < end; row++) {
			const tr = this.rendered.get(row);
			if (tr) want.push(tr);
		}
		if (end < this.count) want.push(this.below);
		const height = (row: HTMLTableRowElement, px: number) => {
			const cell = row.firstChild as HTMLTableCellElement;
			const value = `${Math.max(0, px)}px`;
			if (cell.style.height !== value) cell.style.height = value;
		};
		height(this.above, this.heights.top(first));
		height(this.below, this.heights.total() - this.heights.top(end));
		const keep = new Set<Node>(want);
		for (let node = body.firstChild; node; ) {
			const next = node.nextSibling;
			if (!keep.has(node)) node.remove();
			node = next;
		}
		let at = body.firstChild;
		for (const row of want) {
			if (row === at) at = at.nextSibling;
			else body.insertBefore(row, at);
		}
	}

	/**
	 * Renders a header and some rows with Obsidian's Markdown renderer, as one table, and gives back its rows,
	 * header first, each cell's content in a wrapper as Obsidian's own table has it. Should the renderer give back
	 * another number of rows, each row is rendered on its own, so no row shows another's text.
	 */
	private render(rows: string[]): HTMLTableRowElement[] {
		const out = this.renderBatch(rows);
		if (out.length === rows.length + 1 || !rows.length) return out;
		for (const tr of out) this.release(tr);
		const [head = createEl('tr')] = this.renderBatch([]);
		return [
			head,
			...rows.map((row) => {
				const [copy, tr = createEl('tr')] = this.renderBatch([row]);
				if (copy) this.release(copy);
				return tr;
			}),
		];
	}

	private renderBatch(rows: string[]): HTMLTableRowElement[] {
		const view = this.view!;
		const header = view.state.doc.lineAt(this.from).text;
		const path = view.state.field(editorInfoField, false)?.file?.path ?? '';
		const holder = createDiv();
		// The rows' embeds and post-processors' children, kept until the last of these rows leaves.
		const batch: Batch = { component: new Component(), rows: 0 };
		this.component.addChild(batch.component);
		void MarkdownRenderer.render(this.app, markdownOf(header, rows, this.columns, this.aligns), holder, path, batch.component);
		const out = Array.from(holder.querySelector('table')?.rows ?? []);
		for (const tr of out) {
			for (const cell of Array.from(tr.cells)) {
				const wrapper = createDiv('table-cell-wrapper');
				wrapper.append(...Array.from(cell.childNodes));
				cell.append(wrapper);
			}
			while (tr.cells.length < this.columns) tr.insertCell().createDiv('table-cell-wrapper');
			this.batchOf.set(tr, batch);
			batch.rows++;
		}
		if (!batch.rows) this.component.removeChild(batch.component);
		// A link to a note that doesn't exist looks as Obsidian draws it.
		for (const link of Array.from(holder.querySelectorAll<HTMLElement>('a.internal-link'))) {
			const href = link.getAttribute('data-href') ?? link.getAttribute('href');
			if (href) link.toggleClass('is-unresolved', !this.app.metadataCache.getFirstLinkpathDest(getLinkpath(href), path));
		}
		return out;
	}

	/** A rendered row that's gone for good: its batch is unloaded once none of its rows is left. */
	private release(tr: HTMLTableRowElement): void {
		const batch = this.batchOf.get(tr);
		if (!batch) return;
		this.batchOf.delete(tr);
		if (--batch.rows <= 0) this.component.removeChild(batch.component);
	}

	private renderHead(): void {
		const thead = this.thead;
		const view = this.view;
		if (!thead || !view) return;
		const text = view.state.doc.lineAt(this.from).text;
		const [row] = this.render([]);
		for (const column of markedCells(text)) row?.cells[column]?.addClass(MARK_CELL_CLASS);
		const old = thead.firstElementChild;
		if (old?.instanceOf(HTMLTableRowElement)) this.release(old);
		thead.empty();
		if (row) thead.append(row);
		this.headText = text;
	}

	/** Rows ready for the page: kept ones whose text is the same, and the rest rendered together. */
	private renderRows(rows: number[]): HTMLTableRowElement[] {
		const doc = this.view!.state.doc;
		const { header } = linesOf(doc, this);
		const out: HTMLTableRowElement[] = [];
		const todo: [number, string][] = [];
		rows.forEach((row, i) => {
			const text = doc.line(header + 2 + row).text;
			const kept = this.spare.get(row);
			this.spare.delete(row);
			if (kept && this.drawnFrom.get(kept) === text) out[i] = kept;
			else {
				if (kept) this.release(kept);
				todo.push([i, text]);
			}
		});
		if (todo.length) {
			// The header Markdown needs to render as a table comes back first, and isn't kept.
			const [head, ...fresh] = this.render(todo.map(([, text]) => text));
			if (head) this.release(head);
			todo.forEach(([i, text], k) => {
				const tr = fresh[k]!;
				this.drawnFrom.set(tr, text);
				out[i] = tr;
			});
		}
		return out;
	}

	/** For the check script: the rows in the page, by row, and the text each was drawn from. */
	drawnRows(): { row: number; tr: HTMLTableRowElement; text: string | undefined }[] {
		return Array.from(this.rendered, ([row, tr]) => ({ row, tr, text: this.drawnFrom.get(tr) }));
	}

	/** Keeps a row that leaves the page, to put back later. */
	private keep(row: number, tr: HTMLTableRowElement): void {
		const was = this.spare.get(row);
		if (was && was !== tr) this.release(was);
		this.spare.delete(row);
		this.spare.set(row, tr);
		if (this.spare.size > SPARE) {
			const [oldest, gone] = this.spare.entries().next().value!;
			this.spare.delete(oldest);
			this.release(gone);
		}
	}

	/** Draws the rows near the pane on CodeMirror's next measure: always, with `force`, else only if they fall short. */
	schedule(force = false): void {
		const view = this.view;
		if (!view) return;
		if (force) this.force = true;
		if (this.pending) return;
		this.pending = true;
		view.requestMeasure({
			key: this.drawKey,
			read: () => timed('measure', () => this.visible()),
			write: (visible) => {
				this.pending = false;
				const forced = this.force;
				this.force = false;
				timed('draw', () => this.draw(visible, forced));
			},
		});
	}

	/** What part of the body is on screen. */
	private visible(): Visible | null {
		const view = this.view;
		if (!view || !this.tbody?.isConnected) return null;
		const scroller = view.scrollDOM;
		const pane = scroller.getBoundingClientRect().top;
		const body = this.tbody.getBoundingClientRect().top;
		return { top: pane - body, bottom: pane + scroller.clientHeight - body };
	}

	private draw(visible: Visible | null, force: boolean): void {
		const view = this.view;
		if (!visible || !view || this.stale) return;
		const whole = this.count <= WHOLE;
		if (!force && !this.dirty.size && (whole ? this.drawn.first === 0 && this.drawn.end === this.count : covers(this.heights, this.drawn, visible, MARGIN))) return;
		const { first, end } = whole ? { first: 0, end: this.count } : wanted(this.heights, visible, OVER);
		// The row at the pane's top stays still while rows above it take their real heights.
		const anchor = visible.top > 0 && visible.top < this.heights.total() ? this.heights.rowAt(visible.top) : -1;
		const anchorTop = anchor >= 0 ? this.headHeight + this.heights.top(anchor) : 0;
		for (const [row, tr] of this.rendered) {
			const changed = this.dirty.has(row);
			if (row >= first && row < end && !changed) continue;
			tr.remove();
			this.rendered.delete(row);
			if (changed) this.release(tr);
			else this.keep(row, tr);
		}
		for (const row of this.dirty) {
			const kept = this.spare.get(row);
			if (kept) this.release(kept);
			this.spare.delete(row);
		}
		this.dirty.clear();
		const need: number[] = [];
		for (let row = first; row < end; row++) if (!this.rendered.has(row)) need.push(row);
		const fresh = this.renderRows(need);
		need.forEach((row, i) => this.rendered.set(row, fresh[i]!));
		this.drawn = { first, end };
		this.arrange();
		if (need.length || force) view.requestMeasure({ key: this.heightKey, read: () => timed('measure', () => this.readHeights()), write: (measured) => timed('draw', () => this.fixHeights(measured, anchor, anchorTop)) });
	}

	private readHeights(): Measured {
		const rows: [number, number][] = [];
		for (const [row, tr] of this.rendered) if (tr.isConnected) rows.push([row, tr.getBoundingClientRect().height]);
		const head = this.thead?.isConnected ? (this.thead.firstElementChild?.getBoundingClientRect().height ?? 0) : 0;
		return { rows, head };
	}

	/** Takes the drawn rows' real heights, and moves the note by however much they moved the row at the pane's top. */
	private fixHeights(measured: Measured, anchor: number, anchorTop: number): void {
		const view = this.view;
		if (!view) return;
		let changed = false;
		for (const [row, height] of measured.rows) if (height > 0 && this.heights.set(row, height, true)) changed = true;
		if (measured.head > 0 && Math.abs(measured.head - this.headHeight) > 0.01) {
			this.headHeight = measured.head;
			changed = true;
		}
		if (!changed) return;
		this.arrange();
		if (anchor >= 0 && anchor < this.count) {
			const delta = this.headHeight + this.heights.top(anchor) - anchorTop;
			if (Math.abs(delta) > 0.01) view.scrollDOM.scrollTop += delta;
		}
	}

	/**
	 * Where a place in the table's text is drawn, `offset` from its start. Without this CodeMirror scrolls the whole
	 * table into view for a place in it, which for a table taller than the pane is its end. A row not drawn yet
	 * takes its place from its estimated height.
	 */
	coordsAt(offset: number): Rect | null {
		const view = this.view;
		if (!view || !this.table?.isConnected || !this.tbody) return null;
		const doc = view.state.doc;
		const line = doc.lineAt(Math.min(doc.length, this.from + offset));
		const index = line.number - doc.lineAt(this.from).number;
		const table = this.table.getBoundingClientRect();
		let tr: HTMLTableRowElement | null | undefined;
		let top: number;
		let bottom: number;
		if (index <= 1) {
			tr = this.thead?.firstElementChild as HTMLTableRowElement | null;
			const rect = tr?.getBoundingClientRect();
			top = rect?.top ?? table.top;
			bottom = rect?.bottom ?? table.top + this.headHeight;
		} else {
			const row = Math.min(this.count - 1, index - 2);
			tr = this.rendered.get(row);
			if (tr?.isConnected) {
				const rect = tr.getBoundingClientRect();
				top = rect.top;
				bottom = rect.bottom;
			} else {
				top = this.tbody.getBoundingClientRect().top + this.heights.top(row);
				bottom = top + this.heights.get(row);
			}
		}
		let { left, right } = table;
		if (tr?.isConnected && index !== 1) {
			const cell = tr.cells[Math.min(columnAt(line.text, this.from + offset - line.from), tr.cells.length - 1)];
			if (cell) ({ left, right } = cell.getBoundingClientRect());
		}
		return { left, right, top, bottom };
	}
}
