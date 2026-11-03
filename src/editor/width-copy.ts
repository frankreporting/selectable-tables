/**
 * An open cell keeps its column's width. Table layout reads each cell's narrowest and preferred widths,
 * and Obsidian hides a cell's rendered text as the cell opens, so the column would take the width of the
 * cell's source instead. So an unseen copy of the rendered text goes in the box Obsidian builds for the
 * cell's editor, and holds the width it set; styles.css keeps the copy out of sight and has the editor add
 * no width. Obsidian builds a new box for every open and detaches it on close, so the copy leaves with it.
 */

/** Obsidian's box around a cell's rendered text, and around its editor while it's open. */
const WRAPPER_CLASS = 'table-cell-wrapper';
/** On the copy of an open cell's rendered text; styles.css keeps it in the layout, unseen. */
const COPY_CLASS = 'selectable-tables-width-copy';
/** On the box holding an open cell's editor once it holds a copy; styles.css has the editor add no width then. */
const HOLDS_WIDTH_CLASS = 'selectable-tables-holds-width';

/** Elements a copy would load a second time. */
const LOADS = new Set(['IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);

/** A node by its name and children, all a copy needs to know of a cell's rendered text. */
export interface Shape {
	nodeName: string;
	childNodes: ArrayLike<Shape>;
}

function loadsAgain(node: Shape): boolean {
	return Array.from(node.childNodes).some((child) => LOADS.has(child.nodeName) || loadsAgain(child));
}

/**
 * Whether an open cell's editor gets a copy of its rendered text. An empty cell, which Obsidian draws as
 * a lone line break, gets none: it grows as you type, since otherwise every word would wrap. Nor does a
 * cell holding a frame or a video, which a copy would load again. Those cells open as they do without the
 * plugin. And focus coming back to a cell that's still open adds no second copy.
 */
export function copiesWidth(rendered: Shape, copied: boolean): boolean {
	if (copied) return false;
	const nodes = rendered.childNodes;
	if (nodes.length === 0 || (nodes.length === 1 && nodes[0]?.nodeName === 'BR')) return false;
	return !loadsAgain(rendered);
}

/**
 * Gives a cell that has just opened a copy of its rendered text, when the focus lands in its editor.
 * Obsidian has hidden the rendered text by then, and holds the cell at its closed size for a moment, so
 * the copy is in place before the cell is drawn open. It goes right after the editor's element, as a block
 * of no height: a theme can set what's in the box inline, as Minimal's row numbers do, and a block before the
 * editor would push it down a line. Anything that isn't a cell's editor, in a box in a cell, is left alone.
 */
export function holdWidth(focused: Element) {
	const editor = focused.closest('.cm-editor')?.parentElement;
	const box = editor?.parentElement;
	const cell = box?.parentElement;
	if (!editor || !box?.classList.contains(WRAPPER_CLASS) || !cell || (cell.tagName !== 'TD' && cell.tagName !== 'TH')) return;
	const rendered = Array.from(cell.children).find((child): child is HTMLElement => child !== box && child.classList.contains(WRAPPER_CLASS));
	if (!rendered || rendered.style.display !== 'none') return;
	if (!copiesWidth(rendered, box.classList.contains(HOLDS_WIDTH_CLASS))) return;
	const copy = rendered.cloneNode(true) as HTMLElement;
	copy.removeAttribute('style');
	copy.removeAttribute('id');
	for (const named of Array.from(copy.querySelectorAll('[id]'))) named.removeAttribute('id');
	copy.classList.add(COPY_CLASS);
	copy.setAttribute('aria-hidden', 'true');
	editor.after(copy);
	box.classList.add(HOLDS_WIDTH_CLASS);
}
