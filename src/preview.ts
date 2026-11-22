import type { Extension } from '@codemirror/state';
import { Notice, type Plugin } from 'obsidian';
import { escapeCell, selectableTables } from './editor/extension';
import { setTableItems, tableMenus } from './editor/freeze-commands';
import { forcePlain, plainForced, stopAnsweringAll } from './own-table/cell-editor';
import { ownTables } from './own-table';
import { addRowFrom, tableCommands, tableItems } from './own-table/table-commands';

/** Set on the body by the preview's stylesheet, src/own-table/styles.css. */
const STYLED = '--selectable-tables-styled';

/**
 * Calls `ready` once the preview's stylesheet is in the page. Obsidian adds a plugin's styles.css after its start-up,
 * so on a reload, with the switch on, the plugin's table would be drawn for a moment without it. Its hidden parts
 * then take room beside the note, the note narrows, and the tables are laid out again; Obsidian's own editor code
 * measures in each update, so that never ends, and the stylesheet never gets its turn.
 */
function whenStyled(plugin: Plugin, ready: () => void): void {
	const styled = () => getComputedStyle(activeDocument.body).getPropertyValue(STYLED) !== '';
	if (styled()) {
		ready();
		return;
	}
	const watch = new MutationObserver(() => {
		if (!styled()) return;
		watch.disconnect();
		ready();
	});
	watch.observe(activeDocument.head, { childList: true });
	plugin.register(() => watch.disconnect());
}

/** What the plugin saves for the preview: whether it draws tables itself. */
interface Saved {
	ownTables?: boolean;
}

/**
 * The preview switch: a command that has the plugin draw Live Preview tables itself, for the whole vault, with no
 * restart. Only a preview build has it (esbuild.config.mjs); a release build puts preview-off.ts here. With the
 * switch on, the plugin's own table takes the place of Obsidian's, and the keys run on it. Its frozen rows and columns
 * pin on a computer (pins.ts), and the freeze commands and the freeze items in the right-click menu act on it too, as
 * do Obsidian's Row, Column and Sort items and its table commands, rebuilt for it (table-commands.ts).
 * The setting is saved with the plugin's data, which Sync can carry to other devices.
 */
export async function previewSwitch(plugin: Plugin, extensions: Extension[]): Promise<void> {
	const { app } = plugin;
	const usual = [...extensions];
	const saved: Saved = ((await plugin.loadData()) as Saved | null) ?? {};
	let on = false;
	let given = false;

	const keys = selectableTables({ frozen: false });
	const own = ownTables(
		app,
		() => {
			// The copy of Obsidian's language can't be made, after an Obsidian update say: tables stay Obsidian's.
			if (given) return;
			given = true;
			new Notice("Selectable Tables can't draw tables in this version of Obsidian, so it leaves them to Obsidian.");
			queueMicrotask(() => use(false));
		},
		// The plain cell editor gets the plugin's keys, as Obsidian gives its own editor every plugin's extensions.
		{ plain: () => keys, escape: (view) => void escapeCell(view), addRow: addRowFrom },
	);
	// Obsidian's table controls on the plugin's table: its Row, Column and Sort items, before the freeze items in a cell's
	// right-click menu, and its table commands, which act only on the plugin's table.
	setTableItems(tableItems);
	plugin.register(() => setTableItems(null));
	for (const command of tableCommands()) plugin.addCommand(command);
	// The note's editors answer for an open cell while it's open; their own answers come back as the plugin unloads.
	plugin.register(stopAnsweringAll);
	const use = (drawing: boolean) => {
		on = drawing;
		extensions.length = 0;
		// The freeze items in a table's right-click menu stay, on the plugin's table's cells and its pinned copies.
		extensions.push(...(drawing ? [own.extension, keys, tableMenus] : usual));
		app.workspace.updateOptions();
	};

	plugin.registerEvent(app.workspace.on('css-change', () => own.themeChanged()));
	// A theme's font loads once text first uses it, after the plugin may have measured the theme's tables with the
	// font standing in for it, and Obsidian sends nothing then.
	const fontsLoaded = () => own.themeChanged();
	activeDocument.fonts.addEventListener('loadingdone', fontsLoaded);
	plugin.register(() => activeDocument.fonts.removeEventListener('loadingdone', fontsLoaded));
	plugin.addCommand({
		id: 'draw-tables-preview',
		name: 'Draw tables with the plugin (preview)',
		callback: async () => {
			const drawing = !on;
			given = false;
			use(drawing);
			saved.ownTables = drawing;
			await plugin.saveData(saved);
			new Notice(drawing ? 'Selectable Tables now draws tables itself (preview).' : 'Obsidian draws tables again.');
		},
	});
	plugin.addCommand({
		id: 'plain-cells-preview',
		name: 'Open cells in the plain editor (preview)',
		callback: () => {
			const plain = !plainForced();
			forcePlain(plain);
			new Notice(plain ? 'Selectable Tables: cells open in a simpler editor, for the preview.' : "Selectable Tables: cells open in Obsidian's editor again.");
		},
	});
	// For the check script and timing runs, on the plugin: whether the switch is on, and the tables' insides.
	Object.assign(plugin, { preview: { isOn: () => on, use, ...own.debug } });
	if (saved.ownTables) whenStyled(plugin, () => use(true));
}
