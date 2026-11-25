import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { cellSelection } from '../editor/cells';
import { type Grid, sameCell, selectedTable } from '../editor/decide';
import { escapeCell, wholeTable } from '../editor/extension';
import { openCells, viewLayout } from '../editor/layout';
import type { Cell, Span } from '../editor/table-text';
import { clickOpens, type DragArea, type Extent, landing, lookAt, overPinned, zoneScroll } from './drag-sums';
import { profile, timed } from './profile';

/**
 * Dragging across cells to select a range of them, on the plugin's own table, as Obsidian's table does with its own range
 * (read from 1.15.1's cell `pointerdown`, `getClosestCell` and `selectCells`), on the range the Shift+arrows build (cells.ts,
 * `selectRange`): the pointer moves the range's far corner, the cell moved to last.
 *
 * A press that stays in one cell is a click, which selects the cell or opens it (`clickCell`): the range starts only once
 * the pointer reaches another cell. With the setting *Click to select a cell* on, the default, a press in the open cell
 * stays in its text, where its editor selects text however far the pointer goes. From then on, a frame loop finds the
 * cell drawn under the pointer, a pinned copy's being its real cell, kept to the table's part on the screen so a pointer
 * past its edge takes the nearest cell, and scrolls the note near the pane's bottom
 * or just under the pinned rows, and the table near its sides, as a dragged handle does (drag.ts). The table may be drawn
 * as blocks of 100 rows with only the rows near the pane in the page, so the range is a pair of cells, not cells in the
 * page, and the cell under the pointer is found among what's drawn on the screen. Let go, the range stays, and the click
 * the browser sends for the release opens no cell.
 */

/** What a drag across cells needs from the table: the model, in model.ts. */
export interface CellDragTable extends Span {
	readonly view: EditorView | null;
	readonly grid: Grid;
	/** The cell drawn at a point on the screen, a pinned copy's being its real cell, or null where none of the table's is. */
	cellAtPoint(x: number, y: number): Cell | null;
	/** Where the table and what pins it lie on the screen, measured from the block nearest `y`. */
	dragArea(y: number): DragArea | null;
	/** The row at a height from the table's top, 0 being the header. */
	rowAtHeight(y: number): Extent;
	/** The table's left on the screen, its width, and its columns from its left. */
	columnLayout(): { left: number; width: number; columns: Extent[] } | null;
	scrollSideways(dx: number): void;
}

/** The drag going on, at most one at a time. */
let current: CellDrag | null = null;

/**
 * The setting *Click to select a cell*, set by preview.ts from the plugin's data: a click on a cell selects it, and a
 * double-click opens it. Off, a click opens a cell, as in Obsidian.
 */
let clickSelects = true;

export function setClickSelects(on: boolean): void {
	clickSelects = on;
}

export function clickSelectsCells(): boolean {
	return clickSelects;
}

/**
 * A press on a cell of the plugin's table, with the left button of a mouse or a pen: a drag across cells, if the pointer
 * reaches another one. `inOpenCell` is a press in the open cell's own text, where the editor selects text until then. With
 * Shift, the range runs at once from the selected cell, the range's first cell, or the open cell, to the one pressed.
 */
export function pressCell(table: CellDragTable, event: PointerEvent, cell: Cell, inOpenCell: boolean): void {
	const view = table.view;
	if (!view || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return;
	current?.end();
	// The open cell's text is the text layer: a drag from it, or from the cell's space around it, never makes a range.
	if (clickSelects && isOpen(view, table, cell)) return;
	const anchor = event.shiftKey && !inOpenCell ? anchorIn(view, table) : null;
	current = new CellDrag(table, view, event, within(table.grid, cell), anchor);
}

/**
 * A click on a cell that no drag took: with the setting on, it selects the cell, as a drag's way in does, unless it
 * opens it (`clickOpens`). Nothing scrolls, so a double-click's second press lands on the same cell. A tap gives the
 * note no focus, which would bring up a phone's keyboard: the tap that opens the cell does. Says whether it selected
 * the cell; false leaves the click to open it.
 */
export function clickCell(table: CellDragTable, event: MouseEvent, cell: Cell, touch: boolean): boolean {
	const view = table.view;
	if (!view) return false;
	const cells = view.plugin(cellSelection);
	const selectedAlone = !!cells?.selected && !cells.anchor && sameCell(cells.selected, cell) && selectedTable(view.state, viewLayout(view))?.from === table.from;
	if (clickOpens({ selects: clickSelects, count: event.detail, open: isOpen(view, table, cell), selectedAlone })) return false;
	current?.end();
	return enter(view, table, cell, cell, !touch);
}

/** Four quick clicks on a cell, as in Obsidian's table: every cell of the table is selected. */
export function selectEvery(table: CellDragTable): void {
	const view = table.view;
	const { rows } = table.grid;
	if (!view || !rows) return;
	current?.end();
	enter(view, table, { row: 0, column: 0 }, { row: rows - 1, column: Math.max(0, table.grid.columns(rows - 1) - 1) });
}

/** Whether a drag across cells is going on, for the check script. */
export function draggingCells(): boolean {
	return !!current;
}

/** A cell kept within the table: a hidden filler cell, which ends a pinned copy's row, is the row's last cell. */
function within(grid: Grid, { row, column }: Cell): Cell {
	const r = Math.max(0, Math.min(grid.rows - 1, row));
	return { row: r, column: Math.max(0, Math.min(grid.columns(r) - 1, column)) };
}

/** Whether a cell of this table is the note's open cell. */
function isOpen(view: EditorView, table: Span, cell: Cell): boolean {
	const open = openCells.get(view);
	return !!open && open.note === view && open.table()?.from === table.from && sameCell(open.cell, cell);
}

/** Where Shift with a press extends from on this table: the range's first cell, the selected cell, or the open one. */
function anchorIn(view: EditorView, table: Span): Cell | null {
	const cells = view.plugin(cellSelection);
	if (cells?.selected && selectedTable(view.state, viewLayout(view))?.from === table.from) return cells.anchor ?? cells.selected;
	const open = openCells.get(view);
	return open && open.note === view && open.table()?.from === table.from ? open.cell : null;
}

/**
 * Selects the range from `anchor` to `head`: an open cell closes first, as Escape closes it, and the table is selected
 * whole, in one step, the range's way in, as for a selected cell. Nothing scrolls: the pointer is on the cell already.
 * The note takes the keyboard unless `focus` is false. Says whether the range is there.
 */
function enter(view: EditorView, table: Span, anchor: Cell, head: Cell, focus = true): boolean {
	const open = openCells.get(view);
	if (open && open.note === view && !escapeCell(open.view)) return false;
	const { from, to } = table;
	const { main } = view.state.selection;
	// CodeMirror puts a pointer's selection in the page even without focus, which focuses the note: a tap's is a plain one.
	if (main.from !== from || main.to !== to) view.dispatch({ selection: wholeTable({ from, to }, false), userEvent: focus ? 'select.pointer' : 'select' });
	// The press's own default is prevented, so the keyboard comes to the note here, for Copy, Escape and the arrows.
	if (focus && !view.hasFocus) view.contentDOM.focus({ preventScroll: true });
	const cells = view.plugin(cellSelection);
	if (!cells) return false;
	cells.selectRange(anchor, head, undefined, false);
	return true;
}

/** The browser's click for a release that ended a range: no cell opens, and the table isn't selected again. */
function swallowClick(win: Window): void {
	const swallow = (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};
	win.addEventListener('click', swallow, { capture: true, once: true });
	// The click comes in the same task as the release, if at all.
	win.setTimeout(() => win.removeEventListener('click', swallow, true), 0);
}

class CellDrag {
	private readonly win: Window;
	private readonly doc: Text;
	private readonly pointerId: number;
	private readonly anchor: Cell;
	private head: Cell;
	private x: number;
	private y: number;
	private started = false;
	/** Whether the pointer is still followed: Escape, a menu, or a change to the note from elsewhere stop that. */
	private following = true;
	private frame = 0;
	private last = 0;
	private done = false;

	constructor(
		private readonly table: CellDragTable,
		private readonly view: EditorView,
		event: PointerEvent,
		private readonly pressed: Cell,
		extendFrom: Cell | null,
	) {
		this.win = view.dom.ownerDocument.defaultView ?? window;
		this.doc = view.state.doc;
		this.pointerId = event.pointerId;
		this.anchor = extendFrom ?? pressed;
		this.head = pressed;
		this.x = event.clientX;
		this.y = event.clientY;
		this.win.addEventListener('pointermove', this.onMove, true);
		this.win.addEventListener('pointerup', this.onUp, true);
		this.win.addEventListener('pointercancel', this.onCancel, true);
		this.win.addEventListener('keydown', this.onKey, true);
		this.win.addEventListener('contextmenu', this.onMenu, true);
		// Shift with a press: the range is there at once, and a drag from here moves its far corner.
		if (extendFrom) this.begin(pressed);
	}

	private readonly onMove = (event: PointerEvent) => {
		if (event.pointerId !== this.pointerId || !this.following) return;
		this.x = event.clientX;
		this.y = event.clientY;
		// The cell under the pointer is found once a frame, however many moves the frame has.
		if (!this.frame) this.frame = this.win.requestAnimationFrame(this.tick);
	};

	private readonly onUp = (event: PointerEvent) => {
		if (event.pointerId !== this.pointerId) return;
		// A release before the frame came: the cell it's on counts.
		if (this.following && this.view.state.doc === this.doc) timed('drag', () => this.follow(0, false));
		const started = this.started;
		this.end();
		if (started) swallowClick(this.win);
	};

	private readonly onCancel = (event: PointerEvent) => {
		if (event.pointerId === this.pointerId) this.end();
	};

	/** Escape leaves the range to the keys, which take it back to the cell moved to last: the pointer isn't followed. */
	private readonly onKey = (event: KeyboardEvent) => {
		if (event.key === 'Escape') this.stop();
	};

	private readonly onMenu = () => {
		this.stop();
	};

	private readonly tick = (time: number) => {
		this.frame = 0;
		if (!this.following) return;
		// A change to the note from anywhere else, Sync or a second pane say, ends the drag, as it ends a handle's: the range
		// keeps its rows and columns where they still are.
		if (this.view.state.doc !== this.doc || !this.view.dom.isConnected) {
			this.stop();
			return;
		}
		const dt = this.last ? Math.min(50, time - this.last) : 16;
		this.last = time;
		if (profile.on) profile.frames++;
		const scrolls = timed('drag', () => this.follow(dt, true));
		// While the pointer is in an edge's zone the loop runs on its own, the note or the table moving under it.
		if (scrolls) this.frame = this.win.requestAnimationFrame(this.tick);
		else this.last = 0;
	};

	/**
	 * Finds the cell under the pointer and moves the range's far corner there, then scrolls near an edge, once the range has
	 * started. Everything is read before anything is written, so the frame forces no layout of its own: the cell is found
	 * before the note scrolls, and the next frame finds the one the scroll brought under the pointer. Says whether it scrolled.
	 */
	private follow(dt: number, scroll: boolean): boolean {
		const { table, view } = this;
		const area = table.dragArea(this.y);
		if (!area) return false;
		const look = lookAt(area, this.x, this.y);
		const cell = this.cellAt(area, look.x, look.y);
		const { dx, dy } = scroll && this.started ? zoneScroll(area, this.x, this.y, dt, this.win.devicePixelRatio || 1) : { dx: 0, dy: 0 };
		const scroller = view.scrollDOM;
		const from = dy ? scroller.scrollTop : 0;
		const most = dy ? scroller.scrollHeight - scroller.clientHeight : 0;
		if (cell) {
			if (!this.started) {
				if (!sameCell(cell, this.pressed)) this.begin(cell);
			} else if (!sameCell(cell, this.head)) {
				this.head = cell;
				view.plugin(cellSelection)?.selectRange(this.anchor, cell, undefined, false);
			}
		}
		if (dy) scroller.scrollTop = Math.max(0, Math.min(most, from + dy));
		if (dx) table.scrollSideways(dx);
		return !!(dx || dy);
	}

	/**
	 * The cell drawn at a point, `x`, `y` being the pointer kept within the table's part on the screen: the cell right under
	 * the pointer, where one of the table's is drawn, or else the one at the point kept within, a pinned copy's being its real
	 * cell; else, in the space between cells or over a row not drawn yet, the row and column the point is in, as laid out. On
	 * what pins, a point between its cells keeps the cell already reached, since the rows passing under aren't what shows
	 * there. The pointer comes first because the point kept within can be a row off: beside a status bar floating over the
	 * pane's bottom, it's kept above the bar across the whole table, and a click on a row cut off there would reach the row
	 * above it.
	 */
	private cellAt(area: DragArea, x: number, y: number): Cell | null {
		const { table } = this;
		const moved = x !== this.x || y !== this.y;
		const drawn = (moved ? table.cellAtPoint(this.x, this.y) : null) ?? table.cellAtPoint(x, y);
		if (drawn) return within(table.grid, drawn);
		if (overPinned(area, x, y)) return null;
		const columns = table.columnLayout();
		const column = columns && landing(columns.columns, x - columns.left, columns.width);
		if (!column) return null;
		return within(table.grid, { row: table.rowAtHeight(y - area.table.top).index, column: column.index });
	}

	/** The pointer reached another cell, or Shift was held: the range starts, from where it's anchored to `head`. */
	private begin(head: Cell): void {
		if (!enter(this.view, this.table, this.anchor, head)) {
			this.end();
			return;
		}
		this.started = true;
		this.head = head;
	}

	/** Stops following the pointer; its release is still heard, so its click opens no cell. */
	private stop(): void {
		this.following = false;
		this.win.cancelAnimationFrame(this.frame);
		this.frame = 0;
	}

	end(): void {
		if (this.done) return;
		this.done = true;
		this.stop();
		if (current === this) current = null;
		this.win.removeEventListener('pointermove', this.onMove, true);
		this.win.removeEventListener('pointerup', this.onUp, true);
		this.win.removeEventListener('pointercancel', this.onCancel, true);
		this.win.removeEventListener('keydown', this.onKey, true);
		this.win.removeEventListener('contextmenu', this.onMenu, true);
	}
}
