import type { EditorView } from '@codemirror/view';
import type { Text } from '@codemirror/state';
import { selectAt } from '../editor/freeze-commands';
import type { Cell, Span } from '../editor/table-text';
import { DRAG_START, edgeScroll, type Extent, landing, targetEdge } from './drag-sums';
import { profile, timed } from './profile';
import { gripMenu, moveTo } from './table-commands';

/**
 * Dragging a row or a column by its handle, on the plugin's own table, as Obsidian's table drags them (read from
 * 1.15.1's `createDragHandle`): a frame loop that scrolls the note near the pane's top or bottom, or the table near its
 * sides, moves the handle with the pointer, and draws Obsidian's blue line where the row or column will land; let go,
 * and it moves there, in one change that Undo takes back alone.
 *
 * The table may be drawn as blocks of 100 rows with only the rows near the pane in the page, so the row being dragged
 * can leave the page as the note scrolls: the handle that moves is a copy, put in the first cell of the row under the
 * pointer, and the landing is worked out from the table's heights, not from rows in the page. A press that doesn't
 * move is a click, which shows the handle's menu (Obsidian selects the row or column as a range of cells, which the
 * plugin's table doesn't have yet).
 */

/** What a drag needs from the table: the model, in model.ts. */
export interface DragTable extends Span {
	readonly view: EditorView | null;
	readonly rtl: boolean;
	/** The cell a handle is in, a pinned copy's being its real cell. */
	cellAt(target: Element): Cell | null;
	/** A cell's element, if its row is drawn. */
	cellElement(cell: Cell): HTMLTableCellElement | null;
	/** The table's top on the screen, as laid out, measured from the block nearest `y`, and its height. */
	rowLayout(y: number): { top: number; height: number } | null;
	/** The row at a height from the table's top, 0 being the header, and where it starts and ends. */
	rowAtHeight(y: number): Extent;
	/** The table's left on the screen, its width, and its columns from its left. */
	columnLayout(): { left: number; width: number; columns: Extent[] } | null;
	/** The box of a block in the page holding a place on the screen, else the nearest one's. */
	wrapperAt(y: number): HTMLElement | null;
	/** The boxes of the blocks in the page, each around its block's table. */
	wrappers(): HTMLElement[];
	/** The box the table scrolls sideways in, on the screen. */
	sidewaysBox(): DOMRect | null;
	scrollSideways(dx: number): void;
	setDragging(on: boolean): void;
}

/** On the copy of the handle that follows the pointer (styles.css). */
const DRAGGED_CLASS = 'selectable-tables-dragged';

/** The drag going on, at most one at a time. */
let current: Drag | null = null;

/** A press on a handle: starts following the pointer, until it's let go, cancelled, or the note changes. */
export function startDrag(table: DragTable, event: PointerEvent, grip: HTMLElement, kind: 'row' | 'column'): void {
	const view = table.view;
	const cell = table.cellAt(grip);
	if (!view || !cell || !event.isPrimary || event.button !== 0) return;
	// No caret, no selection of text, and the keys stay in the note.
	event.preventDefault();
	current?.cancel();
	current = new Drag(table, view, event, grip, kind, cell);
}

class Drag {
	private readonly win: Window;
	private readonly origin: number;
	private readonly doc: Text;
	/** The pointer's offset from the handle's middle as it was pressed, along the drag. */
	private readonly offset: number;
	/** The handle's size along the drag, and across it for a row's: the copy takes the same. */
	private readonly length: number;
	private readonly width: number;
	private x: number;
	private y: number;
	private readonly startX: number;
	private readonly startY: number;
	private started = false;
	private frame = 0;
	private last = 0;
	private land: Extent | null = null;
	private copy: HTMLElement | null = null;
	private readonly lines: HTMLElement[] = [];
	private done = false;

	constructor(
		private readonly table: DragTable,
		private readonly view: EditorView,
		event: PointerEvent,
		private readonly grip: HTMLElement,
		private readonly kind: 'row' | 'column',
		private readonly cell: Cell,
	) {
		this.win = grip.ownerDocument.defaultView ?? window;
		this.origin = kind === 'row' ? cell.row : cell.column;
		this.doc = view.state.doc;
		const rect = grip.getBoundingClientRect();
		this.x = this.startX = event.clientX;
		this.y = this.startY = event.clientY;
		this.offset = kind === 'row' ? event.clientY - (rect.top + rect.bottom) / 2 : event.clientX - (rect.left + rect.right) / 2;
		this.length = kind === 'row' ? rect.height : rect.width;
		this.width = kind === 'row' ? rect.width : rect.height;
		this.pointerId = event.pointerId;
		this.win.addEventListener('pointermove', this.onMove, true);
		this.win.addEventListener('pointerup', this.onUp, true);
		this.win.addEventListener('pointercancel', this.onCancel, true);
		this.win.addEventListener('keydown', this.onKey, true);
		this.win.addEventListener('contextmenu', this.onMenu, true);
		// The row or column shows as its cell selected, as Obsidian selects it as a range: an open cell closes first.
		selectAt(view, { table: () => table, cell: kind === 'row' ? { row: cell.row, column: 0 } : { row: 0, column: cell.column } });
		this.frame = this.win.requestAnimationFrame(this.tick);
	}

	private readonly pointerId: number;

	private readonly onMove = (event: PointerEvent) => {
		if (event.pointerId !== this.pointerId) return;
		this.x = event.clientX;
		this.y = event.clientY;
		if (!this.started && Math.hypot(this.x - this.startX, this.y - this.startY) >= DRAG_START) this.begin();
	};

	private readonly onUp = (event: PointerEvent) => {
		if (event.pointerId !== this.pointerId) return;
		const { started, land, origin, kind, table, view } = this;
		const changed = view.state.doc !== this.doc;
		this.end();
		if (changed) return;
		if (!started) {
			gripMenu(view, { table: () => table, cell: this.cell }, kind, event);
			return;
		}
		if (land && land.index !== origin) moveTo(view, table, kind, origin, land.index);
	};

	private readonly onCancel = (event: PointerEvent) => {
		if (event.pointerId === this.pointerId) this.cancel();
	};

	private readonly onKey = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		this.cancel();
	};

	/**
	 * A menu before the drag started: a long press on a phone, which Obsidian turns into a right-click, showing the
	 * handle's menu. Letting go then shows no second one.
	 */
	private readonly onMenu = () => {
		if (!this.started) this.end();
	};

	/** The pointer moved far enough: from now on it's a drag. Obsidian's class hides the other handles. */
	private begin(): void {
		this.started = true;
		this.table.setDragging(true);
		this.copy = this.grip.cloneNode(true) as HTMLElement;
		this.copy.addClass(DRAGGED_CLASS);
		this.copy.style.setProperty(this.kind === 'row' ? 'height' : 'width', `${this.length}px`);
	}

	private readonly tick = (time: number) => {
		this.frame = this.win.requestAnimationFrame(this.tick);
		// A change to the note from anywhere else, Sync or a second pane say, cancels the drag: its rows aren't the ones
		// the pointer is over any more.
		if (this.view.state.doc !== this.doc || !this.view.dom.isConnected) {
			this.cancel();
			return;
		}
		const dt = this.last ? time - this.last : 16;
		this.last = time;
		if (!this.started) return;
		if (profile.on) profile.frames++;
		timed('drag', () => {
			if (this.kind === 'row') this.placeRow(dt);
			else this.placeColumn(dt);
		});
	};

	/**
	 * Near the pane's top or bottom the note scrolls; the landing row, the line on its edge, and the handle's copy at
	 * the pointer, kept within the table. Everything is read before anything is written, so the frame forces no layout of
	 * its own: the places are read before the note scrolls, and what's placed in the note moves with it.
	 */
	private placeRow(dt: number): void {
		const scroller = this.view.scrollDOM;
		const layout = this.table.rowLayout(this.y);
		if (!layout) return;
		const { dy } = edgeScroll(scroller.getBoundingClientRect(), this.x, this.y, dt, this.win.devicePixelRatio || 1);
		const from = scroller.scrollTop;
		const scroll = dy ? Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, from + dy)) - from : 0;
		// Where the table's top will be once the note has scrolled.
		const top = layout.top - scroll;
		const middle = this.y - this.offset;
		const land = this.table.rowAtHeight(Math.max(0, Math.min(layout.height, middle - top)));
		this.land = land;
		const edge = targetEdge(land, this.origin);
		const wrapper = edge === null ? null : this.table.wrapperAt(layout.top + edge);
		const line = wrapper && { left: 0, top: layout.top + edge! - wrapper.getBoundingClientRect().top, width: wrapper.querySelector('table')?.offsetWidth ?? 0 };
		// The copy goes in the first cell of the row under it, which is in the page, being on the screen.
		const copyTop = Math.max(top, Math.min(top + layout.height - this.length, middle - this.length / 2));
		const host = this.table.cellElement({ row: this.table.rowAtHeight(copyTop + this.length / 2 - top).index, column: 0 });
		const hostTop = host ? host.getBoundingClientRect().top + host.clientTop - scroll : 0;
		if (scroll) scroller.scrollTop = from + scroll;
		this.placeLines(wrapper && line ? [wrapper] : [], () => line!);
		this.placeCopy(host, () => ({ top: copyTop - hostTop }));
	}

	/**
	 * Near the table's sides the table moves sideways; the landing column, the line on its edge in each block in the
	 * page, and the handle's copy at the pointer.
	 */
	private placeColumn(dt: number): void {
		const box = this.table.sidewaysBox();
		const { dx } = box ? edgeScroll(box, this.x, this.y, dt, this.win.devicePixelRatio || 1) : { dx: 0 };
		if (dx) this.table.scrollSideways(dx);
		const layout = this.table.columnLayout();
		if (!layout) return;
		const middle = this.x - this.offset;
		const land = landing(layout.columns, middle - layout.left, layout.width);
		this.land = land;
		// Toward the table's first column, the line is on the landing column's start edge, its left or, in a table that
		// runs right to left, its right; else on its end edge.
		const rtl = this.table.rtl;
		const x = !land || land.index === this.origin ? null : land.index < this.origin === !rtl ? land.start : land.end;
		this.placeLines(x === null ? [] : this.table.wrappers(), (wrapper) => {
			const table = wrapper.querySelector('table');
			return { left: (table?.offsetLeft ?? 0) + x!, top: table?.offsetTop ?? 0, height: table?.offsetHeight ?? 0 };
		});
		const left = Math.max(layout.left, Math.min(layout.left + layout.width - this.length, middle - this.length / 2));
		const pressed = this.grip.isConnected ? this.grip.parentElement : null;
		const host = pressed ?? this.table.cellElement({ row: 0, column: this.origin });
		this.placeCopy(host, (cell) => ({ left: left - cell.getBoundingClientRect().left - cell.clientLeft }));
	}

	/** Obsidian's blue line, in each block's box that shows it: `place` gives where, in that box. */
	private placeLines(wrappers: (HTMLElement | null)[], place: (wrapper: HTMLElement) => { left: number; top: number; width?: number; height?: number }): void {
		const hosts = wrappers.filter((wrapper): wrapper is HTMLElement => !!wrapper);
		while (this.lines.length > hosts.length) this.lines.pop()!.remove();
		hosts.forEach((wrapper, i) => {
			let line = this.lines[i];
			if (!line) {
				line = createDiv(`table-drag-target mod-${this.kind === 'row' ? 'row' : 'col'}`);
				this.lines.push(line);
			}
			if (line.parentElement !== wrapper) wrapper.appendChild(line);
			const { left, top, width, height } = place(wrapper);
			line.style.left = `${left}px`;
			line.style.top = `${top}px`;
			if (width !== undefined) line.style.width = `${width}px`;
			if (height !== undefined) line.style.height = `${height}px`;
		});
	}

	private placeCopy(host: HTMLElement | null, place: (host: HTMLElement) => { top?: number; left?: number }): void {
		const copy = this.copy;
		if (!copy) return;
		if (!host?.isConnected) {
			copy.remove();
			return;
		}
		if (copy.parentElement !== host) host.appendChild(copy);
		const { top, left } = place(host);
		if (top !== undefined) copy.style.top = `${top}px`;
		if (left !== undefined) copy.style.left = `${left}px`;
	}

	cancel(): void {
		this.end();
	}

	private end(): void {
		if (this.done) return;
		this.done = true;
		if (current === this) current = null;
		this.win.cancelAnimationFrame(this.frame);
		this.win.removeEventListener('pointermove', this.onMove, true);
		this.win.removeEventListener('pointerup', this.onUp, true);
		this.win.removeEventListener('pointercancel', this.onCancel, true);
		this.win.removeEventListener('keydown', this.onKey, true);
		this.win.removeEventListener('contextmenu', this.onMenu, true);
		this.copy?.remove();
		this.copy = null;
		for (const line of this.lines) line.remove();
		this.lines.length = 0;
		if (this.started) this.table.setDragging(false);
	}
}

/** Whether a handle is being dragged, for the check script. */
export function dragging(): boolean {
	return !!current;
}
