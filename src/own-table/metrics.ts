import type { EditorView } from '@codemirror/view';
import { Platform } from 'obsidian';
import type { Measure, Metrics } from './estimate';

/**
 * The theme's fonts and sizes for a table, read once per editor from a hidden table built as Obsidian builds its
 * own, so the plugin can lay out a table from its text before drawing it. A change of look reads them again.
 */

const metricsOf = new WeakMap<EditorView, { metrics: Metrics; look: number }>();
/**
 * Counts changes of look. Metrics read before the latest are out of date in every editor, including editors whose
 * tables are Obsidian's at the time: with the preview switch off, nothing forgets an editor's metrics, so turning it
 * back on after a change of theme laid tables out with the theme before (STA-88's hand check).
 */
let look = 0;
/** The last note's metrics, for a table laid out before its own editor has been measured. */
let latest: Metrics | null = null;

const px = (value: string) => parseFloat(value) || 0;
const fontOf = (style: CSSStyleDeclaration) => `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

/** The cells a probe holds: three columns, since themes pad a table's first and last columns differently, and one alone. */
function probeTable(): HTMLElement {
	const probe = createDiv({ cls: 'cm-embed-block cm-table-widget markdown-rendered selectable-tables-probe' });
	const wrapper = probe.createDiv('table-wrapper');
	const cell = (row: HTMLTableRowElement, tag: 'th' | 'td', fill?: (wrap: HTMLElement) => void) => {
		const wrap = row.createEl(tag).createDiv('table-cell-wrapper');
		if (fill) fill(wrap);
		else wrap.setText('Hg');
	};
	const table = wrapper.createEl('table', { cls: 'table-editor' });
	const head = table.createEl('thead').createEl('tr');
	for (let c = 0; c < 3; c++) cell(head, 'th');
	const row = table.createEl('tbody').createEl('tr');
	cell(row, 'td', (wrap) => {
		wrap.appendText('Hg ');
		wrap.createEl('code', { text: 'x' });
		wrap.appendText(' ');
		wrap.createEl('a', { cls: 'tag', text: '#t' });
		wrap.appendText(' ');
		wrap.createEl('strong', { text: 'b' });
		wrap.appendText(' ');
		wrap.createEl('a', { cls: 'external-link', text: 'e', href: 'https://example.com' });
		wrap.appendText(' ');
		wrap.createEl('mark', { text: 'm' });
	});
	cell(row, 'td');
	cell(row, 'td');
	const single = wrapper.createEl('table', { cls: 'table-editor' });
	cell(single.createEl('thead').createEl('tr'), 'th');
	cell(single.createEl('tbody').createEl('tr'), 'td');
	return probe;
}

/** A hidden stand-in for an editor's content, holding `probe`, in the page until it's removed. */
function standIn(view: EditorView, probe: HTMLElement): HTMLElement {
	const content = view.contentDOM;
	const stand = createDiv();
	stand.className = `${content.className} selectable-tables-probe-content`;
	stand.style.width = `${content.offsetWidth}px`;
	stand.appendChild(probe);
	(content.parentElement ?? view.dom).appendChild(stand);
	return stand;
}

/**
 * How narrow and how wide a cell's content can be, measured as a browser lays out a table, for a cell that holds a
 * picture or a player, whose size the text can't tell. A copy of the cell sits alone in a hidden table where a table
 * does, so a theme's rules for pictures in tables reach it: squeezed, it takes its narrowest, and given all the room
 * it wants, its widest. The room the cell takes beside its content is left out, as in `Words`. A picture that has
 * loaded measures at once in its copy, from the browser's memory.
 */
export function measureContent(view: EditorView, cell: HTMLTableCellElement, metrics: Metrics): { min: number; max: number } {
	const probe = createDiv({ cls: 'cm-embed-block cm-table-widget markdown-rendered selectable-tables-probe' });
	const wrapper = probe.createDiv('table-wrapper');
	const table = wrapper.createEl('table', { cls: 'table-editor' });
	const copy = cell.cloneNode(true) as HTMLTableCellElement;
	(cell.localName === 'th' ? table.createEl('thead') : table.createEl('tbody')).createEl('tr').appendChild(copy);
	const stand = standIn(view, probe);
	try {
		wrapper.addClass('selectable-tables-squeezed');
		const min = copy.getBoundingClientRect().width;
		wrapper.removeClass('selectable-tables-squeezed');
		wrapper.addClass('selectable-tables-spread');
		const max = copy.getBoundingClientRect().width;
		const side = metrics.side.only;
		return { min: Math.max(0, min - side), max: Math.max(0, max - side) };
	} finally {
		stand.remove();
	}
}

/**
 * Reads an editor's table metrics. Its editor has to be in the page. The probe sits where a table does, in a hidden
 * stand-in for the editor's content as wide as it, with its classes, so a theme's rules for a table in the note's
 * content reach it (Typewriter's cell padding, Minimal's table width), and it takes the width a table's box has
 * there. The stand-in is beside the content, not in it, which CodeMirror would take for an edit.
 */
function read(view: EditorView): Metrics {
	const probe = probeTable();
	const stand = standIn(view, probe);
	try {
		const style = (el: Element | null) => getComputedStyle(el ?? probe);
		const th = probe.querySelector('th');
		const tds = Array.from(probe.querySelectorAll('tbody td'));
		const td = tds[0] ?? null;
		const wrap = td?.firstElementChild ?? null;
		const tableStyle = style(probe.querySelector('table'));
		const collapsed = tableStyle.borderCollapse === 'collapse';
		// Joined borders lie half in each cell beside them; a theme that keeps them apart has each cell hold its own whole.
		const sideOf = (cell: Element | undefined) => {
			if (!cell) return 0;
			const a = style(cell);
			const b = style(cell.firstElementChild);
			return px(a.paddingLeft) + px(a.paddingRight) + px(b.paddingLeft) + px(b.paddingRight) + (px(a.borderLeftWidth) + px(a.borderRightWidth)) / (collapsed ? 2 : 1);
		};
		const across = (s: CSSStyleDeclaration) => px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
		const tdStyle = style(td);
		const first = style(tds[0] ?? null);
		const last = style(tds[2] ?? null);
		const thStyle = style(th);
		const wrapStyle = style(wrap);
		const code = style(probe.querySelector('code'));
		const tag = style(probe.querySelector('.tag'));
		const mark = style(probe.querySelector('mark'));
		const external = style(probe.querySelector('.external-link'));
		const box = style(probe);
		const available = probe.clientWidth - px(box.paddingLeft) - px(box.paddingRight);
		return {
			fonts: { body: fontOf(tdStyle), head: fontOf(thStyle), code: fontOf(code), tag: fontOf(tag), bold: fontOf(style(probe.querySelector('strong'))) },
			extra: { code: across(code), tag: across(tag), link: px(external.paddingLeft) + px(external.paddingRight), mark: across(mark) + px(mark.marginLeft) + px(mark.marginRight) },
			side: { first: sideOf(tds[0]), middle: sideOf(tds[1]), last: sideOf(tds[2]), only: sideOf(tds[3]) },
			padY: px(wrapStyle.paddingTop) + px(wrapStyle.paddingBottom) + px(tdStyle.paddingTop) + px(tdStyle.paddingBottom),
			border: px(tdStyle.borderLeftWidth) || 1,
			tableBorder: px(tableStyle.borderLeftWidth) + px(tableStyle.borderRightWidth),
			// Joined, the wider of the table's and the outer cell's border wins, and half of it lies outside the columns.
			outer: (Math.max(px(tableStyle.borderLeftWidth), px(first.borderLeftWidth)) + Math.max(px(tableStyle.borderRightWidth), px(last.borderRightWidth))) / 2,
			firstExtra: (px(first.borderLeftWidth) + px(first.borderRightWidth)) / 2,
			lineHeight: px(tdStyle.lineHeight) || px(tdStyle.fontSize) * 1.3,
			headLineHeight: px(thStyle.lineHeight) || px(thStyle.fontSize) * 1.3,
			minColumn: Math.max(px(tdStyle.minWidth), px(thStyle.minWidth)),
			available,
			pad: px(box.paddingTop) + px(box.paddingBottom),
			padTop: px(box.paddingTop),
			collapsed,
			spacing: collapsed ? 0 : px(tableStyle.borderSpacing.split(' ')[0] ?? ''),
			keepSpaces: wrapStyle.whiteSpaceCollapse === 'break-spaces' || wrapStyle.whiteSpace === 'break-spaces',
			// The probe's cells are tiny, so a table as wide as the room is one the theme stretches.
			stretch: (probe.querySelector('table')?.getBoundingClientRect().width ?? 0) >= available - 1,
			// Obsidian runs in WebKit only on an iPhone or iPad.
			webkit: Platform.isIosApp,
		};
	} finally {
		stand.remove();
	}
}

/** Whether two editors' metrics are the same, so tables shaped with one needn't be shaped again for the other. */
function same(a: Metrics, b: Metrics): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * An editor's metrics, read the first time they're asked for. An editor that isn't laid out, in a tab behind
 * another say, has no sizes to read: it gets the last note's until it is.
 */
export function metricsFor(view: EditorView): Metrics | null {
	const known = current(view);
	if (known) return known;
	if (!view.dom.isConnected || view.contentDOM.clientWidth === 0) return latest;
	const fresh = read(view);
	const metrics = latest && same(latest, fresh) ? latest : fresh;
	metricsOf.set(view, { metrics, look });
	latest = metrics;
	return metrics;
}

/** An editor's metrics if read since the last change of look. */
function current(view: EditorView): Metrics | null {
	const known = metricsOf.get(view);
	return known && known.look === look ? known.metrics : null;
}

/** An editor's metrics if read already, or the last note's. */
export function knownMetrics(view: EditorView | null): Metrics | null {
	return (view && current(view)) ?? latest;
}

/** The look changed, a theme, a font or a snippet: every editor's metrics and the text widths kept are out of date. */
export function lookChanged(): void {
	look++;
	latest = null;
	widths.clear();
}

/** Forgets an editor's metrics, after its width or the theme changed. */
export function forgetMetrics(view: EditorView): void {
	metricsOf.delete(view);
}

/** The width an editor's tables can take now, to tell whether its metrics are out of date. */
export function availableWidth(view: EditorView): number {
	const content = getComputedStyle(view.contentDOM);
	return view.contentDOM.clientWidth - px(content.paddingLeft) - px(content.paddingRight);
}

const context = activeDocument.createElement('canvas').getContext('2d');
const widths = new Map<string, number>();

/** Text widths from a canvas, kept by font and word: the same words come back in every row. */
export const measure: Measure = (font, text) => {
	const key = `${font}\u0001${text}`;
	let width = widths.get(key);
	if (width === undefined) {
		if (!context) return text.length * 8;
		context.font = font;
		width = context.measureText(text).width;
		if (widths.size > 50000) widths.clear();
		widths.set(key, width);
	}
	return width;
};
