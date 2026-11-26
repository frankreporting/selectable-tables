import { setIcon, setTooltip } from 'obsidian';
import type { Cell, Span } from '../editor/table-text';
import type { CellDragTable } from './cell-drag';
import type { DragTable } from './drag';

/**
 * Obsidian's drag handles and + buttons, on the plugin's own table, as its table widget makes them (read from 1.15.1's
 * `render` and `createDragHandle`): a handle for dragging a row in each row's first cell, one for dragging a column in
 * each header cell, and in the table's box, a + below the table that adds a row and one at its side that adds a
 * column. They carry Obsidian's classes, so its look and a theme's land on them, and they show by CSS alone, on hover
 * on a computer, and for the selected or open cell's row and column on a phone or tablet.
 */

export const ROW_GRIP_CLASS = 'table-row-drag-handle';
export const COLUMN_GRIP_CLASS = 'table-col-drag-handle';
export const GRIPS = `.${ROW_GRIP_CLASS}, .${COLUMN_GRIP_CLASS}`;
export const ROW_BUTTON_CLASS = 'table-row-btn';
export const COLUMN_BUTTON_CLASS = 'table-col-btn';
export const BUTTONS = `.${ROW_BUTTON_CLASS}, .${COLUMN_BUTTON_CLASS}`;

/** Obsidian's classes for the cells whose handles show on a phone or tablet: the selected or open cell's row's and column's. */
export const ACTIVE_ROW_CLASS = 'mod-active-row-handle';
export const ACTIVE_COLUMN_CLASS = 'mod-active-col-handle';

/** A handle of each kind, made once per window and copied into each row drawn: a row is drawn often, an icon made rarely. */
const templates = new WeakMap<Document, { row: HTMLElement; column: HTMLElement }>();

function templatesFor(doc: Document): { row: HTMLElement; column: HTMLElement } {
	let made = templates.get(doc);
	if (made) return made;
	const grip = (cls: string, icon: string) => {
		const el = doc.createElement('div');
		el.className = cls;
		setIcon(el, icon);
		// Obsidian's swipes on a phone, which open the sidebars, leave a handle's drag alone.
		el.dataset.ignoreSwipe = 'true';
		return el;
	};
	made = { row: grip(ROW_GRIP_CLASS, 'lucide-grip-vertical'), column: grip(COLUMN_GRIP_CLASS, 'lucide-grip-horizontal') };
	templates.set(doc, made);
	return made;
}

/** Puts the handles in a drawn row: a column's in each header cell, then a row's in the first cell, as Obsidian orders them. */
export function addGrips(tr: HTMLTableRowElement, header: boolean): void {
	const { row, column } = templatesFor(tr.ownerDocument);
	const cells = Array.from(tr.cells);
	if (header) for (const cell of cells) cell.appendChild(column.cloneNode(true));
	cells[0]?.appendChild(row.cloneNode(true));
}

/** The kind of handle an element is in, if it's in one. */
export function gripOf(target: Element): { grip: HTMLElement; kind: 'row' | 'column' } | null {
	const grip = target.closest<HTMLElement>(GRIPS);
	return grip ? { grip, kind: grip.classList.contains(ROW_GRIP_CLASS) ? 'row' : 'column' } : null;
}

/**
 * The + buttons in a block's box around its table. Every block has both: the + below shows only on the table's last
 * block (styles.css), and the + at the side runs each block's height, so together they run the table's.
 */
export function addButtons(wrapper: HTMLElement, add: (what: 'row' | 'column') => void): void {
	const button = (cls: string, tooltip: string, what: 'row' | 'column') => {
		const el = wrapper.createDiv(cls);
		setIcon(el, 'lucide-plus');
		setTooltip(el, tooltip);
		// The keys stay where they are on a press, as on Obsidian's buttons.
		el.addEventListener('mousedown', (event) => event.preventDefault());
		el.addEventListener('click', (event) => {
			event.preventDefault();
			add(what);
		});
	};
	button(ROW_BUTTON_CLASS, 'Add row below', 'row');
	button(COLUMN_BUTTON_CLASS, 'Add column to the right', 'column');
}

/**
 * What a press on a handle, a + button or a cell does, set by tables.ts: drag.ts, cell-drag.ts and table-commands.ts
 * reach the note's editor commands, which the table's drawing has no need of.
 */
export interface TableControls {
	/** A press on a handle: a drag, or a click that shows its menu. */
	press(table: DragTable, event: PointerEvent, grip: HTMLElement, kind: 'row' | 'column'): void;
	/** A + button: a row or a column at the table's end. */
	add(table: DragTable & Span, what: 'row' | 'column'): void;
	/** A press on a cell, or in the open cell's text: a drag across cells once the pointer reaches another cell. */
	pressCell(table: CellDragTable, event: PointerEvent, cell: Cell, inOpenCell: boolean): void;
	/** A click on a cell no drag took: whether it selected the cell, with the setting *Click to select a cell* on; else it opens. */
	clickCell(table: CellDragTable, event: MouseEvent, cell: Cell, touch: boolean): boolean;
	/** Four quick clicks on a cell: every cell of the table selected. */
	selectEvery(table: CellDragTable): void;
}

let controls: TableControls | null = null;

export function setTableControls(set: TableControls | null): void {
	controls = set;
}

export function tableControls(): TableControls | null {
	return controls;
}
