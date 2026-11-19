import type { Text } from '@codemirror/state';
import type { EditorView, Rect } from '@codemirror/view';
import { type App, Component, editorInfoField, getLinkpath, MarkdownRenderer } from 'obsidian';
import { OWN_BORDERS_CLASS } from '../editor/freeze';
import { markedCells } from '../editor/freeze-mark';
import { rowCells, type Span } from '../editor/table-text';
import { fitColumns, measureCell, type Metrics, rowHeight, type Words } from './estimate';
import { blockCount, blockHeight, blockOf, blockRows, blockSpans, bodyLayout, topInBlock } from './blocks';
import { BOX_CLASS } from './boxes';
import { covers, Heights, type RowRange, type Visible, wanted } from './heights';
import { measure } from './metrics';
import { timed } from './profile';
import { type Align, alignOf, cellsOf, columnAt, type LineChange, linesOf, markdownOf, rowSplices, type TableLines } from './shape';

/**
 * Rows are drawn to OVER px past the pane, and drawn again once those drawn reach less than MARGIN past it. 1,000 px
 * left one blank band in 2,935 captures at 3,000 and 6,000 px a second (STA-86's timing runs). Real hard flicks and
 * fast mouse wheels run far faster, past 25,000 px a second, and there drawing farther ahead, 3,000 px the way the
 * note scrolls, changed nothing. What blanked the pane for seconds was each batch of rows taking longer than the
 * last, from the renderer's node iterators piling up in the page (see `renderBatch`).
 */
const OVER = 1500;
const MARGIN = 1300;
/** A table of no more rows than this is drawn whole, as Obsidian draws it: no rows come in as it scrolls. */
const WHOLE = 100;
/** Rows that leave the page are kept, to put back without rendering again; past this many, the oldest go. */
const SPARE = 400;

/** On each of the plugin's table's blocks, beside Obsidian's own classes for its table. */
export const OWN_CLASS = 'selectable-tables-own';
/** On a table's first block and its last; a table of one block has both. */
const FIRST_CLASS = 'selectable-tables-first';
const LAST_CLASS = 'selectable-tables-last';
/** On rows that stand in for rows not drawn, above and below those that are. */
const SPACER_CLASS = 'selectable-tables-spacer';
/** On a hidden row that only keeps the drawn rows odd or even, for themes that stripe rows. */
const PARITY_CLASS = 'selectable-tables-parity';
/** On a block's hidden first and last rows, which only count for a theme's rules for a table's first and last rows. */
const EDGE_CLASS = 'selectable-tables-edge';

/** On a header cell holding a freeze mark: styles.css has it drop the space beside the mark. */
const MARK_CELL_CLASS = 'selectable-tables-mark-cell';

let ids = 0;

/** For the check script only: puts each row's estimated height off by up to this fraction, to test the corrections. */
let skew = 0;
export function skewEstimates(fraction: number): void {
	skew = fraction;
}
const skewed = (height: number, row: number) => (skew ? height * (1 + skew * Math.sin(row * 12.9898)) : height);

/** An empty element like `from`, with its attributes, made in `owner` and added to `parent` if given. */
function copyOf<T extends Element>(from: T, owner: Document, parent?: Element): T {
	const copy = owner.createElement(from.localName) as unknown as T;
	for (const { name, value } of Array.from(from.attributes)) copy.setAttribute(name, value);
	parent?.append(copy);
	return copy;
}

/** A cell's box, as Obsidian's own table puts one in each cell. */
function cellBox(owner: Document): HTMLDivElement {
	const box = owner.createElement('div');
	box.className = 'table-cell-wrapper';
	return box;
}

/** A spacer row: one cell across the table. */
function spacer(...classes: string[]): HTMLTableRowElement {
	// Only room for rows not drawn, so screen readers skip it: the rows' own numbers say where each one is.
	const tr = createEl('tr', { cls: [SPACER_CLASS, ...classes], attr: { 'aria-hidden': 'true' } });
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

/** What part of the table is on screen, and the block CodeMirror keeps still as heights change, or -1. */
interface Window extends Visible {
	anchorBlock: number;
}

/**
 * One block of a table, as CodeMirror holds it: a table of its own, with the same columns as the others. Block 0
 * holds the header. Its body holds the block's rows near the pane, with spacers for the rest, and hidden rows for
 * a theme's rules on a table's first and last rows and on odd and even rows.
 */
interface Block {
	readonly index: number;
	readonly dom: HTMLElement;
	readonly table: HTMLTableElement;
	readonly colgroup: HTMLTableColElement;
	readonly thead: HTMLTableSectionElement | null;
	readonly tbody: HTMLTableSectionElement;
	readonly lead: HTMLTableRowElement;
	readonly above: HTMLTableRowElement;
	readonly parity: HTMLTableRowElement;
	readonly below: HTMLTableRowElement;
	readonly tail: HTMLTableRowElement;
	/** The widths and columns on the page, to tell when the shape's differ. */
	applied: string;
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
	/** Counts the shapes worked out from the whole text, so the blocks' decorations can tell their heights are old. */
	private generation = 0;
	/** The shape the blocks' decorations were made with, which gave CodeMirror their estimated heights. */
	decoratedShape = -1;

	// The page.
	/** The blocks built, by index, kept while the table lives, as CodeMirror puts them in the page and takes them out. */
	private readonly blocks: (Block | undefined)[] = [];
	private selected = false;
	/** How far the table is scrolled sideways, which the box around its blocks takes back when CodeMirror makes it anew. */
	private scrollX = 0;
	private sideBox: HTMLElement | null = null;
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

	/** How many blocks the table is drawn as. */
	get blockCount(): number {
		return blockCount(this.count);
	}

	/** Whether any of the table's blocks is in the page now. */
	get shown(): boolean {
		return this.blocks.some((block) => block?.dom.isConnected);
	}

	/** The blocks' elements built so far, by block, for the check script. */
	get boxes(): HTMLElement[] {
		return this.blocks.flatMap((block) => (block ? [block.dom] : []));
	}

	/** Tints the table as selected whole, or takes the tint off. */
	setSelected(on: boolean): void {
		this.selected = on;
		for (const block of this.blocks) block?.dom.toggleClass('is-selected', on);
	}

	destroy(): void {
		this.component.unload();
		this.sideBox?.removeEventListener('scroll', this.onSideways);
		this.sideBox = null;
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

	/** Which shape the table has, or 0 for none yet. */
	get shapeId(): number {
		return this.shaped ? this.generation : 0;
	}

	/** A block's height, with the box's padding above the first and below the last, as estimated. */
	blockHeight(block: number): number {
		const padTop = this.metrics?.padTop ?? 0;
		return blockHeight(this.heights, block, this.headHeight, padTop, (this.metrics?.pad ?? 0) - padTop);
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
		this.generation++;
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

	/** A block's element for CodeMirror, built the first time and kept. Without sizes yet, its rows come later. */
	mount(view: EditorView, metrics: Metrics | null, block: number): HTMLElement {
		return timed('mount', () => this.mountNow(view, metrics, block));
	}

	private mountNow(view: EditorView, metrics: Metrics | null, index: number): HTMLElement {
		this.view = view;
		this.ensureShape(view.state.doc, metrics);
		const block = this.blocks[index] ?? this.build(index);
		this.refresh();
		// A block coming into the page may hold rows near the pane that weren't drawn while it was out.
		if (this.blockCount > 1) this.schedule(true);
		return block.dom;
	}

	/** Whether an element is one of this table's blocks, the one at `index`. */
	isBlock(dom: HTMLElement, index: number): boolean {
		return this.blocks[index]?.dom === dom;
	}

	private build(index: number): Block {
		const dom = createDiv({ cls: ['cm-embed-block', 'cm-table-widget', 'markdown-rendered', OWN_CLASS] });
		const table = dom.createDiv('table-wrapper').createEl('table', { cls: 'table-editor' });
		const colgroup = table.createEl('colgroup');
		const thead = index === 0 ? table.createEl('thead') : null;
		const tbody = table.createEl('tbody');
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
		dom.toggleClass('is-selected', this.selected);
		const block: Block = { index, dom, table, colgroup, thead, tbody, lead: spacer(PARITY_CLASS, EDGE_CLASS), above: spacer(), parity: spacer(PARITY_CLASS), below: spacer(), tail: spacer(PARITY_CLASS, EDGE_CLASS), applied: '' };
		this.blocks[index] = block;
		return block;
	}

	/** Puts what changed on the page: new widths, the header, rows whose text changed, then the rows near the pane. */
	refresh(): void {
		const view = this.view;
		if (!view || !this.blocks.some(Boolean) || !this.metrics || this.stale) return;
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

	/** The columns' widths on each block. Fixed widths keep columns still as rows come and go, and blocks lined up. */
	private apply(): void {
		// Collapsed borders belong to the whole table, so every row added would repaint all of it on screen, and a
		// hard flick would outrun that: the cells draw their own instead, as a frozen table's do.
		const own = !!this.metrics?.collapsed;
		// Joined, a column holds half of each line beside it. Drawn by its cells, the first column holds both its lines
		// whole, one line's width more, so it gets that width back and its text has the same room as in Obsidian's.
		const widths = own ? this.widths.map((width, column) => (column === 0 ? width + this.metrics!.border : width)) : this.widths;
		const key = `${this.columns}:${widths.join(',')}`;
		const count = this.blockCount;
		let changed = false;
		for (const [index, block] of this.blocks.entries()) {
			if (!block) continue;
			// A block past the table's end, after rows were taken out: CodeMirror drops it.
			if (index >= count && !block.dom.isConnected) {
				this.blocks[index] = undefined;
				continue;
			}
			block.dom.toggleClass(OWN_BORDERS_CLASS, own);
			block.dom.toggleClass(FIRST_CLASS, index === 0);
			block.dom.toggleClass(LAST_CLASS, index === count - 1);
			if (key === block.applied) continue;
			block.colgroup.empty();
			for (const width of widths) block.colgroup.createEl('col').style.width = `${width}px`;
			block.table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
			for (const row of [block.lead, block.above, block.parity, block.below, block.tail]) (row.firstChild as HTMLTableCellElement).colSpan = Math.max(1, this.columns);
			if (block.applied) changed = true;
			block.applied = key;
		}
		while (this.blocks.length && !this.blocks[this.blocks.length - 1]) this.blocks.pop();
		if (changed) this.schedule(true);
	}

	/**
	 * Each block's body rows in order: a hidden first row after the first block, a spacer for the block's rows above
	 * those drawn, a hidden row when needed to keep each drawn row odd or even as in the whole table, the drawn rows,
	 * a spacer for the rows below, and a hidden last row before the last block. Only what changed moves.
	 */
	private arrange(): void {
		const rows = String(this.count + 1);
		for (const block of this.blocks) {
			if (!block || block.index >= this.blockCount) continue;
			const body = bodyLayout(this.heights, block.index, this.drawn, (row) => this.rendered.has(row));
			const want: HTMLTableRowElement[] = [];
			if (body.lead) want.push(block.lead);
			if (body.above !== null) want.push(block.above);
			if (body.parity) want.push(block.parity);
			// A row an edit added isn't drawn until the next measure: until then, the rows around it close up.
			for (let row = body.rows.first; row < body.rows.end; row++) {
				const tr = this.rendered.get(row);
				if (!tr) continue;
				// Only rows near the pane are in the page, so each says which row of the table it is, the header being 1.
				const index = String(row + 2);
				if (tr.getAttribute('aria-rowindex') !== index) tr.setAttribute('aria-rowindex', index);
				want.push(tr);
			}
			if (body.below !== null) want.push(block.below);
			if (body.tail) want.push(block.tail);
			if (block.table.getAttribute('aria-rowcount') !== rows) block.table.setAttribute('aria-rowcount', rows);
			const height = (row: HTMLTableRowElement, px: number | null) => {
				const cell = row.firstChild as HTMLTableCellElement;
				const value = `${Math.max(0, px ?? 0)}px`;
				if (cell.style.height !== value) cell.style.height = value;
			};
			height(block.above, body.above);
			height(block.below, body.below);
			const keep = new Set<Node>(want);
			for (let node = block.tbody.firstChild; node; ) {
				const next = node.nextSibling;
				if (!keep.has(node)) node.remove();
				node = next;
			}
			let at = block.tbody.firstChild;
			for (const row of want) {
				if (row === at) at = at.nextSibling;
				else block.tbody.insertBefore(row, at);
			}
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
		// Obsidian's renderer reads each cell's text direction with a node iterator rooted at the cell, and a document
		// keeps every iterator until a garbage collection, checking each one whenever a node in it is moved or taken
		// out. An iterator also follows its cell into another document. So rows rendered in the page, or moved into it
		// whole, piled thousands of iterators onto the page during a fast scroll, and every change there got slower,
		// the plugin's and Obsidian's alike: a batch of rows took 50 ms to put in place, then 300 (STA-86). Each batch
		// renders in a document of its own, and only the cells' contents move into cells made here, in the page's
		// document, with the rendered cells' attributes. The rendered cells and their iterators stay behind.
		const scratch = activeDocument.implementation.createHTMLDocument('');
		const holder = scratch.createElement('div');
		// The rows' embeds and post-processors' children, kept until the last of these rows leaves.
		const batch: Batch = { component: new Component(), rows: 0 };
		this.component.addChild(batch.component);
		void MarkdownRenderer.render(this.app, markdownOf(header, rows, this.columns, this.aligns), holder, path, batch.component);
		const page = view.dom.ownerDocument;
		const out: HTMLTableRowElement[] = [];
		for (const rendered of Array.from(holder.querySelector('table')?.rows ?? [])) {
			const tr = copyOf(rendered, page);
			for (const cell of Array.from(rendered.cells)) {
				const box = cellBox(page);
				box.append(...Array.from(cell.childNodes));
				copyOf(cell, page, tr).append(box);
			}
			while (tr.cells.length < this.columns) tr.insertCell().append(cellBox(page));
			this.batchOf.set(tr, batch);
			batch.rows++;
			out.push(tr);
		}
		if (!batch.rows) this.component.removeChild(batch.component);
		// A link to a note that doesn't exist looks as Obsidian draws it.
		for (const tr of out) {
			for (const link of Array.from(tr.querySelectorAll<HTMLElement>('a.internal-link'))) {
				const href = link.getAttribute('data-href') ?? link.getAttribute('href');
				if (href) link.toggleClass('is-unresolved', !this.app.metadataCache.getFirstLinkpathDest(getLinkpath(href), path));
			}
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
		const thead = this.blocks[0]?.thead;
		const view = this.view;
		if (!thead || !view) return;
		const text = view.state.doc.lineAt(this.from).text;
		const [row] = this.render([]);
		for (const column of markedCells(text)) row?.cells[column]?.addClass(MARK_CELL_CLASS);
		row?.setAttribute('aria-rowindex', '1');
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

	/**
	 * What part of the body is on screen, from any block in the page, and which block CodeMirror keeps still when
	 * heights change: the block its scroll anchor is on, picked as CodeMirror picks it, from its own heights.
	 */
	private visible(): Window | null {
		const view = this.view;
		const block = this.blocks.find((each) => each?.dom.isConnected);
		if (!view || !block) return null;
		const scroller = view.scrollDOM;
		const pane = scroller.getBoundingClientRect().top;
		// Where body row 0 starts on the page: a block's body starts at its first row.
		const body = block.tbody.getBoundingClientRect().top - this.heights.top(blockRows(this.count, block.index).first);
		const scrollTop = scroller.scrollTop * view.scaleY;
		let line = view.lineBlockAtHeight(scrollTop + 8);
		const first = view.viewportLineBlocks[0];
		if (first && line.from < view.viewport.from && first.top - scrollTop <= 200) line = first;
		const anchorBlock = line.from >= this.from && line.from <= this.to ? blockSpans(view.state.doc, this).findIndex((span) => span.from === line.from) : -1;
		return { top: pane - body, bottom: pane + scroller.clientHeight - body, anchorBlock };
	}

	/** Whether a block is in the page, so rows can be drawn in it. */
	private inPage(index: number): boolean {
		return !!this.blocks[index]?.dom.isConnected;
	}

	/**
	 * Draws the rows within OVER px of the pane, unless those drawn already reach MARGIN past it: only rows in blocks
	 * CodeMirror has put in the page, since the others have nowhere to go yet. They're drawn when their block comes in.
	 */
	private draw(visible: Window | null, force: boolean): void {
		const view = this.view;
		if (!visible || !view || this.stale) return;
		this.placeBox(null);
		const whole = this.count <= WHOLE;
		if (!force && !this.dirty.size && (whole ? this.drawn.first === 0 && this.drawn.end === this.count : covers(this.heights, this.drawn, visible, MARGIN))) return;
		const { first, end } = whole ? { first: 0, end: this.count } : wanted(this.heights, visible, OVER);
		// The row at the pane's top stays still while rows above it take their real heights. CodeMirror keeps the top
		// of the block it anchors on still, and moves the note for any change in the blocks above it, so the anchor is
		// kept in that block: by the estimates alone, near a seam, it could fall in the block above, and both would move
		// the note for the same rows (STA-74). With CodeMirror's anchor outside the table, CodeMirror moves the note.
		let anchor = visible.anchorBlock >= 0 && visible.top > 0 && visible.top < this.heights.total() ? this.heights.rowAt(visible.top) : -1;
		if (anchor >= 0) {
			const range = blockRows(this.count, visible.anchorBlock);
			anchor = range.end > range.first ? Math.max(range.first, Math.min(range.end - 1, anchor)) : -1;
		}
		const anchorTop = anchor >= 0 ? topInBlock(this.heights, anchor, this.headHeight) : 0;
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
		for (let row = first; row < end; row++) if (!this.rendered.has(row) && this.inPage(blockOf(this.count, row))) need.push(row);
		const fresh = this.renderRows(need);
		need.forEach((row, i) => this.rendered.set(row, fresh[i]!));
		this.drawn = { first, end };
		this.arrange();
		if (need.length || force) view.requestMeasure({ key: this.heightKey, read: () => timed('measure', () => this.readHeights()), write: (measured) => timed('draw', () => this.fixHeights(measured, anchor, anchorTop)) });
	}

	private readHeights(): Measured {
		const rows: [number, number][] = [];
		for (const [row, tr] of this.rendered) if (tr.isConnected) rows.push([row, tr.getBoundingClientRect().height]);
		const thead = this.blocks[0]?.thead;
		const head = thead?.isConnected ? (thead.firstElementChild?.getBoundingClientRect().height ?? 0) : 0;
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
			const delta = topInBlock(this.heights, anchor, this.headHeight) - anchorTop;
			if (Math.abs(delta) > 0.01) view.scrollDOM.scrollTop += delta;
		}
	}

	/**
	 * The box CodeMirror puts around a table's blocks scrolls them sideways together, as Obsidian's table box does. It
	 * makes the box anew whenever the first block it draws changes, and a new box, or one it moved, starts at the
	 * table's left edge: that one is put back where the table was. The box already there keeps its own place, which a
	 * swipe or a cell brought into view gave it. `added` is a box CodeMirror has just put in the page; with null, the
	 * box the blocks are in now.
	 */
	placeBox(added: HTMLElement | null): void {
		if (this.blockCount < 2) return;
		const box = added ?? this.blocks.find((block) => block?.dom.isConnected)?.dom.parentElement ?? null;
		if (!box?.hasClass(BOX_CLASS)) return;
		if (!added && box === this.sideBox) return;
		if (box !== this.sideBox) {
			this.sideBox?.removeEventListener('scroll', this.onSideways);
			this.sideBox = box;
			box.addEventListener('scroll', this.onSideways, { passive: true });
		}
		if (Math.abs(box.scrollLeft - this.scrollX) > 0.5) box.scrollLeft = this.scrollX;
	}

	private readonly onSideways = () => {
		if (this.sideBox) this.scrollX = this.sideBox.scrollLeft;
	};

	/**
	 * Where a place in a block's text is drawn, `offset` from the block's start. Without this CodeMirror scrolls the
	 * whole block into view for a place in it, which for a block taller than the pane is its end. A row not drawn yet
	 * takes its place from its estimated height.
	 */
	coordsAt(index: number, offset: number): Rect | null {
		const view = this.view;
		const block = this.blocks[index];
		if (!view || !block?.table.isConnected) return null;
		const doc = view.state.doc;
		const start = index === 0 ? this.from : (blockSpans(doc, this)[index]?.from ?? this.from);
		const line = doc.lineAt(Math.min(doc.length, start + offset));
		const lineIndex = line.number - doc.lineAt(this.from).number;
		const table = block.table.getBoundingClientRect();
		let tr: HTMLTableRowElement | null | undefined;
		let top: number;
		let bottom: number;
		if (lineIndex <= 1) {
			tr = block.thead?.firstElementChild as HTMLTableRowElement | null;
			const rect = tr?.getBoundingClientRect();
			top = rect?.top ?? table.top;
			bottom = rect?.bottom ?? table.top + this.headHeight;
		} else {
			const row = Math.min(this.count - 1, lineIndex - 2);
			tr = this.rendered.get(row);
			if (tr?.isConnected) {
				const rect = tr.getBoundingClientRect();
				top = rect.top;
				bottom = rect.bottom;
			} else {
				top = block.tbody.getBoundingClientRect().top + this.heights.top(row) - this.heights.top(blockRows(this.count, index).first);
				bottom = top + this.heights.get(row);
			}
		}
		let { left, right } = table;
		if (tr?.isConnected && lineIndex !== 1) {
			const cell = tr.cells[Math.min(columnAt(line.text, start + offset - line.from), tr.cells.length - 1)];
			if (cell) ({ left, right } = cell.getBoundingClientRect());
		}
		return { left, right, top, bottom };
	}
}
