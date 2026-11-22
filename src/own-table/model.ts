import type { ChangeSet, Text } from '@codemirror/state';
import type { EditorView, Rect } from '@codemirror/view';
import { type App, Component, editorInfoField, getLinkpath, MarkdownRenderer } from 'obsidian';
import { CELL_CLASS, HOLDS_CELL_CLASS } from '../editor/cells';
import type { Grid } from '../editor/decide';
import { OWN_BORDERS_CLASS } from '../editor/freeze';
import { markedCells } from '../editor/freeze-mark';
import { type DrawnTable, openCells } from '../editor/layout';
import { type Cell, rowCells, type Span } from '../editor/table-text';
import { fitColumns, measureCell, type Metrics, rowHeight, type Words } from './estimate';
import { Bar, SLIDE_VARIABLE, SLIDES_CLASS, TIMELINE_VARIABLE, usesBars } from './bar';
import { blockCount, blockHeight, blockOf, blockRows, blockSpans, bodyLayout, topInBlock } from './blocks';
import { BOX_CLASS, BOX_ID } from './boxes';
import { covers, Heights, type RowRange, type Visible, wanted } from './heights';
import { measure, measureContent } from './metrics';
import { timed } from './profile';
import { type LineMatch, type Match, MATCH_SELECTOR, matchSpans, paintMatches } from './matches';
import { barPlace, type BarPlace, clampSlide, maxSlide, revealDelta } from './sideways';
import { type PinHost, Pins, ROW_ATTRIBUTE } from './pins';
import { showDown } from './pin-sums';
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

/** What draws with a size the text can't tell: pictures and players. */
const MEDIA = 'img, video, audio, iframe';
/** Whether a picture or player has its size yet: a picture once it has loaded, a video once it knows its size. */
function sized(el: Element): boolean {
	if (el.instanceOf(HTMLImageElement)) return el.complete && el.naturalWidth > 0;
	if (el.instanceOf(HTMLVideoElement)) return el.readyState >= 1;
	return true;
}
/** The cells in some rows that hold a picture or a player. */
function mediaCells(rows: Iterable<HTMLTableRowElement>): HTMLTableCellElement[] {
	const cells = new Set<HTMLTableCellElement>();
	for (const tr of rows) {
		for (const el of Array.from(tr.querySelectorAll(MEDIA))) {
			const cell = el.closest('td, th');
			if (cell?.instanceOf(HTMLTableCellElement)) cells.add(cell);
		}
	}
	return [...cells];
}

/** A press on a cell: where it landed, and how many of the cell's drawn characters come before that place. */
export interface Click {
	x: number;
	y: number;
	visible: number | null;
}

type Caret = { offsetNode: Node; offset: number } | null;

/**
 * How many characters of a cell's drawn text, a `<br>` counting as one, come before the place a press landed, so the
 * open cell's caret can go to the same place in its own drawn text, where Live Preview hides the Markdown the same way.
 */
function visibleAt(td: HTMLTableCellElement, x: number, y: number): number | null {
	const doc = td.ownerDocument;
	const root = td.querySelector(':scope > .table-cell-wrapper') ?? td;
	let at: Caret = (doc as unknown as { caretPositionFromPoint?: (x: number, y: number) => Caret }).caretPositionFromPoint?.(x, y) ?? null;
	if (!at) {
		const range = (doc as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y);
		at = range ? { offsetNode: range.startContainer, offset: range.startOffset } : null;
	}
	if (!at || !root.contains(at.offsetNode)) return null;
	const range = doc.createRange();
	range.setStart(root, 0);
	range.setEnd(at.offsetNode, at.offset);
	return range.toString().length + range.cloneContents().querySelectorAll('br').length;
}

/** A table line without its padding: no spaces beside its pipes, and runs of spaces as one. */
const unpadded = (line: string) => line.replace(/ *\| */g, '|').replace(/ {2,}/g, ' ').trim();

/** Whether two lines of a table have the same cells, padding aside, but for one column, -1 for none. */
function sameCells(a: string, b: string, columns: number, except: number): boolean {
	const before = cellsOf(a, columns);
	const after = cellsOf(b, columns);
	return before.every((cell, column) => column === except || cell === after[column]);
}

/** How narrow and wide a cell's content can be, measured. */
interface Size {
	min: number;
	max: number;
}

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

/** A cell's box, as Obsidian's own table puts one in each cell. An empty one holds a line break, as Obsidian's does. */
function cellBox(owner: Document, content: Node[] = []): HTMLDivElement {
	const box = owner.createElement('div');
	box.className = 'table-cell-wrapper';
	if (content.length) box.append(...content);
	else box.append(owner.createElement('br'));
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
	/** Between the open cell's row and the rows drawn, while it's kept far from them. */
	readonly gap: HTMLTableRowElement;
	readonly tail: HTMLTableRowElement;
	/** The widths and columns on the page, to tell when the shape's differ. */
	applied: string;
	/** How the block follows its table's scrollbar, as last written: to tell when that changes. */
	dressed: string;
}

/** What placing a table's scrollbar reads from the page. */
interface BarRead {
	/** Whether the editor's wide tables move by a scrollbar, not in a box that scrolls. */
	bars: boolean;
	/** How far the table can move sideways: 0 for one no wider than its box. */
	slide: number;
	place?: BarPlace;
	left: number;
	width: number;
	height: number;
}

/** A scrollbar's least height, where a theme pads a table's box less: room for a Mac's bar when it's always shown. */
const BAR_HEIGHT = 12;

/**
 * How much of the pane's bottom the status bar hides, where it floats over the pane, beside the table's box: none in
 * a pane above another, or in a window with no status bar.
 */
function statusInset(scroller: HTMLElement, pane: DOMRect, box: DOMRect): number {
	const bottom = pane.top + scroller.clientTop + scroller.clientHeight;
	const status = scroller.ownerDocument.querySelector('.status-bar');
	if (!status) return 0;
	const rect = status.getBoundingClientRect();
	if (!rect.height || rect.top >= bottom || rect.bottom < bottom - 1 || rect.right <= box.left || rect.left >= box.right) return 0;
	return bottom - rect.top;
}

/**
 * One table in one editor, drawn by the plugin: the note's text decides what it shows, and only the rows near the
 * pane are in the page, with spacers standing in for the rest. It lives as long as the table does, across changes
 * to the note, and its DOM is kept while it lives, so CodeMirror can put it back when the table scrolls into view.
 */
/** What showing a cell reads from the page: the cell, the pane, and how much of the pane's bottom the status bar hides. */
/** What an open cell's caret has to stay clear of: the pinned rows' bottom on the screen, and the strip's room. */
export interface CaretRoom {
	under: number | null;
	sideways: boolean;
	clear: number;
}

interface ShowRead {
	cell: DOMRect;
	/** The cell's scroll margin above and below it, as `scrollIntoView` keeps it. */
	margin: number;
	/** Its scroll margins at its left and right, so a cell at a row's end takes the table back to its edge. */
	side: { left: number; right: number };
	top: number;
	bottom: number;
	/** How far down from the pane's top the frozen rows cover, for a cell that passes under them. */
	under: number;
	/** How far in from the box's start the frozen columns cover, for a cell that passes under them. */
	clear: number;
	/** Whether the cell is pinned down the note, or sideways: then it's always in view that way. */
	pinned: { rows: boolean; columns: boolean };
	/** For a key that went up into a frozen row: where the table's top is, to take it back there. */
	tableTop: number | null;
	/** The cell's real row pins itself at the pane's top from the next frame: it's in view down the note. */
	stuck: boolean;
}

export class Model implements Span, DrawnTable {
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
	/**
	 * On a computer, the table's scrollbar, while it's wider than its box: its scroll is how far the table is moved
	 * sideways, and outlives the table leaving the pane, since the bar sits in the note's scroller.
	 */
	private bar: Bar | null = null;
	/** How far the table moves sideways at its bar's end. */
	private slide = 0;
	private readonly barKey = {};
	private readonly rendered = new Map<number, HTMLTableRowElement>();
	private readonly spare = new Map<number, HTMLTableRowElement>();
	/** The text each drawn row was drawn from. */
	private readonly drawnFrom = new WeakMap<HTMLTableRowElement, string>();
	/** The batch each rendered row came from, unloaded once none of its rows is kept. */
	private readonly batchOf = new WeakMap<HTMLTableRowElement, Batch>();
	private headText: string | null = null;
	/**
	 * The table's direction, from its header's first cell, as Obsidian sets it on its table's box: a table whose first
	 * cell reads right to left runs right to left, its first column at the right.
	 */
	private dir = '';
	private drawn: RowRange = { first: 0, end: 0 };
	private readonly dirty = new Set<number>();
	private checkRows = false;
	/** Something changed that the page doesn't show yet. */
	private todo = true;
	/** The rows' heights are estimates again, and the drawn rows are to be measured. */
	private remeasure = false;
	private pending = false;
	private force = false;
	/**
	 * Cells holding a picture or a player, measured once it had its size, by their Markdown, a header cell's apart:
	 * the text alone can't say how wide they draw. Forgotten when the sizes change, and measured again.
	 */
	private readonly media = new Map<string, Size>();
	/** Cells to measure for their pictures and players, on the next measure. */
	private readonly mediaCells = new Set<HTMLTableCellElement>();
	/** The drawn rows' pictures and players are to be measured again, after the sizes changed. */
	private rescanMedia = false;
	private readonly mediaKey = {};
	private readonly drawKey = {};
	private readonly heightKey = {};
	private readonly showKey = {};
	private readonly matchKey = {};

	// The navigation layer's marks.
	/** The selected cell, row 0 being the header, drawn whenever its row is drawn. */
	private cell: Cell | null = null;
	private cellEl: HTMLTableCellElement | null = null;
	/** A cell to bring into view once its row is drawn. */
	private showing: Cell | null = null;
	/** The way the key that's showing a cell went, toward the table's start, if it did. */
	private toward: 'up' | 'left' | null = null;
	/** Find's matches and the Search pane's in the table, by body row, the header being -1, in their lines. */
	private matches = new Map<number, LineMatch[]>();
	/** The first match, to bring into view sideways once its row is drawn. */
	private revealMatch = false;
	/** Whether rows may hold matches drawn before, which a row kept out of the page brings back. */
	private painted = false;

	// The open cell.
	/** The row of the open cell, kept in the page however far the note scrolls from it, and its column. */
	private openRow: HTMLTableRowElement | null = null;
	private openColumn = -1;
	/** A cell to open once its row is drawn. */
	private toOpen: { cell: Cell; run: () => void } | null = null;

	// Frozen rows and columns, on a computer.
	private readonly pins = new Pins(this.pinHost());

	constructor(
		private readonly app: App,
		public from: number,
		public to: number,
		/** Selects the table whole. */
		private readonly select: (model: Model) => void,
		/** Opens a cell for editing, at a click in it, or at its text's end. */
		private readonly open: (model: Model, cell: Cell, at: Click | null) => void,
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

	// The selected cell and Find ---------------------------------------------------------------------------------

	/** The table's rows and cells for the keys, the header being row 0: every row has every column, as drawn. */
	get grid(): Grid {
		const columns = this.columns;
		return { rows: this.count + 1, columns: () => columns };
	}

	markCell(cell: Cell | null): void {
		this.cell = cell;
		if (!cell) this.showing = null;
		for (const block of this.blocks) block?.table.toggleClass(HOLDS_CELL_CLASS, !!cell);
		this.pins.holdCell(!!cell);
		this.pins.markCell(cell);
		this.paintCell();
	}

	/**
	 * After a freeze command's write, or Undo or Redo, the selected cell is shown once the new freeze is drawn: an
	 * unfrozen cell goes back to its place in the table, which can be above the pane or off to its left.
	 */
	showCellAfterFreeze(): void {
		const cell = this.cell;
		if (!cell) return;
		this.pins.afterPlacing(() => this.cell === cell && this.showCell(cell));
		// Undo and Redo scroll the note to the whole table after that, once CodeMirror measures it, a few frames on: the
		// cell is shown again right after that scroll (`afterScroll`).
		this.againAfterScroll = { cell, until: performance.now() + 500 };
	}

	private againAfterScroll: { cell: Cell; until: number } | null = null;

	/** CodeMirror is scrolling a range into view: a cell waiting for Undo's or Redo's scroll is shown after it. */
	afterScroll(): void {
		const again = this.againAfterScroll;
		const view = this.view;
		this.againAfterScroll = null;
		if (!again || !view || again.until < performance.now() || this.cell !== again.cell) return;
		// The handler runs before the scroll: the cell is shown on the measure's next pass, once the scroll has run.
		view.requestMeasure({ key: this.afterScrollKey, read: () => null, write: () => this.cell === again.cell && this.showCell(again.cell) });
	}

	private readonly afterScrollKey = {};

	/** Opens a cell for editing, with the caret at the end of its text: Enter on the selected cell. */
	openCell(cell: Cell): void {
		this.open(this, cell, null);
	}

	/** A cell's element, if its row is drawn: row 0 is the header. */
	cellElement({ row, column }: Cell): HTMLTableCellElement | null {
		const tr = row === 0 ? this.blocks[0]?.thead?.firstElementChild : this.rendered.get(row - 1);
		return tr?.instanceOf(HTMLTableRowElement) ? (tr.cells[column] ?? null) : null;
	}

	/** Puts the selected cell's mark on its element, as its row comes and goes. */
	private paintCell(): void {
		const el = this.cell ? this.cellElement(this.cell) : null;
		if (el === this.cellEl) return;
		this.cellEl?.removeClass(CELL_CLASS);
		el?.addClass(CELL_CLASS);
		this.cellEl = el;
	}

	/** The cell an element of the table's blocks is in, a pinned copy's being its real cell; null outside its cells. */
	cellAt(target: Element): Cell | null {
		const el = target.closest('td, th');
		return el?.instanceOf(HTMLTableCellElement) && this.blocks.some((block) => block?.dom.contains(el)) ? this.cellOf(el) : null;
	}

	/** The cell a drawn cell element is, or null for a filler row's. */
	private cellOf(el: HTMLTableCellElement): Cell | null {
		const tr = el.parentElement;
		if (!tr?.instanceOf(HTMLTableRowElement)) return null;
		// A copy of the frozen rows, or of a row's frozen cells in the strip beside the table: its real cell.
		const copied = tr.getAttribute(ROW_ATTRIBUTE);
		if (copied !== null) return { row: Number(copied), column: el.cellIndex };
		const real = this.pins.realRow(tr)?.cells[el.cellIndex];
		if (real) return this.cellOf(real);
		if (tr === this.blocks[0]?.thead?.firstElementChild) return { row: 0, column: el.cellIndex };
		for (const [row, drawn] of this.rendered) if (drawn === tr) return { row: row + 1, column: el.cellIndex };
		return null;
	}

	/**
	 * Runs `run` once a cell's row is drawn, bringing the real row into view: a cell to open that isn't drawn yet, such as
	 * one of the pinned rows pressed deep in a table of more blocks, whose real row is at the table's top.
	 */
	whenDrawn(cell: Cell, run: () => void): void {
		this.toOpen = { cell, run };
		this.showing = cell;
		this.toward = null;
		this.showReal = true;
		if (!this.cellElement(cell)?.isConnected) this.scrollToEstimate(cell.row - 1);
		this.requestShow();
	}

	/** Whether the cell showing is shown as its real cell, not where it's pinned: a cell about to open. */
	private showReal = false;

	/**
	 * Keeps the open cell's row in the page while it's open, however far the note scrolls, so typing still reaches its
	 * editor: CodeMirror keeps the block holding the note's selection in the page, and the selection follows the cell's
	 * caret. Its other cells are drawn again in place as they change. Closed, the row is drawn again whole.
	 */
	holdOpen(tr: HTMLTableRowElement | null, column: number): void {
		const was = this.rowOfOpen();
		const wasRow = this.openRow;
		this.openRow = tr;
		this.openColumn = column;
		const row = tr ? this.rowOfOpen() : null;
		this.pins.openCell(tr, row === null ? null : { row, column });
		// A cell in a frozen row and a frozen column opens with the table at its start (`holdsStart` in pins.ts).
		if (tr && this.pins.holdsStart) this.slideToStart();
		if (tr || was === null) return;
		// The cell that closed still shows its text from before it opened, so the row is drawn again, in place if another
		// of its cells opens before then.
		if (wasRow) this.drawnFrom.delete(wasRow);
		if (was === 0) this.headText = null;
		else this.dirty.add(was - 1);
		this.todo = true;
		this.refresh();
		this.schedule(true);
	}

	/** Whether the open cell's element is still in its row, and that row still one of the table's. */
	holdsOpen(el: HTMLTableCellElement): boolean {
		return !!this.openRow && this.openRow.cells[this.openColumn] === el && this.rowOfOpen() !== null;
	}

	/** The open cell's row, 0 being the header, or null. */
	rowOfOpen(): number | null {
		const tr = this.openRow;
		if (!tr) return null;
		if (tr === this.blocks[0]?.thead?.firstElementChild) return 0;
		for (const [row, drawn] of this.rendered) if (drawn === tr) return row + 1;
		return null;
	}

	/** The open cell's editor changed its height: the rows are measured again, and what pins is placed again. */
	cellResized(): void {
		this.schedule(true);
		this.pins.measure();
	}

	/**
	 * Brings a cell into view, just far enough, as `nearest` does: down the note, and sideways through the table's
	 * scrollbar or box. A row that isn't drawn, such as row 2,000 after Cmd+↓, is scrolled to from its estimated place,
	 * which the scroll's own measure draws, and the cell is then shown from where it's really drawn, before the frame is
	 * painted. The note's scroll, not the cell's own `scrollIntoView`, which would scroll the box that clips the table.
	 */
	showCell(cell: Cell, toward?: 'up' | 'left'): void {
		const view = this.view;
		if (!view) return;
		this.showing = cell;
		this.toward = toward ?? null;
		this.showReal = false;
		// A cell of the pinned rows is shown where they're pinned, so it needn't be drawn, unless a key goes up into
		// them, which takes the table back to its top.
		const pinnedRow = cell.row < this.pins.room.rows;
		if (toward === 'up' && pinnedRow && !this.cellElement(cell)?.isConnected) this.scrollToEstimate(-1);
		else if ((!pinnedRow || !this.shown) && !this.cellElement(cell)?.isConnected) this.scrollToEstimate(cell.row - 1);
		this.requestShow();
	}

	/** Moves the table sideways back to its start, for a key that went left into a frozen column. */
	slideToStart(): void {
		if (this.bar) this.bar.scroll = 0;
		else {
			const box = this.boxNow();
			if (box) box.scrollLeft = 0;
		}
	}

	/**
	 * Keeps an open cell's caret in view, sideways and clear of what's pinned: its editor scrolls the note to the caret
	 * itself, and takes a caret under the pinned rows for one in view. Runs in a measure's write, with the caret's place.
	 */
	showCaret(cell: Cell, caret: Rect, room: CaretRoom): void {
		const view = this.view;
		if (!view) return;
		if (room.under !== null && caret.top < room.under) view.scrollDOM.scrollTop -= room.under - caret.top;
		// A frozen column's cell stays where the strip is, so its caret is always in view sideways.
		if (room.sideways) this.showSideways(caret.left - 4, caret.right + 4, room.clear);
	}

	/** What an open cell's caret has to stay clear of, read in a measure's read: the pinned rows' bottom, and the strip. */
	caretRoom(cell: Cell): CaretRoom {
		const view = this.view;
		const room = this.pins.room;
		const scroller = view?.scrollDOM;
		const under = scroller && room.rows && cell.row >= room.rows ? scroller.getBoundingClientRect().top + scroller.clientTop + room.height + 4 : null;
		const sideways = cell.column >= room.columns;
		return { under, sideways, clear: sideways && room.columns ? this.stripClear() : 0 };
	}

	/** How far in from the table's box the strip of frozen columns covers, read from the page. */
	private stripClear(): number {
		const box = this.boxNow();
		const rtl = this.dir === 'rtl';
		const edge = box ? this.pins.stripEdge(rtl) : null;
		if (!box || edge === null) return 0;
		const rect = box.getBoundingClientRect();
		const start = rect.left + box.clientLeft;
		return Math.max(0, rtl ? start + box.clientWidth - edge : edge - start);
	}

	/** Scrolls the note so a row, -1 for the header, is in the pane by its estimated place, before it's drawn. */
	private scrollToEstimate(row: number): void {
		const view = this.view;
		if (!view || this.stale) return;
		const index = row < 0 ? 0 : blockOf(this.count, row);
		const span = blockSpans(view.state.doc, this)[index];
		if (!span) return;
		const scroller = view.scrollDOM;
		const docTop = view.documentTop - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
		const top = docTop + view.lineBlockAt(span.from).top + (index === 0 ? (this.metrics?.padTop ?? 0) : 0) + (row < 0 ? 0 : topInBlock(this.heights, row, this.headHeight));
		const bottom = top + (row < 0 ? this.headHeight : this.heights.get(row));
		const margin = 16;
		if (top - margin < scroller.scrollTop) scroller.scrollTop = top - margin;
		else if (bottom + margin > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom + margin - scroller.clientHeight;
	}

	/** Shows the cell waiting to be shown, on the next measure, once its row is drawn and measured. */
	private requestShow(): void {
		const view = this.view;
		if (!view || !this.showing) return;
		view.requestMeasure({ key: this.showKey, read: () => timed('measure', () => this.readShow()), write: (read) => timed('draw', () => this.writeShow(read)) });
	}

	/**
	 * Where the cell to show is, and what covers the cells that pass under what's pinned. A pinned cell is measured where
	 * it's drawn on top: a copy in the strip, or in the frozen rows' copy of the block crossing the pane's top.
	 */
	private readShow(): ShowRead | null {
		const view = this.view;
		const cell = this.showing;
		if (!view || !cell) return null;
		const scroller = view.scrollDOM;
		const pane = scroller.getBoundingClientRect();
		const top = pane.top + scroller.clientTop;
		const room = this.pins.room;
		const pinned = this.showReal ? null : this.pins.pinnedCell(cell, top);
		const real = this.cellElement(cell);
		const el = (this.toward !== 'up' && pinned?.el?.isConnected ? pinned.el : null) ?? (real?.isConnected ? real : null);
		if (!el) return null;
		const rect = el.getBoundingClientRect();
		const bottom = top + scroller.clientHeight - statusInset(scroller, pane, rect);
		const style = getComputedStyle(el);
		const side = { left: parseFloat(style.scrollMarginLeft) || 0, right: parseFloat(style.scrollMarginRight) || 0 };
		const first = this.blocks[0]?.table;
		const tableTop = this.toward === 'up' && pinned?.rows && first?.isConnected ? first.getBoundingClientRect().top : null;
		return {
			cell: rect,
			margin: parseFloat(style.scrollMarginTop) || 0,
			side,
			top,
			bottom,
			under: room.rows && cell.row >= room.rows ? room.height : 0,
			clear: room.columns && cell.column >= room.columns ? this.stripClear() : 0,
			// A cell about to open in a frozen column opens where the strip is: the table stays where it is sideways.
			pinned: { rows: !!pinned?.rows, columns: !!pinned?.columns || (this.showReal && cell.column < room.columns) },
			stuck: !!pinned?.stuck,
			tableTop,
		};
	}

	private writeShow(read: ShowRead | null): void {
		const view = this.view;
		if (!view || !read) return;
		const toward = this.toward;
		this.showing = null;
		this.toward = null;
		this.showReal = false;
		const { cell, side, pinned } = read;
		const down = read.stuck && read.tableTop === null ? 0 : showDown({ ...read, cellTop: cell.top, cellBottom: cell.bottom, pinned: pinned.rows });
		if (down) view.scrollDOM.scrollTop += down;
		// Sideways the same: a cell in a frozen column is always in view, and a key that went left into one takes the table
		// back to its start.
		if (pinned.columns) {
			if (toward === 'left') this.slideToStart();
		} else this.showSideways(cell.left - side.left, cell.right + side.right, read.clear);
	}

	/**
	 * Find's matches in the table, and the Search pane's, from the decorations Obsidian lays over the note's text, which
	 * the table's blocks hide: they're drawn in their cells instead, as the rows holding them are drawn.
	 */
	setMatches(matches: readonly Match[], doc: Text): void {
		const byRow = matchSpans(matches, doc, this);
		const same = byRow.size === this.matches.size && [...byRow].every(([row, list]) => JSON.stringify(list) === JSON.stringify(this.matches.get(row)));
		if (same) return;
		const touched = new Set([...this.matches.keys(), ...byRow.keys()]);
		this.matches = byRow;
		this.revealMatch = byRow.size > 0;
		if (byRow.size) this.painted = true;
		for (const row of touched) this.paintRowMatches(row);
		this.requestMatch();
	}

	/** Whether the table holds any of Find's matches, or the Search pane's. */
	get hasMatches(): boolean {
		return this.matches.size > 0;
	}

	/** Draws a drawn row's matches, -1 being the header, and takes off those it had. */
	private paintRowMatches(row: number): void {
		const tr = row < 0 ? this.blocks[0]?.thead?.firstElementChild : this.rendered.get(row);
		const view = this.view;
		if (!view || row >= this.count) return;
		// The pinned rows' copies show them even where the real row isn't drawn, deep in a long table.
		this.pins.paintMatches(row);
		if (!tr?.instanceOf(HTMLTableRowElement)) return;
		const { header } = linesOf(view.state.doc, this);
		paintMatches(tr, view.state.doc.line(row < 0 ? header : header + 2 + row).text, this.matches.get(row) ?? []);
	}

	/**
	 * Brings the first match into view sideways, once its row is drawn: Obsidian's own scroll takes it into view down the
	 * note. Only a drawn row asks for a measure, since each pass of drawing rows calls this, and a measure asked for in
	 * every pass of a far jump restarts CodeMirror's measure loop until it gives up.
	 */
	private requestMatch(): void {
		const view = this.view;
		if (!view || !this.revealMatch) return;
		const first = Math.min(...this.matches.keys());
		const tr = first < 0 ? this.blocks[0]?.thead?.firstElementChild : this.rendered.get(first);
		if (!tr?.isConnected) return;
		view.requestMeasure({
			key: this.matchKey,
			read: () => {
				const el = tr.isConnected ? tr.querySelector(MATCH_SELECTOR) : null;
				const cell = el?.closest('td, th');
				// A match in a frozen column shows where the strip is: the table stays where it is sideways.
				const pinned = cell?.instanceOf(HTMLTableCellElement) && cell.cellIndex < this.pins.room.columns;
				return el ? { rect: el.getBoundingClientRect(), pinned, clear: pinned ? 0 : this.stripClear() } : null;
			},
			write: (found) => {
				if (!found) return;
				this.revealMatch = false;
				if (!found.pinned) this.showSideways(found.rect.left, found.rect.right, found.clear);
			},
		});
	}

	destroy(): void {
		this.pins.destroy();
		this.toOpen = null;
		this.component.unload();
		this.bar?.destroy();
		this.bar = null;
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
		this.headWords = cellsOf(headLine, columns).map((text) => this.withMedia(text, true, measureCell(text, metrics, true, measure)));
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
		return cellsOf(line, this.columns).map((text) => this.withMedia(text, false, measureCell(text, this.metrics!, false, measure)));
	}

	/** A cell's words, as wide as its picture or player measured, once it has been. */
	private withMedia(text: string, header: boolean, words: Words): Words {
		const size = this.media.size ? this.media.get(`${header ? 'h' : 'd'}\u0001${text}`) : undefined;
		return size ? { ...words, min: size.min, max: size.max } : words;
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
	track(oldDoc: Text, doc: Text, before: TableLines, change: LineChange | null, changes: ChangeSet | null = null): void {
		if (this.text !== oldDoc) {
			this.stale = true;
			this.checkRows = true;
			this.todo = true;
		} else if (change || linesOf(doc, this).count !== before.count) this.edit(oldDoc, doc, before, change, changes);
		this.text = doc;
	}

	/**
	 * The table's text changed: rows a change touched are measured again, and the rest keep their sizes. A change
	 * to the header, the delimiter or the number of columns works the whole shape out again.
	 */
	private edit(oldDoc: Text, doc: Text, before: TableLines, change: LineChange | null, changes: ChangeSet | null): void {
		this.checkRows = true;
		this.todo = true;
		if (this.stale || !this.metrics) return;
		const now = linesOf(doc, this);
		if (change && now.count === before.count && this.repadded(oldDoc, doc, before, now, change, changes)) return;
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
		this.refit();
	}

	/**
	 * A change that pads a column again, as an open cell's text outgrowing it does in a table Obsidian wrote, rewrites
	 * every line of the table, the header and the delimiter row included, and leaves every cell's text as it was but the
	 * one being typed in. Read as an edit of the header, it would work the whole shape out again, every cell of every
	 * row measured on each key. So rows are compared, padding aside, and only those whose cells changed are measured.
	 * Says whether it took the change: not when the columns or their alignment changed.
	 */
	private repadded(oldDoc: Text, doc: Text, before: TableLines, now: TableLines, change: LineChange, changes: ChangeSet | null): boolean {
		if (change.first > now.header + 1 && change.oldFirst > before.header + 1) return false;
		const delimiter = (text: Text, lines: TableLines) => (lines.header < text.lines ? rowCells(text.line(lines.header + 1).text) : []);
		const was = delimiter(oldDoc, before);
		const is = delimiter(doc, now);
		if (was.length !== is.length || was.some((cell, column) => alignOf(cell) !== alignOf(is[column] ?? ''))) return false;
		const oldHead = oldDoc.line(before.header).text;
		const head = doc.line(now.header).text;
		if (rowCells(head).length > this.columns) return false;
		const first = Math.max(0, change.first - now.header - 2);
		const last = Math.min(now.count - 1, change.last - now.header - 2);
		// With the change itself, the rows it touched other than by padding: spaces put in or taken out beside a pipe, and
		// dashes in the delimiter row, change no cell, so only the other changes' rows are compared.
		const rows = changes ? new Set<number>() : null;
		changes?.iterChanges((fromA, toA, fromB, toB, inserted) => {
			const padding = /^[ -]*$/;
			const byPipe = doc.sliceString(toB, toB + 1) === '|' || (fromB > 0 && doc.sliceString(fromB - 1, fromB) === '|');
			if (padding.test(inserted.toString()) && padding.test(oldDoc.sliceString(fromA, toA)) && (byPipe || doc.lineAt(fromB).number === now.header + 1)) return;
			for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) rows?.add(n - now.header - 2);
		});
		const changed: number[] = [];
		for (let row = first; row <= last; row++) {
			if (rows && !rows.has(row)) continue;
			const from = oldDoc.line(before.header + 2 + row).text;
			const after = doc.line(now.header + 2 + row).text;
			// Padding is spaces beside the pipes: lines equal without them have the same cells, but for runs of spaces
			// inside a cell, which draw as one. Cheaper than reading each row's cells, on every key in a long table.
			if (from === after || unpadded(from) === unpadded(after)) continue;
			if (rowCells(after).length > this.columns) return false;
			changed.push(row);
		}
		let taller = false;
		if (!sameCells(oldHead, head, this.columns, -1)) {
			this.headWords = cellsOf(head, this.columns).map((text) => this.withMedia(text, true, measureCell(text, this.metrics!, true, measure)));
			const was = this.headHeight;
			this.headHeight = rowHeight(this.headWords, this.widths, this.metrics!, true);
			taller ||= was !== this.headHeight;
		}
		for (const row of changed) {
			const words = this.measureRow(doc.line(now.header + 2 + row).text);
			this.rowWords[row] = words;
			if (this.heights.set(row, rowHeight(words, this.widths, this.metrics!, false), false)) taller = true;
		}
		// A row whose height the estimate already has isn't changed when it's measured, so what pins is placed again now,
		// for a row that grows or shrinks in the strip and the frozen rows' copies.
		if (this.refit() || taller) this.pins.measure();
		return true;
	}

	/** Fits the columns again to their cells' sizes, and says whether any width changed. */
	private refit(): boolean {
		const widths = this.fit();
		if (widths.join(',') === this.widths.join(',')) return false;
		// Every row's estimate changes, so the blocks are decorated again for CodeMirror to take their heights.
		this.generation++;
		this.widths = widths;
		this.headHeight = rowHeight(this.headWords, widths, this.metrics!, true);
		this.rowWords.forEach((cells, r) => this.heights.set(r, rowHeight(cells, widths, this.metrics!, false), false));
		this.remeasure = true;
		return true;
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

	/** The sizes changed, the theme's (`look`) or the pane's: the shape is worked out again. */
	resize(look = false): void {
		this.pins.forget(look);
		this.stale = true;
		this.metrics = null;
		this.todo = true;
		this.media.clear();
		this.rescanMedia = true;
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
		// CodeMirror puts a block it draws again back in the page, which takes the keyboard from an open cell in it.
		const open = openCells.get(view);
		if (open && open.view.hasFocus && block.dom.contains(open.view.dom)) {
			queueMicrotask(() => {
				if (openCells.get(view) === open && !open.view.hasFocus && open.view.dom.isConnected) open.view.focus();
			});
		}
		this.refresh();
		// A block coming into the page may hold rows near the pane that weren't drawn while it was out, and what it pins
		// is placed for where it is now.
		if (this.blockCount > 1) this.schedule(true);
		this.pins.measure();
		this.placeBar();
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
		// A press on a cell opens it, with the caret where it landed, and a press beside the cells selects the whole
		// table. The browser moves no caret and starts no selection: the press's default is prevented, apart from a
		// link's, the table's own scrollbar's, and the open cell's editor's.
		const onScrollbar = (event: MouseEvent) => event.target === dom && (event.offsetX >= dom.clientWidth || event.offsetY >= dom.clientHeight);
		const inEditor = (target: Element) => {
			const editor = target.closest('.cm-editor');
			return !!editor && dom.contains(editor);
		};
		const leftAlone = (event: MouseEvent) => {
			const target = event.target as Element;
			return event.button !== 0 || onScrollbar(event) || !!target.closest('a') || inEditor(target);
		};
		const hold = (event: MouseEvent) => {
			if (!leftAlone(event)) event.preventDefault();
		};
		dom.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse') hold(event);
		});
		dom.addEventListener('mousedown', hold);
		dom.addEventListener('click', (event) => {
			if (leftAlone(event)) return;
			const el = (event.target as Element).closest('td, th');
			const cell = el?.instanceOf(HTMLTableCellElement) && dom.contains(el) ? this.cellOf(el) : null;
			if (!cell || !el) {
				this.select(this);
				return;
			}
			event.preventDefault();
			this.open(this, cell, { x: event.clientX, y: event.clientY, visible: visibleAt(el as HTMLTableCellElement, event.clientX, event.clientY) });
		});
		// A picture that loads changes its row's height, and can widen its column, as in Obsidian's table, where the
		// browser lays the table out again. A video does once it knows its size.
		const loaded = (event: Event) => {
			const cell = (event.target as Element).closest('td, th');
			if (cell?.instanceOf(HTMLTableCellElement)) this.sizeMedia([cell]);
			this.schedule(true);
		};
		dom.addEventListener('load', loaded, true);
		dom.addEventListener('loadedmetadata', loaded, true);
		dom.toggleClass('is-selected', this.selected);
		table.toggleClass(HOLDS_CELL_CLASS, !!this.cell);
		if (this.dir) dom.dir = this.dir;
		// Which table a swipe over the block is for.
		dom.setAttribute(BOX_ID, String(this.id));
		const block: Block = { index, dom, table, colgroup, thead, tbody, lead: spacer(PARITY_CLASS, EDGE_CLASS), above: spacer(), parity: spacer(PARITY_CLASS), below: spacer(), gap: spacer(), tail: spacer(PARITY_CLASS, EDGE_CLASS), applied: '', dressed: '' };
		this.blocks[index] = block;
		// A block that comes into the page is drawn where the table is sideways, in its first frame.
		this.dress(block);
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
				if (row >= this.count) this.dirty.add(row);
				else if (tr === this.openRow) {
					// Only the open cell's text changed, as typing in it does: its editor already shows it, and nothing is drawn.
					const text = doc.line(header + 2 + row).text;
					const was = this.drawnFrom.get(tr);
					if (was !== undefined && sameCells(was, text, this.columns, this.openColumn)) this.drawnFrom.set(tr, text);
					else this.dirty.add(row);
				} else if (!this.drawnAs(tr, doc.line(header + 2 + row).text)) this.dirty.add(row);
			}
		}
		if (doc.lineAt(this.from).text !== this.headText) this.renderHead();
		this.arrange();
		this.schedule(this.dirty.size > 0 || this.remeasure);
		this.remeasure = false;
		this.placeBar();
		this.pins.refresh();
	}

	/**
	 * Whether a drawn row shows a line's text: it was drawn from that text, or from one with the same cells, which only
	 * pads them otherwise, as a column padded again for an open cell's text does to every row. That one is taken as
	 * drawn from the new text.
	 */
	private drawnAs(tr: HTMLTableRowElement, text: string): boolean {
		const was = this.drawnFrom.get(tr);
		if (was === text) return true;
		if (was === undefined || !sameCells(was, text, this.columns, -1)) return false;
		this.drawnFrom.set(tr, text);
		return true;
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
		const widths = this.appliedWidths();
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
			block.table.style.width = this.tableWidth(widths);
			for (const row of [block.lead, block.above, block.parity, block.below, block.gap, block.tail]) (row.firstChild as HTMLTableCellElement).colSpan = Math.max(1, this.columns);
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
		const openRow = this.rowOfOpen();
		const open = openRow !== null && openRow > 0 ? openRow - 1 : -1;
		const top = (row: number) => this.heights.top(row);
		for (const block of this.blocks) {
			if (!block || block.index >= this.blockCount) continue;
			const body = bodyLayout(this.heights, block.index, this.drawn, (row) => this.rendered.has(row));
			const { first, end } = blockRows(this.count, block.index);
			const run = body.rows;
			// The open cell's row, kept in the page away from the rows drawn, sits among spacers of its own. Its stripe may
			// be off while it's out of view; the drawn rows' are right.
			const apart = open >= first && open < end && (open < run.first || open >= run.end) ? this.openRow : null;
			let above = body.above;
			let below = body.below;
			let gap: number | null = null;
			let parity = body.parity;
			let openFirst = false;
			if (apart && run.end <= run.first) {
				above = open > first ? top(open) - top(first) : null;
				below = open + 1 < end ? top(end) - top(open + 1) : null;
				parity = false;
				openFirst = true;
			} else if (apart && open < run.first) {
				above = open > first ? top(open) - top(first) : null;
				gap = run.first > open + 1 ? top(run.first) - top(open + 1) : null;
				const before = (body.lead ? 1 : 0) + (above !== null ? 1 : 0) + 1 + (gap !== null ? 1 : 0);
				parity = (((run.first - before) % 2) + 2) % 2 === 1;
				openFirst = true;
			} else if (apart) {
				gap = open > run.end ? top(open) - top(run.end) : null;
				below = open + 1 < end ? top(end) - top(open + 1) : null;
			}
			const want: HTMLTableRowElement[] = [];
			if (body.lead) want.push(block.lead);
			if (above !== null) want.push(block.above);
			if (apart && openFirst) {
				want.push(apart);
				if (gap !== null) want.push(block.gap);
			}
			if (parity) want.push(block.parity);
			// A row an edit added isn't drawn until the next measure: until then, the rows around it close up.
			for (let row = run.first; row < run.end; row++) {
				const tr = this.rendered.get(row);
				if (!tr) continue;
				// Only rows near the pane are in the page, so each says which row of the table it is, the header being 1.
				const index = String(row + 2);
				if (tr.getAttribute('aria-rowindex') !== index) tr.setAttribute('aria-rowindex', index);
				want.push(tr);
			}
			if (apart && !openFirst) {
				if (gap !== null) want.push(block.gap);
				want.push(apart);
			}
			if (below !== null) want.push(block.below);
			if (body.tail) want.push(block.tail);
			if (block.table.getAttribute('aria-rowcount') !== rows) block.table.setAttribute('aria-rowcount', rows);
			const height = (row: HTMLTableRowElement, px: number | null) => {
				const cell = row.firstChild as HTMLTableCellElement;
				const value = `${Math.max(0, px ?? 0)}px`;
				if (cell.style.height !== value) cell.style.height = value;
			};
			height(block.above, above);
			height(block.below, below);
			height(block.gap, gap);
			const keep = new Set<Node>(want);
			for (let node = block.tbody.firstChild; node; ) {
				const next = node.nextSibling;
				if (!keep.has(node)) node.remove();
				node = next;
			}
			// The open cell's row is never moved, which would take the keyboard from its editor: what's out of place
			// around it moves instead.
			let at = block.tbody.firstChild;
			for (const row of want) {
				if (row === at) at = at.nextSibling;
				else if (row === this.openRow && row.parentNode === block.tbody) {
					const between: Node[] = [];
					for (let node = at; node && node !== row; node = node.nextSibling) between.push(node);
					row.after(...between);
					at = row.nextSibling;
				} else block.tbody.insertBefore(row, at);
			}
			this.pins.arranged(block);
		}
		this.paintCell();
	}

	/**
	 * The columns' widths on the page. Joined, a column holds half of each line beside it. Drawn by its cells, the first
	 * column holds both its lines whole, half of each more, so it gets that room back and its text has the same room as
	 * in Obsidian's.
	 */
	private appliedWidths(): number[] {
		return this.metrics?.collapsed ? this.widths.map((width, column) => (column === 0 ? width + this.metrics!.firstExtra : width)) : this.widths;
	}

	/** A table's width holds its own borders, which a theme may set beside its cells', and the space between cells. */
	private tableWidth(widths: number[]): string {
		const { tableBorder = 0, spacing = 0 } = this.metrics ?? {};
		return `${widths.reduce((sum, width) => sum + width, tableBorder + spacing * (this.columns + 1))}px`;
	}

	/** What the frozen rows and columns need from the table. */
	private pinHost(): PinHost {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the host's getters read the model live
		const model = this;
		return {
			get view() {
				return model.view;
			},
			get pinBlocks() {
				return model.blocks;
			},
			get blockCount() {
				return model.blockCount;
			},
			get count() {
				return model.count;
			},
			get columns() {
				return model.columns;
			},
			get appliedWidths() {
				return model.appliedWidths();
			},
			get tableWidth() {
				return model.tableWidth(model.appliedWidths());
			},
			get spacing() {
				return model.metrics?.spacing ?? 0;
			},
			get startBorder() {
				return (model.metrics?.tableBorder ?? 0) / 2;
			},
			get slides() {
				return model.slides;
			},
			lines(rows: number): string[] {
				const doc = model.view?.state.doc;
				if (!doc) return [];
				const { header } = linesOf(doc, model);
				const out = [doc.line(header).text];
				for (let row = 0; row < Math.min(rows, model.count); row++) out.push(doc.line(header + 2 + row).text);
				return out;
			},
			render(rows: string[]): HTMLTableRowElement[] {
				const out = model.render(rows);
				const head = out[0];
				if (head) for (const column of markedCells(model.view!.state.doc.lineAt(model.from).text)) head.cells[column]?.addClass(MARK_CELL_CLASS);
				return out;
			},
			release: (tr) => this.release(tr),
			textOf: (tr) => this.drawnFrom.get(tr),
			matchesOf: (row) => {
				const list = this.matches.get(row);
				const doc = this.view?.state.doc;
				if (!list?.length || !doc || row >= this.count) return null;
				const { header } = linesOf(doc, this);
				return { line: doc.line(row < 0 ? header : header + 2 + row).text, matches: list };
			},
			matchedRow: (tr) => {
				for (const row of this.matches.keys()) if ((row < 0 ? this.blocks[0]?.thead?.firstElementChild : this.rendered.get(row)) === tr) return row;
				return null;
			},
			rowHeight: (row) => (row < 0 ? this.headHeight : this.heights.get(row)),
			rowElement(row: number): HTMLTableRowElement | null {
				const tr = row < 0 ? model.blocks[0]?.thead?.firstElementChild : model.rendered.get(row);
				return tr?.instanceOf(HTMLTableRowElement) ? tr : null;
			},
		};
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
				const td = copyOf(cell, page, tr);
				const box = td.appendChild(cellBox(page, Array.from(cell.childNodes)));
				// A cell's text direction goes on its box: where cells draw their own borders (styles.css), they do it by the
				// table's direction, which a cell reading the other way would turn round, leaving the table's end bare.
				const dir = td.getAttribute('dir');
				if (dir) {
					td.removeAttribute('dir');
					box.dir = dir;
				}
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

	/**
	 * The open cell's row has new text: its other cells are drawn again in it, in place, and the open cell is left as
	 * it is. Moving the row, or the cell, would take the keyboard from the cell's editor. Nothing is drawn when only
	 * the open cell's text or the padding changed.
	 */
	private patchOpen(row: number, tr: HTMLTableRowElement): void {
		const doc = this.view!.state.doc;
		const text = doc.line(linesOf(doc, this).header + 2 + row).text;
		const was = this.drawnFrom.get(tr);
		if (was === undefined || !sameCells(was, text, this.columns, this.openColumn)) {
			const [head, fresh] = this.render([text]);
			if (head) this.release(head);
			if (fresh) this.patchRow(tr, fresh);
			if (this.matches.size || this.painted) paintMatches(tr, text, this.matches.get(row) ?? []);
		}
		this.drawnFrom.set(tr, text);
	}

	/** Moves a freshly drawn row's cells into the open cell's row, all but the open cell, which keeps its own. */
	private patchRow(tr: HTMLTableRowElement, fresh: HTMLTableRowElement): void {
		const now = Array.from(fresh.cells);
		const was = Array.from(tr.cells);
		if (now.length !== was.length) {
			this.release(fresh);
			return;
		}
		now.forEach((cell, column) => {
			if (column !== this.openColumn) tr.replaceChild(cell, was[column]!);
		});
		// The row's rendered pieces are the new batch's now: the old one goes once none of its rows is left.
		const batch = this.batchOf.get(fresh);
		this.batchOf.delete(fresh);
		this.release(tr);
		if (batch) this.batchOf.set(tr, batch);
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
		const old = thead.firstElementChild;
		// Padding alone changes nothing drawn, and an open header cell keeps its row: the others are drawn again in it.
		const kept = old?.instanceOf(HTMLTableRowElement) && this.headText !== null ? old : null;
		if (kept && sameCells(this.headText!, text, this.columns, kept === this.openRow ? this.openColumn : -1)) {
			this.headText = text;
			return;
		}
		const [row] = this.render([]);
		for (const column of markedCells(text)) row?.cells[column]?.addClass(MARK_CELL_CLASS);
		row?.setAttribute('aria-rowindex', '1');
		if (kept && row && kept === this.openRow) {
			this.patchRow(kept, row);
			this.headText = text;
			if (this.matches.has(-1)) this.paintRowMatches(-1);
			return;
		}
		if (old?.instanceOf(HTMLTableRowElement)) this.release(old);
		thead.empty();
		if (row) thead.append(row);
		this.headText = text;
		if (this.matches.has(-1)) this.paintRowMatches(-1);
		this.paintCell();
		if (row) this.sizeMedia(mediaCells([row]));
		const dir = row?.cells[0]?.firstElementChild?.getAttribute('dir') ?? '';
		if (dir !== this.dir) {
			this.dir = dir;
			for (const block of this.blocks) block?.dom.setAttr('dir', dir || null);
			this.placeBox(null, true);
			this.placeBar();
		}
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
		// Kept rows may hold matches from before, and fresh ones none.
		if (this.matches.size || this.painted) rows.forEach((row, i) => paintMatches(out[i]!, doc.line(header + 2 + row).text, this.matches.get(row) ?? []));
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
		if (!view) return null;
		const scroller = view.scrollDOM;
		const pane = scroller.getBoundingClientRect().top;
		// From the block in the page nearest the pane's top: CodeMirror keeps the blocks holding the selection in the
		// page too, and its heights for the blocks between can differ from the table's.
		let block: Block | undefined;
		let nearest = Infinity;
		for (const each of this.blocks) {
			if (!each?.dom.isConnected) continue;
			const box = each.dom.getBoundingClientRect();
			const distance = box.top > pane ? box.top - pane : box.bottom < pane ? pane - box.bottom : 0;
			if (distance < nearest) {
				nearest = distance;
				block = each;
			}
		}
		if (!block) return null;
		// Where body row 0 starts on the page: a block's body starts at its first row.
		const body = block.tbody.getBoundingClientRect().top - this.heights.top(blockRows(this.count, block.index).first);
		const scrollTop = scroller.scrollTop * view.scaleY;
		let line = view.lineBlockAtHeight(scrollTop + 8);
		const first = view.viewportLineBlocks[0];
		if (first && line.from < view.viewport.from && first.top - scrollTop <= 200) line = first;
		// Scrolled to the bottom, CodeMirror keeps the bottom still instead.
		const bottom = scroller.scrollTop > Math.max(1, scroller.scrollHeight - scroller.clientHeight - 4);
		const anchorBlock = !bottom && line.from >= this.from && line.from <= this.to ? blockSpans(view.state.doc, this).findIndex((span) => span.from === line.from) : -1;
		return { top: pane - body, bottom: pane + scroller.clientHeight - body, anchorBlock };
	}

	/**
	 * Draws the rows within OVER px of the pane, unless those drawn already reach MARGIN past it, in their blocks, built
	 * here if CodeMirror hasn't asked for them yet. CodeMirror puts the next block in the page only once the screen is
	 * about 250 px from its edge, so a block that came in empty and had its rows drawn then made that frame long, and a
	 * hard flick ran past it into blank space. Drawn ahead, a block comes in with its rows.
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
			// The open cell's row stays, wherever the pane is, and its other cells are drawn again in it.
			if (tr === this.openRow) {
				if (changed && row < this.count) this.patchOpen(row, tr);
				continue;
			}
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
		let built = false;
		for (const row of need) {
			const index = blockOf(this.count, row);
			if (this.blocks[index]) continue;
			this.build(index);
			built = true;
		}
		if (built) {
			this.apply();
			if (view.state.doc.lineAt(this.from).text !== this.headText) this.renderHead();
		}
		const fresh = this.renderRows(need);
		need.forEach((row, i) => this.rendered.set(row, fresh[i]!));
		this.drawn = { first, end };
		this.arrange();
		this.placeBar();
		// Players have their size at once, and pictures kept from before have loaded; the rest measure as they load.
		this.sizeMedia(mediaCells(this.rescanMedia ? [...this.rendered.values(), ...Array.from(this.blocks[0]?.thead?.rows ?? [])] : fresh));
		this.rescanMedia = false;
		if (need.length || force) view.requestMeasure({ key: this.heightKey, read: () => timed('measure', () => this.readHeights()), write: (measured) => timed('draw', () => this.fixHeights(measured, anchor, anchorTop)) });
		else this.drawnAll();
	}

	/** The rows are drawn and measured: a cell or a match waiting for its row is shown now, before the frame is painted. */
	private drawnAll(): void {
		this.requestShow();
		this.requestMatch();
		// A cell waiting to open, once its row is drawn: after this measure, since opening it writes to the note.
		const waiting = this.toOpen;
		if (waiting && this.cellElement(waiting.cell)?.isConnected) {
			this.toOpen = null;
			queueMicrotask(waiting.run);
		}
	}

	/** Measures cells' pictures and players on the next measure, and widens their columns to fit, as Obsidian's table does. */
	private sizeMedia(cells: Iterable<HTMLTableCellElement>): void {
		const view = this.view;
		if (!view) return;
		for (const cell of cells) this.mediaCells.add(cell);
		if (!this.mediaCells.size) return;
		view.requestMeasure({
			key: this.mediaKey,
			read: () => timed('measure', () => this.readMedia()),
			write: (sizes) => timed('draw', () => this.fitMedia(sizes)),
		});
	}

	private readMedia(): { key: string; header: boolean; row: number; column: number; size: Size }[] {
		const view = this.view;
		const cells = [...this.mediaCells];
		this.mediaCells.clear();
		if (!view || !this.metrics || this.stale) return [];
		const rowOf = new Map<HTMLTableRowElement, number>();
		for (const [row, tr] of this.rendered) rowOf.set(tr, row);
		const doc = view.state.doc;
		const { header } = linesOf(doc, this);
		const out: { key: string; header: boolean; row: number; column: number; size: Size }[] = [];
		for (const cell of cells) {
			const tr = cell.parentElement;
			if (!cell.isConnected || !tr?.instanceOf(HTMLTableRowElement) || !Array.from(cell.querySelectorAll(MEDIA)).every(sized)) continue;
			const head = cell.localName === 'th';
			const row = head ? -1 : (rowOf.get(tr) ?? -2);
			if (row < -1 || row >= this.count) continue;
			const column = cell.cellIndex;
			const text = cellsOf(doc.line(head ? header : header + 2 + row).text, this.columns)[column];
			if (text === undefined) continue;
			out.push({ key: `${head ? 'h' : 'd'}\u0001${text}`, header: head, row, column, size: measureContent(view, cell, this.metrics) });
		}
		return out;
	}

	/** Takes measured cells' sizes, and fits the columns again if any of them needs more or less room. */
	private fitMedia(sizes: { key: string; header: boolean; row: number; column: number; size: Size }[]): void {
		let changed = false;
		for (const { key, header, row, column, size } of sizes) {
			const was = this.media.get(key);
			if (was && Math.abs(was.min - size.min) < 0.01 && Math.abs(was.max - size.max) < 0.01) continue;
			this.media.set(key, size);
			const words = header ? this.headWords : this.rowWords[row];
			const cell = words?.[column];
			if (!words || !cell) continue;
			words[column] = { ...cell, min: size.min, max: size.max };
			changed = true;
		}
		if (changed && this.refit()) {
			this.todo = true;
			this.refresh();
		}
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
		this.drawnAll();
		if (!changed) return;
		this.arrange();
		this.placeBar();
		this.pins.measure();
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
	placeBox(added: HTMLElement | null, turned = false): void {
		if (this.blockCount < 2) {
			// A table back to one block has no box, and starts again at its left edge if it grows past 100 rows.
			this.sideBox?.removeEventListener('scroll', this.onSideways);
			this.sideBox = null;
			this.scrollX = 0;
			return;
		}
		const box = added ?? this.blocks.find((block) => block?.dom.isConnected)?.dom.parentElement ?? null;
		if (!box?.hasClass(BOX_CLASS)) return;
		// The box runs the table's way, so a wide table that runs right to left starts scrolled to its first column.
		if ((box.getAttribute('dir') ?? '') !== this.dir) box.setAttr('dir', this.dir || null);
		if (!added && !turned && box === this.sideBox) return;
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

	// Sideways, on a computer ----------------------------------------------------------------------------------------

	/** The box the table shows in: its one block, or the box around its blocks. Null while none is in the page. */
	private boxNow(): HTMLElement | null {
		const block = this.blocks.find((each) => each?.dom.isConnected);
		if (!block) return null;
		if (this.blockCount < 2) return block.dom;
		const box = block.dom.parentElement;
		return box?.hasClass(BOX_CLASS) ? box : null;
	}

	/** Places the table's scrollbar on CodeMirror's next measure, after the table's size or place may have changed. */
	placeBar(): void {
		const view = this.view;
		if (!view || (!this.bar && !this.blocks.some((block) => block?.dom.isConnected))) return;
		view.requestMeasure({ key: this.barKey, read: () => timed('measure', () => this.readBar()), write: (read) => timed('draw', () => this.writeBar(read)) });
	}

	/**
	 * How far the table can move sideways, and where its bar goes: from under the header to under the last row, in the
	 * note's content, taken from the page where those rows are in it, else from CodeMirror's heights. Null when no
	 * block is in the page, which leaves the bar as it is.
	 */
	private readBar(): BarRead | null {
		const view = this.view;
		const metrics = this.metrics;
		if (!view || this.stale || !metrics) return null;
		const bars = usesBars(view);
		const none: BarRead = { bars, slide: 0, left: 0, width: 0, height: 0 };
		if (!bars) return none;
		const box = this.boxNow();
		const table = this.blocks.find((block) => block?.dom.isConnected)?.table.parentElement;
		if (!box || !table) return null;
		// Fractional widths, as the browser lays them out: a box's clientWidth is rounded, and its scroll range isn't.
		const style = getComputedStyle(box);
		const rect = box.getBoundingClientRect();
		const width = rect.width - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
		const slide = maxSlide(table.getBoundingClientRect().width, parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0, width);
		if (slide <= 0) return none;
		const scroller = view.scrollDOM;
		const pane = scroller.getBoundingClientRect();
		const top = pane.top + scroller.clientTop - scroller.scrollTop;
		const left = pane.left + scroller.clientLeft - scroller.scrollLeft;
		const toContent = view.documentTop - top;
		const padBottom = metrics.pad - metrics.padTop;
		const first = this.blocks[0];
		const last = this.blocks[this.blockCount - 1];
		const start = first?.thead?.isConnected ? first.thead.getBoundingClientRect().bottom - top : view.lineBlockAt(this.from).top + toContent + metrics.padTop + this.headHeight;
		const end = last?.table.isConnected ? last.table.getBoundingClientRect().bottom - top : view.lineBlockAt(this.to).bottom + toContent - padBottom;
		const height = Math.max(BAR_HEIGHT, padBottom);
		const place = barPlace(start, end, height, scroller.clientHeight, statusInset(scroller, pane, rect));
		// The bar's scroll range is the slide exactly: it's a whole number of pixels wide, and its content that much wider.
		return { bars, slide, place, left: rect.left + (parseFloat(style.borderLeftWidth) || 0) - left, width: box.clientWidth, height };
	}

	private writeBar(read: BarRead | null): void {
		const view = this.view;
		if (!read || !view) return;
		const was = this.slides ? this.slide : 0;
		if (read.slide > 0 && read.place) {
			this.bar ??= new Bar(view, `--selectable-tables-x-${this.id}`, this.onBar);
			this.slide = read.slide;
			this.bar.place(read.place, read.left, read.width, read.height, read.slide, this.dir);
		} else if (this.bar) {
			this.bar.destroy();
			this.bar = null;
			this.slide = 0;
		}
		for (const block of this.blocks) if (block) this.dress(block);
		// Frozen columns pin only in a table that moves sideways: placed again when that changes, not on every scroll.
		if ((this.slides ? this.slide : 0) !== was) this.pins.measure();
	}

	private readonly onBar = () => {
		if (this.bar) this.scrollX = this.bar.scroll;
	};

	/** Has a block follow the table's scrollbar, or not, as the table is wide and the editor uses bars. */
	private dress(block: Block): void {
		const bar = this.bar;
		const slide = bar ? `${this.dir === 'rtl' ? '' : '-'}${this.slide}px` : '';
		const key = bar ? `${bar.name} ${slide}` : '';
		if (key === block.dressed) return;
		block.dressed = key;
		block.dom.toggleClass(SLIDES_CLASS, !!bar);
		if (bar) {
			block.dom.style.setProperty(TIMELINE_VARIABLE, bar.name);
			block.dom.style.setProperty(SLIDE_VARIABLE, slide);
		} else {
			block.dom.style.removeProperty(TIMELINE_VARIABLE);
			block.dom.style.removeProperty(SLIDE_VARIABLE);
		}
	}

	/** Whether a sideways swipe over the table moves it: it's wider than its box, on a computer. */
	get slides(): boolean {
		return !!this.bar && this.slide > 0;
	}

	/** Moves the table sideways by a swipe's step, as a box's own scroll would, at the swipe's own speed. */
	slideBy(dx: number): void {
		// The table stays at its start while a cell in a frozen row and a frozen column is open.
		if (this.pins.holdsStart) return;
		if (this.bar) this.bar.scroll = clampSlide(this.bar.scroll + dx, this.slide, this.dir === 'rtl');
	}

	/**
	 * Moves the table sideways just enough to show `left` to `right`, on the screen, as `scrollIntoView` with `nearest`
	 * would in its box, keeping `clear` px at the box's start free, for a frozen column. Moves its bar on a computer,
	 * and its box on a phone or tablet, so a caller needn't know which.
	 */
	showSideways(left: number, right: number, clear = 0): void {
		const box = this.boxNow();
		if (!box) return;
		const rect = box.getBoundingClientRect();
		const start = rect.left + box.clientLeft;
		const rtl = this.dir === 'rtl';
		const delta = revealDelta({ left: start, right: start + box.clientWidth }, { left, right }, clear, rtl);
		if (!delta) return;
		if (this.bar) {
			this.bar.scroll = clampSlide(this.bar.scroll + delta, this.slide, rtl);
			return;
		}
		box.scrollLeft += delta;
		if (box === this.sideBox) this.scrollX = box.scrollLeft;
	}

	/** For the check script: the table's scrollbar, how far the table is moved sideways, and how far it can go. */
	sideways(): { bar: HTMLElement | null; scroll: number; slide: number } {
		return { bar: this.bar?.dom ?? null, scroll: this.bar ? this.bar.scroll : this.scrollX, slide: this.slide };
	}

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
