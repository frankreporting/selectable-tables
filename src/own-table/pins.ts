import type { EditorView } from '@codemirror/view';
import { CELL_CLASS, HOLDS_CELL_CLASS } from '../editor/cells';
import { canFreeze } from '../editor/freeze';
import { type Freeze, readFreeze } from '../editor/freeze-mark';
import { type Paint, readPaint } from '../editor/theme-paint';
import { usesBars } from './bar';
import { frozenIn, pinsFit, railOf, stickyTops, stripWidth } from './pin-sums';

/**
 * Frozen rows and columns in the plugin's table, on a computer (STA-91). On a computer no box scrolls the table
 * sideways: its blocks follow a scrollbar of the plugin's own by a transform (bar.ts), so rows stick to the note
 * with plain `position: sticky`, where the scroll runs, and nothing here runs as the note moves.
 *
 * - A table of one block pins its real rows: the header and the frozen rows under it stick.
 * - A table of more blocks draws a copy of the frozen rows in each block, which sticks while its block crosses the
 *   pane's top, and the block clips it: across a seam, one block's copy hands over to the next one's.
 * - Frozen columns are a strip beside the table, one per block, which doesn't take the table's sideways move: a copy
 *   of the frozen columns' cells for the rows drawn, each row as tall as the real row. Where frozen rows and columns
 *   meet, a corner stays put both ways.
 *
 * What's copied is drawn again whenever the real rows change. Phones and tablets keep a box that scrolls the table
 * sideways, so nothing pins there, and nor on a device without scroll-driven animations (`canFreeze`).
 */

/** On a block while its table pins anything: styles.css paints what pins, with the theme's colors. */
export const PINS_CLASS = 'selectable-tables-pins';
/** On a block while its table's rows pin. */
const PIN_ROWS_CLASS = 'selectable-tables-pin-rows';
/** On a block of a table drawn as one block. */
const SINGLE_CLASS = 'selectable-tables-single';
/** On a real frozen row of a table of one block, and on its copy in the strip: it sticks. */
const PINNED_ROW_CLASS = 'selectable-tables-pinned-row';
const STRIP_CLASS = 'selectable-tables-strip';
const RAIL_CLASS = 'selectable-tables-rail';
const COPY_CLASS = 'selectable-tables-copy';
const SLIDER_CLASS = 'selectable-tables-copy-slides';
const CORNER_CLASS = 'selectable-tables-corner';
/** A hidden cell at the end of each copied row, so a theme's rules for a row's last cell don't land on a frozen one. */
const FILLER_CLASS = 'selectable-tables-filler';
/** On a copied row: the table's row it copies, 0 being the header, so a press on it reaches the real cell. */
export const ROW_ATTRIBUTE = 'data-selectable-tables-row';
/** On the editor: how far above the scroller's content box rows pin, so they pin at the pane's top. */
const PIN_VARIABLE = '--selectable-tables-own-pin';
/** As model.ts names them: rows that stand in for others, and hidden rows that only count for a theme's rules. */
const SPACER_CLASS = 'selectable-tables-spacer';
const PARITY_CLASS = 'selectable-tables-parity';
/** An open cell's drawn text, hidden while its editor shows (open-cell.ts). */
const OPEN_TEXT_CLASS = 'selectable-tables-open-text';
/** Find's marks on a cell (matches.ts). */
const MATCH_CLASSES = ['selectable-tables-match-cell', 'selectable-tables-flash-cell'];

const NONE: Freeze = { rows: 0, columns: 0 };
/** Whether the browser can pin rows, read once. */
let freezes: boolean | undefined;
const px = (value: number) => `${Math.round(value * 64) / 64}px`;

/** A block of the table, as model.ts holds it. */
export interface PinBlock {
	readonly index: number;
	readonly dom: HTMLElement;
	readonly table: HTMLTableElement;
	readonly thead: HTMLTableSectionElement | null;
	readonly tbody: HTMLTableSectionElement;
}

/** What the pins need from the table. */
export interface PinHost {
	readonly view: EditorView | null;
	readonly pinBlocks: readonly (PinBlock | undefined)[];
	readonly blockCount: number;
	/** Body rows. */
	readonly count: number;
	readonly columns: number;
	/** The columns' widths as the blocks have them, and the table's width. */
	readonly appliedWidths: readonly number[];
	readonly tableWidth: string;
	readonly spacing: number;
	readonly startBorder: number;
	/** Whether the table moves sideways, by its scrollbar. */
	readonly slides: boolean;
	/** The header's line, then the first body rows' lines, `rows` of them. */
	lines(rows: number): string[];
	/** The header and some body rows, rendered as the table draws them, header first. */
	render(rows: string[]): HTMLTableRowElement[];
	release(tr: HTMLTableRowElement): void;
	/** The text a drawn row was drawn from. */
	textOf(tr: HTMLTableRowElement): string | undefined;
	/** A drawn body row's element, -1 being the header. */
	rowElement(row: number): HTMLTableRowElement | null;
	/** A body row's height as the table holds it, measured or estimated, -1 being the header. */
	rowHeight(row: number): number;
}

/** A copied row in the strip, for a row of the block, and what it was copied from. */
interface Mirror {
	tr: HTMLTableRowElement;
	text: string | undefined;
	height: string;
}

/** A small table of copied cells: the strip, or a corner. */
interface Part {
	box: HTMLDivElement;
	table: HTMLTableElement;
	colgroup: HTMLTableColElement;
	thead: HTMLTableSectionElement;
	tbody: HTMLTableSectionElement;
	applied: string;
}

/** What one block pins. */
interface Parts {
	strip: (Part & { mirrors: WeakMap<HTMLTableRowElement, Mirror>; real: WeakMap<HTMLTableRowElement, HTMLTableRowElement>; source: number }) | null;
	rail: { box: HTMLDivElement; copy: HTMLDivElement; slider: HTMLDivElement; table: Part; corner: Part | null; source: number } | null;
}

/** What placing the pins reads from the page. */
interface PinRead {
	pin: number;
	fit: { rows: boolean; columns: boolean };
	heights: number[];
	paint: Paint | null;
	blocks: {
		block: PinBlock;
		start: number;
		top: number;
		bottom: number;
		height: number;
		/** The real rows' heights, for the strip's copies. */
		rows: [HTMLTableRowElement, number][];
	}[];
}

function part(parent: HTMLElement, cls: string, holding: boolean): Part {
	const box = parent.createDiv(cls);
	box.setAttribute('aria-hidden', 'true');
	const table = box.createEl('table', { cls: 'table-editor' });
	table.toggleClass(HOLDS_CELL_CLASS, holding);
	const colgroup = table.createEl('colgroup');
	const thead = table.createEl('thead');
	const tbody = table.createEl('tbody');
	return { box, table, colgroup, thead, tbody, applied: '' };
}

function filler(): HTMLTableCellElement {
	return createEl('td', { cls: FILLER_CLASS });
}

/** A cell as drawn, for a copy: no open editor in it, and none of the marks the table draws on a cell. */
function cellCopy(cell: HTMLTableCellElement): HTMLTableCellElement {
	const copy = cell.cloneNode(true) as HTMLTableCellElement;
	copy.classList.remove(CELL_CLASS, ...MATCH_CLASSES);
	for (const box of Array.from(copy.querySelectorAll('.table-cell-wrapper'))) {
		if (box.querySelector('.cm-editor')) box.remove();
		else box.classList.remove(OPEN_TEXT_CLASS);
	}
	return copy;
}

/** A row's first `columns` cells, copied, and a hidden filler. */
function rowCopy(tr: HTMLTableRowElement, columns: number, row: number | null): HTMLTableRowElement {
	const copy = tr.cloneNode(false) as HTMLTableRowElement;
	copy.removeAttribute('aria-rowindex');
	copy.classList.remove(PINNED_ROW_CLASS);
	copy.style.removeProperty('top');
	copy.style.removeProperty('height');
	if (row !== null) copy.setAttribute(ROW_ATTRIBUTE, String(row));
	for (let column = 0; column < columns; column++) {
		const cell = tr.cells[column];
		copy.append(cell ? cellCopy(cell) : createEl('td'));
	}
	if (columns < tr.cells.length) copy.append(filler());
	return copy;
}

/** A spacer row's copy, as tall, across `columns`. */
function spacerCopy(tr: HTMLTableRowElement, columns: number): HTMLTableRowElement {
	const copy = createEl('tr', { cls: Array.from(tr.classList) });
	const td = copy.createEl('td');
	td.colSpan = Math.max(1, columns);
	return copy;
}

function setStyle(el: HTMLElement, name: string, value: string | null) {
	if (value === null) {
		if (el.style.getPropertyValue(name)) el.style.removeProperty(name);
	} else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** One table's frozen rows and columns. */
export class Pins {
	private freeze: Freeze = NONE;
	/** The frozen rows as rendered for the copies, header first, and the lines they were rendered from. */
	private source: { lines: string[]; rows: HTMLTableRowElement[]; generation: number } | null = null;
	private generation = 0;
	private paint: Paint | null = null;
	private fit = { rows: false, columns: false };
	private heights: number[] = [];
	private readonly parts = new WeakMap<PinBlock, Parts>();
	private readonly key = {};
	private pending = false;
	/** Measures asked for in a row while the colors can't be read. */
	private tries = 0;
	/** Whether anything may be on the blocks, to take off once nothing's frozen. */
	private marked = false;

	constructor(private readonly host: PinHost) {}

	/** Whether this editor can pin: on a computer, with scroll-driven animations, which `usesBars` checks too. */
	private able(view: EditorView): boolean {
		return usesBars(view) && (freezes ??= canFreeze());
	}

	/** What's frozen now, within the table's size, for the check script. */
	get frozen(): Freeze {
		return this.freeze;
	}

	/** What pins now, for the check script. */
	get pinned(): { rows: boolean; columns: boolean } {
		return { ...this.fit };
	}

	/**
	 * Reads the mark from the header line, and renders the frozen rows again for the copies if their text changed.
	 * Runs on each refresh of the table, which follows any change to its text: a few lines compared.
	 */
	refresh(): void {
		const host = this.host;
		const view = host.view;
		if (!view) return;
		const [header = ''] = host.lines(0);
		const freeze = this.able(view) ? frozenIn(readFreeze(header), host.count + 1, host.columns) : NONE;
		if (freeze.rows !== this.freeze.rows || freeze.columns !== this.freeze.columns) {
			this.freeze = freeze;
			this.fit = { rows: false, columns: false };
		}
		if (!freeze.rows && !freeze.columns) {
			this.drop();
			if (this.marked) this.clearAll();
			return;
		}
		this.marked = true;
		const lines = host.lines(Math.max(0, freeze.rows - 1));
		const source = this.source;
		if (!source || source.lines.length !== lines.length || source.lines.some((line, index) => line !== lines[index])) {
			this.drop();
			const rows = host.render(lines.slice(1));
			rows.forEach((tr, index) => tr.setAttribute(ROW_ATTRIBUTE, String(index)));
			this.source = { lines, rows, generation: ++this.generation };
		}
		this.measure();
	}

	/** The theme or the pane changed: the theme's colors are read again, before what pins is painted again. */
	forget(look: boolean): void {
		if (look) {
			this.paint = null;
			for (const block of this.host.pinBlocks) block?.dom.removeClass(PINS_CLASS);
		}
		this.measure();
	}

	/** A cell is selected, or none: the copies' tint goes with the table's, as Obsidian draws a selected cell. */
	holdCell(on: boolean): void {
		this.holding = on;
		for (const block of this.host.pinBlocks) {
			const parts = block ? this.parts.get(block) : null;
			for (const table of [parts?.strip?.table, parts?.rail?.table.table, parts?.rail?.corner?.table]) table?.toggleClass(HOLDS_CELL_CLASS, on);
		}
	}

	private holding = false;

	/** The block's rows were put in order: the strip's copies follow, in the same order. */
	arranged(block: PinBlock): void {
		const strip = this.parts.get(block)?.strip;
		// New copies take their real rows' heights on the next measure, in the same frame.
		if (strip && this.mirror(block, strip)) this.measure();
		// So does a frozen row of a table of one block drawn anew, which has to stick.
		else if (this.fit.rows && this.host.blockCount === 1) {
			for (let row = 0; row < this.freeze.rows - 1; row++) {
				if (this.host.rowElement(row)?.hasClass(PINNED_ROW_CLASS) === false) {
					this.measure();
					break;
				}
			}
		}
	}

	/** Places what pins on CodeMirror's next measure. */
	measure(): void {
		const view = this.host.view;
		if (!view || this.pending) return;
		if (!this.freeze.rows && !this.freeze.columns) return;
		this.pending = true;
		view.requestMeasure({
			key: this.key,
			read: () => {
				this.pending = false;
				return this.read();
			},
			write: (read) => this.write(read),
		});
	}

	destroy(): void {
		this.drop();
	}

	private drop(): void {
		if (!this.source) return;
		for (const tr of this.source.rows) this.host.release(tr);
		this.source = null;
	}

	/** A copied row's real row, for a press on it: a strip's copy of a drawn row. */
	realRow(tr: HTMLTableRowElement): HTMLTableRowElement | null {
		for (const block of this.host.pinBlocks) {
			const strip = block ? this.parts.get(block)?.strip : null;
			const real = strip?.real.get(tr);
			if (real) return real;
		}
		return null;
	}

	// Reading -------------------------------------------------------------------------------------------------------

	private read(): PinRead | null {
		const host = this.host;
		const view = host.view;
		if (!view || (!this.freeze.rows && !this.freeze.columns) || !this.source) return null;
		const shown = host.pinBlocks.filter((block): block is PinBlock => !!block?.dom.isConnected);
		if (!shown.length) return null;
		const scroller = view.scrollDOM;
		const pin = -(parseFloat(getComputedStyle(scroller).paddingTop) || 0);
		// The theme's colors, read from the table as drawn before anything pins: styles.css paints what pins over them.
		// The header comes from the first block, or from a copy of it, and the body's rows from a block with rows drawn.
		let paint = this.paint;
		if (!paint) {
			const drawn = (row: HTMLTableRowElement) => !row.hasClass(SPACER_CLASS);
			const block = shown.find((each) => !each.dom.hasClass(PINS_CLASS) && Array.from(each.tbody.rows).some(drawn));
			const head = block?.thead?.rows[0] ?? shown.map((each) => this.parts.get(each)?.rail?.table.thead.rows[0]).find(Boolean);
			if (block && head) paint = readPaint(block.dom, block.table, drawn, head);
		}
		const heights = this.readHeights(shown);
		const box = this.boxOf(shown[0]!);
		const boxStyle = box ? getComputedStyle(box) : null;
		const room = box && boxStyle ? box.clientWidth - (parseFloat(boxStyle.paddingLeft) || 0) - (parseFloat(boxStyle.paddingRight) || 0) : 0;
		const columns = this.freeze.columns ? stripWidth(host.appliedWidths, this.freeze.columns, host.spacing, host.startBorder) : 0;
		const rows = heights.reduce((sum, height) => sum + height, 0);
		const table = host.blockCount > 1 ? Infinity : shown[0]!.table.offsetHeight;
		const fit = pinsFit(this.freeze, { rows, table, pane: scroller.clientHeight, columns, room, slides: host.slides });
		const blocks = shown.map((block) => {
			const dom = block.dom;
			const table = block.table;
			const rtl = getComputedStyle(dom).direction === 'rtl';
			// Where the table sits in the block, as laid out: `offsetLeft` leaves out the table's sideways move.
			const wrapper = table.offsetParent === dom ? table : (table.parentElement ?? table);
			const left = table.offsetLeft + (wrapper === table ? 0 : wrapper.offsetLeft);
			const top = table.offsetTop + (wrapper === table ? 0 : wrapper.offsetTop);
			const start = rtl ? dom.clientWidth - left - table.offsetWidth : left;
			const strip = this.parts.get(block)?.strip;
			const real: [HTMLTableRowElement, number][] = [];
			if (strip && fit.columns) {
				for (const tr of Array.from(block.tbody.rows)) if (!tr.hasClass(SPACER_CLASS)) real.push([tr, tr.getBoundingClientRect().height]);
				const head = block.thead?.firstElementChild;
				if (head?.instanceOf(HTMLTableRowElement)) real.push([head, head.getBoundingClientRect().height]);
			}
			return { block, start, top, bottom: top + table.offsetHeight, height: dom.offsetHeight, rows: real };
		});
		return { pin, fit, heights, paint, blocks };
	}

	/**
	 * The frozen rows' heights, header first: the real rows of a table of one block, else a copy's, where they're in the
	 * page. A long table's first block leaves the page as the note scrolls on, and a copy may not be drawn yet: then the
	 * heights read before, or the table's own, measured or estimated.
	 */
	private readHeights(shown: PinBlock[]): number[] {
		const host = this.host;
		const count = this.freeze.rows;
		if (!count) return [];
		const whole = (list: number[]) => list.length === count && list.every((height) => height > 0);
		const real = () => Array.from({ length: count }, (_, index) => host.rowElement(index - 1)?.getBoundingClientRect().height ?? 0);
		if (host.blockCount === 1) {
			const heights = real();
			if (whole(heights)) return heights;
		} else {
			const rail = shown.map((block) => this.parts.get(block)?.rail).find((each) => each?.box.isConnected);
			const copied = rail ? Array.from(rail.table.table.rows).filter((tr) => !tr.hasClass(SPACER_CLASS)).map((tr) => tr.getBoundingClientRect().height) : [];
			if (whole(copied)) return copied;
			const heights = real();
			if (whole(heights)) return heights;
		}
		if (whole(this.heights)) return this.heights;
		return Array.from({ length: count }, (_, index) => host.rowHeight(index - 1));
	}

	/** The box the table shows in: its one block, or the box around its blocks. */
	private boxOf(block: PinBlock): HTMLElement | null {
		return this.host.blockCount > 1 ? block.dom.parentElement : block.dom;
	}

	// Writing -------------------------------------------------------------------------------------------------------

	private write(read: PinRead | null): void {
		const host = this.host;
		const view = host.view;
		if (!read || !view || !this.source) return;
		const fitChanged = read.fit.rows !== this.fit.rows || read.fit.columns !== this.fit.columns;
		this.fit = read.fit;
		this.paint = read.paint;
		this.heights = read.heights;
		setStyle(view.dom, PIN_VARIABLE, px(read.pin));
		const single = host.blockCount === 1;
		const tops = stickyTops(read.heights);
		const pinned = read.heights.reduce((sum, height) => sum + height, 0);
		let again = false;
		// Until the theme's colors are read, what pins is built but not painted, and read on the next measure.
		if (!read.paint) again = true;
		for (const { block, start, top, bottom, height, rows } of read.blocks) {
			const dom = block.dom;
			const any = (this.fit.rows || this.fit.columns) && !!read.paint;
			dom.toggleClass(PINS_CLASS, any);
			dom.toggleClass(PIN_ROWS_CLASS, this.fit.rows);
			dom.toggleClass(SINGLE_CLASS, single);
			for (const [name, value] of read.paint?.variables ?? []) setStyle(dom, name, any ? value : null);
			const parts = this.partsOf(block);
			this.realRows(block, single && this.fit.rows ? tops : null);
			// The strip of frozen columns.
			if (this.fit.columns) {
				parts.strip ??= { ...part(dom, STRIP_CLASS, this.holding), mirrors: new WeakMap(), real: new WeakMap(), source: -1 };
				const strip = parts.strip;
				this.shape(strip, this.freeze.columns);
				setStyle(strip.box, 'top', px(top));
				setStyle(strip.box, 'inset-inline-start', px(start));
				if (strip.source !== this.source.generation || fitChanged) {
					strip.source = this.source.generation;
					strip.thead.empty();
					const head = this.source.rows[0];
					if (block.index === 0 && head) strip.thead.append(rowCopy(head, this.freeze.columns, 0));
					strip.tbody.empty();
					strip.mirrors = new WeakMap();
					strip.real = new WeakMap();
				}
				if (this.mirror(block, strip)) again = true;
				for (const [tr, height] of rows) {
					const mirror = tr.parentElement === block.thead ? (strip.thead.firstElementChild as HTMLTableRowElement | null) : strip.mirrors.get(tr)?.tr;
					if (mirror) setStyle(mirror, 'height', px(height));
				}
				// In a table of one block the strip's frozen rows stick with the real ones.
				this.stickStrip(strip, single && this.fit.rows ? tops : null, block);
			} else if (parts.strip) {
				parts.strip.box.remove();
				parts.strip = null;
			}
			// A copy of the frozen rows, in a table of more blocks.
			if (!single && this.fit.rows) {
				const rail = (parts.rail ??= this.makeRail(dom));
				const { top: railTop, bottom: railBottom } = railOf({ first: block.index === 0, last: block.index === host.blockCount - 1, tableTop: top, tableBottom: bottom, height }, pinned);
				setStyle(rail.box, 'top', px(railTop));
				setStyle(rail.box, 'bottom', px(railBottom));
				setStyle(rail.slider, 'inset-inline-start', px(start));
				this.shape(rail.table, host.columns);
				setStyle(rail.table.table, 'width', host.tableWidth);
				if (rail.source !== this.source.generation) {
					rail.source = this.source.generation;
					const [head, ...body] = this.source.rows;
					rail.table.thead.empty();
					rail.table.tbody.empty();
					if (head) rail.table.thead.append(head.cloneNode(true));
					for (const tr of body) rail.table.tbody.append(tr.cloneNode(true));
					// Hidden, so the last frozen row isn't the table's last for a theme's rules.
					rail.table.tbody.append(createEl('tr', { cls: [SPACER_CLASS, PARITY_CLASS] }));
					if (rail.corner) rail.corner.applied = '';
				}
				if (this.fit.columns) {
					rail.corner ??= part(rail.copy, CORNER_CLASS, this.holding);
					const corner = rail.corner;
					this.shape(corner, this.freeze.columns);
					setStyle(corner.box, 'inset-inline-start', px(start));
					if (corner.applied !== `${rail.source}`) {
						corner.applied = `${rail.source}`;
						corner.thead.empty();
						corner.tbody.empty();
						const [head, ...body] = this.source.rows;
						if (head) corner.thead.append(rowCopy(head, this.freeze.columns, 0));
						body.forEach((tr, index) => corner.tbody.append(rowCopy(tr, this.freeze.columns, index + 1)));
						corner.tbody.append(createEl('tr', { cls: [SPACER_CLASS, PARITY_CLASS] }));
					}
					Array.from(corner.table.rows)
						.filter((tr) => !tr.hasClass(SPACER_CLASS))
						.forEach((tr, index) => setStyle(tr, 'height', px(read.heights[index] ?? 0)));
				} else if (rail.corner) {
					rail.corner.box.remove();
					rail.corner = null;
				}
			} else if (parts.rail) {
				parts.rail.box.remove();
				parts.rail = null;
			}
		}
		// What was just made is measured in the same frame: CodeMirror runs a measure asked for while it writes. Colors
		// that can't be read yet, with no rows drawn, wait for the rows: drawing them measures again.
		if ((again && (read.paint || this.tries++ < 2)) || (fitChanged && this.fit.rows && !single)) this.measure();
		if (read.paint) this.tries = 0;
	}

	private partsOf(block: PinBlock): Parts {
		let parts = this.parts.get(block);
		if (!parts) this.parts.set(block, (parts = { strip: null, rail: null }));
		return parts;
	}

	private makeRail(dom: HTMLElement): NonNullable<Parts['rail']> {
		const box = dom.createDiv(RAIL_CLASS);
		box.setAttribute('aria-hidden', 'true');
		const copy = box.createDiv(COPY_CLASS);
		const slider = copy.createDiv(SLIDER_CLASS);
		const table = part(slider, 'selectable-tables-copy-table', this.holding);
		return { box, copy, slider, table, corner: null, source: -1 };
	}

	/** Columns and width for a small table of the first `columns` columns. */
	private shape(target: Part, columns: number): void {
		const widths = this.host.appliedWidths.slice(0, columns);
		const key = widths.join(',');
		if (key === target.applied) return;
		target.applied = key;
		target.colgroup.empty();
		for (const width of widths) target.colgroup.createEl('col').style.width = `${width}px`;
		if (columns < this.host.columns) target.table.style.width = `${stripWidth(this.host.appliedWidths, columns, this.host.spacing, this.host.startBorder)}px`;
	}

	/** Sticks a table of one block's real frozen rows at their places, or takes them off. */
	private realRows(block: PinBlock, tops: number[] | null): void {
		const head = block.thead;
		if (head) setStyle(head, 'top', tops ? `calc(var(${PIN_VARIABLE}) + ${px(tops[0] ?? 0)})` : null);
		head?.toggleClass(PINNED_ROW_CLASS, !!tops);
		const count = this.freeze.rows;
		// The rows a table of one block has are all drawn, its first rows first.
		for (let row = 0; row < Math.max(count - 1, this.stuck); row++) {
			const tr = this.host.rowElement(row);
			if (!tr) continue;
			const on = !!tops && row < count - 1;
			tr.toggleClass(PINNED_ROW_CLASS, on);
			setStyle(tr, 'top', on ? `calc(var(${PIN_VARIABLE}) + ${px(tops[row + 1] ?? 0)})` : null);
		}
		this.stuck = tops ? count - 1 : 0;
	}

	/** How many body rows were stuck, to unstick when that changes. */
	private stuck = 0;

	private stickStrip(strip: NonNullable<Parts['strip']>, tops: number[] | null, block: PinBlock): void {
		const head = strip.thead;
		setStyle(head, 'top', tops ? `calc(var(${PIN_VARIABLE}) + ${px(tops[0] ?? 0)})` : null);
		head.toggleClass(PINNED_ROW_CLASS, !!tops);
		for (let row = 0; row < this.freeze.rows - 1; row++) {
			const real = this.host.rowElement(row);
			const mirror = real && block.tbody.contains(real) ? strip.mirrors.get(real)?.tr : null;
			if (!mirror) continue;
			mirror.toggleClass(PINNED_ROW_CLASS, !!tops);
			setStyle(mirror, 'top', tops ? `calc(var(${PIN_VARIABLE}) + ${px(tops[row + 1] ?? 0)})` : null);
		}
	}

	/**
	 * The strip's rows in the block's order: a copy of each drawn row's frozen cells, and of each spacer and hidden
	 * row, so the strip's rows line up with the table's and stripe alike. Only rows new to the block, or drawn again,
	 * are copied; the rest are kept, and only what's out of place moves.
	 */
	private mirror(block: PinBlock, strip: NonNullable<Parts['strip']>): boolean {
		const columns = this.freeze.columns;
		let made = false;
		const want: HTMLTableRowElement[] = [];
		for (const tr of Array.from(block.tbody.rows)) {
			const spacer = tr.hasClass(SPACER_CLASS);
			const text = spacer ? undefined : this.host.textOf(tr);
			let mirror = strip.mirrors.get(tr);
			if (!mirror || (!spacer && mirror.text !== text)) {
				mirror = { tr: spacer ? spacerCopy(tr, columns) : rowCopy(tr, columns, null), text, height: '' };
				strip.mirrors.set(tr, mirror);
				strip.real.set(mirror.tr, tr);
				if (!spacer) made = true;
			}
			if (spacer) {
				const height = (tr.firstElementChild as HTMLElement | null)?.style.height ?? '';
				if (height !== mirror.height) {
					mirror.height = height;
					(mirror.tr.firstElementChild as HTMLElement).style.height = height;
				}
			}
			want.push(mirror.tr);
		}
		const keep = new Set<Node>(want);
		for (let node = strip.tbody.firstChild; node; ) {
			const next = node.nextSibling;
			if (!keep.has(node)) node.remove();
			node = next;
		}
		let at = strip.tbody.firstChild;
		for (const tr of want) {
			if (tr === at) at = at.nextSibling;
			else strip.tbody.insertBefore(tr, at);
		}
		return made;
	}

	/** Takes everything off every block. */
	private clearAll(): void {
		const view = this.host.view;
		for (const block of this.host.pinBlocks) {
			if (!block) continue;
			block.dom.removeClass(PINS_CLASS, PIN_ROWS_CLASS, SINGLE_CLASS);
			for (const [name] of this.paint?.variables ?? []) block.dom.style.removeProperty(name);
			this.realRows(block, null);
			const parts = this.parts.get(block);
			parts?.strip?.box.remove();
			parts?.rail?.box.remove();
			this.parts.delete(block);
		}
		this.fit = { rows: false, columns: false };
		this.marked = false;
		void view;
	}
}
