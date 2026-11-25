import type { EditorView } from '@codemirror/view';
import { type IconName, type Menu, Platform } from 'obsidian';
import { formatItems } from './formatting';
import { ALIGN_ITEMS, alignRange, clearRange, deleteRange, selectedCells } from './table-commands';

/**
 * The right-click menu of a range of cells of the plugin's table, as Obsidian's range has it (read from 1.15.1's
 * `onContextMenu` with cells selected): Cut, Copy and Paste on a computer, the Format submenu, Align left, center and
 * right for the range's columns, Clear cells and Delete cells. No freeze items, as on Obsidian's range.
 */

/** The window's Electron contents, which cut, copy and paste as the app's Edit menu does: checked before use. */
interface Contents {
	cut(): void;
	copy(): void;
	paste(): void;
}

/**
 * Electron's contents of the note's window, as Obsidian's range menu reaches them (`electron.remote`, private), or null
 * where they aren't there, on a phone say. Their cut, copy and paste send the browser's own events to the note, which
 * the plugin's keys already answer, as for Cmd+X, Cmd+C and Cmd+V.
 */
function contentsOf(view: EditorView): Contents | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const win = view.dom.ownerDocument.defaultView as (Window & { electron?: { remote?: { getCurrentWebContents?: () => unknown } } }) | null;
		const contents = win?.electron?.remote?.getCurrentWebContents?.() as Partial<Contents> | undefined;
		return contents && typeof contents.cut === 'function' && typeof contents.copy === 'function' && typeof contents.paste === 'function' ? (contents as Contents) : null;
	} catch {
		return null;
	}
}

const CLIPBOARD: { name: string; icon: IconName; run: keyof Contents }[] = [
	{ name: 'Cut', icon: 'lucide-scissors', run: 'cut' },
	{ name: 'Copy', icon: 'lucide-copy', run: 'copy' },
	{ name: 'Paste', icon: 'lucide-clipboard-check', run: 'paste' },
];

/** The range menu's items, for the note's range of cells. An item acts only while that range is still selected. */
export function rangeItems(menu: Menu, view: EditorView): void {
	const found = selectedCells(view);
	if (!found?.anchor) return;
	const { anchor, cell } = found;
	const from = found.table.from;
	const contents = contentsOf(view);
	if (contents) for (const { name, icon, run } of CLIPBOARD) menu.addItem((item) => item.setSection('clipboard').setTitle(name).setIcon(icon).onClick(() => contents[run]()));
	formatItems(menu, view);
	for (const each of ALIGN_ITEMS) menu.addItem((item) => item.setSection('table-align').setTitle(each.name).setIcon(each.icon).onClick(() => alignRange(view, from, anchor, cell, each.edit)));
	menu.addItem((item) => item.setSection('table').setTitle('Clear cells').setIcon('lucide-eraser').onClick(() => clearRange(view, from, anchor, cell)));
	menu.addItem((item) => item.setSection('table').setTitle('Delete cells').setIcon('lucide-trash-2').onClick(() => deleteRange(view, from, anchor, cell)));
}
