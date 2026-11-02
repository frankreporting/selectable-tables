/**
 * What a theme paints behind a frozen table's cells. Frozen cells have to be solid, since cells pass under
 * them, so each is painted with what shows there unfrozen: its own color, over its row's, its header's or
 * body's, the table's, the widget's and the note's. This reads those from the page, so it follows whatever
 * a theme does, with no list of themes. It only reads: styles.css paints frozen cells over the theme's own
 * colors, so freeze.ts reads a table before marking it.
 */

/**
 * On the widget, what odd and even cells are painted with: the header's, and the body's odd and even rows'.
 * Odd and even are what the default theme and the others stripe by. styles.css hands them to the rows.
 */
const CELL_VARIABLES = [
	['--selectable-tables-head-odd-cell', '--selectable-tables-head-even-cell'],
	['--selectable-tables-odd-row-odd-cell', '--selectable-tables-odd-row-even-cell'],
	['--selectable-tables-even-row-odd-cell', '--selectable-tables-even-row-even-cell'],
] as const;
/** On the widget: the note's color, the first solid one behind the table, under every frozen cell. */
const PAGE_VARIABLE = '--selectable-tables-page';
/** On the widget: any see-through colors between the note's and the table, as layers. */
const BEHIND_VARIABLE = '--selectable-tables-behind';
/** On the widget: the same colors as shadows, for the first frozen column to cover the strip beside it. */
const STRIP_VARIABLE = '--selectable-tables-strip';
/** From styles.css, on the widget: how far the strip's shadows reach, and to which side. */
const STRIP_OFFSET = 'var(--selectable-tables-strip-offset)';
/** When nothing behind the table reads as solid. */
const PAGE_FALLBACK = 'var(--background-primary)';

export interface Paint {
	/** Whether the theme collapses the table's borders, which then stay behind when cells move. */
	collapsed: boolean;
	/** Custom properties for the widget, with their values. */
	variables: [name: string, value: string][];
	/**
	 * Whether this holds for any table drawn in the same place: every kind of row and cell was there to read,
	 * none was a table's last row or a row's last cell, and none was under the pointer or holding an open
	 * cell, all of which a theme can paint differently.
	 */
	typical: boolean;
}

const COLOR = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)$/;

/**
 * How opaque a computed color is, from 0 to 1, or NaN for a form this doesn't read, such as a mix the
 * browser keeps unresolved. A color with no alpha is solid.
 */
export function opacity(color: string): number {
	const value = color.trim().toLowerCase();
	if (value === 'transparent') return 0;
	const found = COLOR.exec(value);
	if (!found) return NaN;
	const [, name = '', args = ''] = found;
	const [channels = '', slashed] = args.split('/');
	let alpha = slashed?.trim();
	if (alpha === undefined && /^(rgb|hsl)a?$/.test(name)) {
		const parts = channels.split(',');
		if (parts.length === 4) alpha = parts[3]?.trim();
	}
	if (alpha === undefined) return 1;
	if (alpha === 'none') return 0;
	const amount = parseFloat(alpha);
	if (Number.isNaN(amount)) return NaN;
	return Math.min(1, Math.max(0, alpha.endsWith('%') ? amount / 100 : amount));
}

/**
 * Colors as layers of a background image, top first. A gradient from one color to itself is that color,
 * and layers blend as the elements they came from do, so no color is worked out here.
 */
export function layers(colors: string[]): string {
	return colors.length ? colors.map((color) => `linear-gradient(${color} 0 0)`).join(', ') : 'none';
}

/**
 * An element's background color. One that's changing, as a theme that eases its colors does when the theme
 * changes, reads somewhere between the old and the new, so it's the new one, where the change ends.
 */
function colorOf(element: Element): string {
	const color = getComputedStyle(element).backgroundColor;
	if (typeof CSSTransition === 'undefined') return color;
	for (const change of element.getAnimations()) {
		if (!(change instanceof CSSTransition) || change.transitionProperty !== 'background-color' || !(change.effect instanceof KeyframeEffect)) continue;
		const end: unknown = change.effect.getKeyframes().at(-1)?.backgroundColor;
		if (typeof end === 'string') return end;
	}
	return color;
}

/** The colors that show from `element` up to `end`, not included, top first: none clear, and nothing under the first solid one. */
function stack(element: Element | null, end: Element | null, colors: string[]): boolean {
	for (let at = element; at && at !== end; at = at.parentElement) {
		const color = colorOf(at);
		const alpha = opacity(color);
		if (alpha === 0) continue;
		colors.push(color);
		if (alpha >= 1) return true;
	}
	return false;
}

const quiet = (row: HTMLTableRowElement) => !row.matches(':hover, :focus-within');

/** The body's first row of each kind, odd then even, passing over any under the pointer or holding an open cell. */
function bodyRows(table: HTMLTableElement): [HTMLTableRowElement | undefined, HTMLTableRowElement | undefined] {
	const rows = table.tBodies[0]?.rows;
	const pick = (parity: number) => {
		let first: HTMLTableRowElement | undefined;
		for (let index = parity; rows && index < rows.length; index += 2) {
			const row = rows[index];
			first ??= row;
			if (row && quiet(row)) return row;
		}
		return first;
	};
	return [pick(0), pick(1)];
}

/**
 * Reads how the theme paints `table`, as drawn and unmarked: the header's odd and even cells, and those of
 * the body's odd and even rows, read from the first two cells of each, so a frozen column's own cells are
 * read as they are.
 */
export function readPaint(widget: HTMLElement, table: HTMLTableElement): Paint {
	const behind: string[] = [];
	const solid = stack(widget, null, behind);
	const page = solid ? (behind.pop() ?? PAGE_FALLBACK) : PAGE_FALLBACK;
	const paint = (cell: HTMLTableCellElement) => {
		const colors: string[] = [];
		if (!stack(cell, widget, colors)) colors.push(...behind);
		return layers(colors);
	};

	const header = table.tHead?.rows[0] ?? table.rows[0];
	const [odd, even] = bodyRows(table);
	const rows = [header, odd, even];
	const variables: Paint['variables'] = [
		[PAGE_VARIABLE, page],
		[BEHIND_VARIABLE, layers(behind)],
		[STRIP_VARIABLE, [...behind, page].map((color) => `${STRIP_OFFSET} 0 0 ${color}`).join(', ')],
	];
	let last: [string, string] | null = null;
	CELL_VARIABLES.forEach(([oddCell, evenCell], index) => {
		const first = rows[index]?.cells[0];
		// A table with no row of this kind has no cells to paint as it, so any paint will do.
		const painted: [string, string] = first ? [paint(first), paint(rows[index]?.cells[1] ?? first)] : (last ?? ['none', 'none']);
		variables.push([oddCell, painted[0]], [evenCell, painted[1]]);
		last = painted;
	});
	const typical = rows.every((row) => row && row.cells.length > 2 && quiet(row)) && [odd, even].every((row) => row?.nextElementSibling);
	return { collapsed: getComputedStyle(table).borderCollapse === 'collapse', variables, typical };
}
