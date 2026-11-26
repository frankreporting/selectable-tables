import { EditorView, ViewPlugin } from '@codemirror/view';
import { type App, editorInfoField, MarkdownView, Menu, type PaneType } from 'obsidian';
import { sameCell } from '../editor/decide';
import { inOwnCell, openCells, type OwnCell } from '../editor/layout';
import { cellFormatter } from './cell-editor';
import { type DrawnLink, menuTitle, pickLinks } from './cell-links';
import { selectedCells } from './table-commands';

/**
 * Following a link in the plugin's table (BMT-59). Obsidian's four link commands, Follow link under cursor (Option+Enter)
 * and the three that open in a new tab, to the right or in a new window, look for a link at the note's caret. The
 * plugin's rows hide their links from where they look, so they find none, and a hotkey then sends an `open-link` event to
 * what has the keyboard, with where to open it, as Obsidian's Bases table answers for its selected cell.
 *
 * With a cell selected, the note has the keyboard, and the event opens the cell's link: its one link at once, or the one
 * picked from a menu below the cell where it's drawn, pinned or not, as in Bases. A cell with no link, a range of cells
 * and a table selected whole are left alone. In an open cell, the cell's editor has the keyboard, and the event opens the
 * link at its caret, as the commands do in Obsidian's own cell.
 */

/** Where the event says to open the link: this tab (false), a new tab, to the right, or a new window. */
function paneOf(event: Event): PaneType | false {
	const pane = (event as CustomEvent<{ paneType?: unknown }>).detail?.paneType;
	return pane === 'tab' || pane === 'split' || pane === 'window' ? pane : false;
}

/** The links drawn in a cell's element, internal and external, read as Bases reads them. */
function linksOf(cell: HTMLElement): DrawnLink[] {
	return pickLinks(
		Array.from(cell.querySelectorAll<HTMLElement>('a.internal-link, a.external-link')).map((a) => ({
			href: a.getAttribute('data-href') ?? a.getAttribute('href') ?? '',
			internal: a.hasClass('internal-link'),
			inEmbed: a.closest('.internal-embed') !== null,
		})),
	);
}

/** Opens one link, as a click on it would: a note's in the vault, from the note's path, a web address in the browser. */
function open(app: App, link: DrawnLink, sourcePath: string, pane: PaneType | false): void {
	if (link.internal) void app.workspace.openLinkText(link.href, sourcePath, pane);
	else window.open(link.href, '_blank');
}

/** The note's file path, so links resolve as a click on them would. */
function pathOf(view: EditorView): string {
	return view.state.field(editorInfoField, false)?.file?.path ?? '';
}

/** A selected cell's links: one opens, several show a menu below the cell. Says whether the event was answered. */
function followSelected(app: App, view: EditorView, pane: PaneType | false): boolean {
	const selected = selectedCells(view);
	// A range of cells, as in Bases, and a table selected whole, which has no selected cell, are left alone.
	if (!selected || (selected.anchor && !sameCell(selected.anchor, selected.cell))) return false;
	const cell = selected.own.drawnCell(selected.cell);
	if (!cell) return false;
	const links = linksOf(cell);
	if (!links.length) return false;
	const path = pathOf(view);
	if (links.length === 1) {
		open(app, links[0]!, path, pane);
		return true;
	}
	const menu = new Menu();
	for (const link of links) menu.addItem((item) => item.setTitle(menuTitle(link.href)).onClick(() => open(app, link, path, pane)));
	// While the menu shows, keys are its own. Obsidian's keymap has them first, in the window's capture phase, but they'd go
	// on to the note, where Escape would leave the cell and Enter open it. This stops them after the keymap. It goes a moment
	// after the menu closes, so the key that closed it is stopped too.
	const win = view.dom.ownerDocument.defaultView ?? window;
	const keep = (event: KeyboardEvent) => event.stopPropagation();
	win.addEventListener('keydown', keep, true);
	menu.onHide(() => win.setTimeout(() => win.removeEventListener('keydown', keep, true), 0));
	const rect = cell.getBoundingClientRect();
	menu.showAtPosition({ x: rect.left, y: rect.bottom }, view.dom.ownerDocument);
	return true;
}

/** What an open cell needs of Obsidian's internals: its own editor's link at the caret, and the note's way to open it. */
interface Clickable {
	getClickableTokenAt?(pos: unknown): unknown;
	getCursor?(): unknown;
}
interface Triggers {
	triggerClickableToken?(token: unknown, pane: PaneType | false): void;
}

/**
 * The link at an open cell's caret, opened as the commands open one in Obsidian's own cell: the cell's own `Editor` finds
 * it, with the cell's Markdown language, and the note's edit mode opens it. Both are private, so each is checked first, and
 * without them, or in the plain editor, nothing happens. Says whether the event was answered.
 */
function followOpen(view: EditorView, open: OwnCell, pane: PaneType | false): boolean {
	const editor = cellFormatter(open.view) as Clickable | null;
	const info = view.state.field(editorInfoField, false);
	const editMode = info instanceof MarkdownView ? (info as unknown as { editMode?: Triggers }).editMode : null;
	if (typeof editor?.getClickableTokenAt !== 'function' || typeof editor.getCursor !== 'function' || typeof editMode?.triggerClickableToken !== 'function') return false;
	const token = editor.getClickableTokenAt(editor.getCursor());
	if (!token) return false;
	editMode.triggerClickableToken(token, pane);
	return true;
}

/** The plugin's answer to the link commands' `open-link` event, on a note's editor that draws the plugin's tables. */
export function followLinks(app: App) {
	return ViewPlugin.define((view) => {
		// The plugin's extensions stand aside in an open cell's own editor: the note's answers for it.
		if (view.state.facet(inOwnCell)) return {};
		const onOpenLink = (event: Event) => {
			const target = event.target as Node;
			const pane = paneOf(event);
			const open = openCells.get(view);
			let answered = false;
			if (open && open.note === view && open.view.contentDOM.contains(target)) answered = followOpen(view, open, pane);
			else if (target === view.contentDOM) answered = followSelected(app, view, pane);
			if (answered) event.preventDefault();
		};
		// In the capture phase, so an open cell's editor, inside the note's content, is heard too.
		view.contentDOM.addEventListener('open-link', onOpenLink, true);
		return { destroy: () => view.contentDOM.removeEventListener('open-link', onOpenLink, true) };
	});
}
