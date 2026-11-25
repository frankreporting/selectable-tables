import type { Extension } from '@codemirror/state';
import { type App, Notice, type Plugin, PluginSettingTab } from 'obsidian';
import { escapeCell, selectableTables, setCellEdits } from './editor/extension';
import { setTableItems, tableMenus } from './editor/freeze-commands';
import { cellFormatter, forcePlain, plainForced, stopAnsweringAll } from './own-table/cell-editor';
import { ownTables } from './own-table';
import { addAtEnd, addRowFrom, clearCells, pasteCells, pasteIntoCell, tableCommands, tableItems } from './own-table/table-commands';
import { startDrag } from './own-table/drag';
import { clickCell, clickSelectsCells, pressCell, selectEvery, setClickSelects } from './own-table/cell-drag';
import { setTableControls } from './own-table/grips';
import { formattingOnCells, giveBackAll } from './own-table/formatting';

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

/** What the plugin saves for the preview: whether it draws tables itself, and whether a click on a cell selects it. */
interface Saved {
	ownTables?: boolean;
	clickSelects?: boolean;
}

/** The one setting: whether a click on a cell of the plugin's table selects it, the default, or opens it. */
const CLICK_SELECTS = 'clickSelects';

/**
 * A toggle in Obsidian's declarative settings (1.13 on), which settings search finds. The `obsidian` package this repo
 * pins, 1.12.3, doesn't declare them yet.
 */
interface ToggleDefinition {
	name: string;
	desc: string;
	control: { type: 'toggle'; key: string; defaultValue: boolean };
}

/** The plugin's settings tab, in a preview build: how a click on a cell of the plugin's table works. */
class PreviewSettings extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly saved: Saved,
		private readonly save: () => Promise<void>,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): ToggleDefinition[] {
		return [
			{
				name: 'Click to select a cell',
				desc: 'A click selects a cell, and a double-click opens it. Turn it off to open a cell with one click, as in Obsidian.',
				control: { type: 'toggle', key: CLICK_SELECTS, defaultValue: true },
			},
		];
	}

	getControlValue(key: string): unknown {
		return key === CLICK_SELECTS ? clickSelectsCells() : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key !== CLICK_SELECTS) return;
		const on = value === true;
		setClickSelects(on);
		// Every editor draws again, with the pointer the setting gives its cells.
		this.app.workspace.updateOptions();
		this.saved.clickSelects = on;
		await this.save();
	}

	/**
	 * Never called: Obsidian draws the tab from the definitions above. The 1.12.3 typings this repo pins make it abstract,
	 * so it stays, and lint warns about it, until the typings are updated.
	 */
	display(): void {
		this.containerEl.empty();
	}
}

/**
 * The preview switch: a command that has the plugin draw Live Preview tables itself, for the whole vault, with no
 * restart. Only a preview build has it (esbuild.config.mjs); a release build puts preview-off.ts here. With the
 * switch on, the plugin's own table takes the place of Obsidian's, and the keys run on it. Its frozen rows and columns
 * pin on a computer (pins.ts), and the freeze commands and the freeze items in the right-click menu act on it too, as
 * do Obsidian's Row, Column and Sort items and its table commands, rebuilt for it (table-commands.ts), its drag
 * handles and + buttons (grips.ts, drag.ts), its range of cells, dragged across (cell-drag.ts), Backspace, Delete,
 * Cut and Paste on a selected cell or a range (table-commands.ts), and formatting on them (formatting.ts). A click on
 * a cell selects it, and a double-click opens it, unless the settings tab's one setting says otherwise. The switch and
 * the setting are saved with the plugin's data, which Sync can carry to other devices.
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
		{ plain: () => keys, escape: (view) => void escapeCell(view), addRow: addRowFrom, pasteCells: pasteIntoCell },
	);
	// Backspace, Delete, Cut and Paste on a selected cell or a range of cells of the plugin's table.
	setCellEdits({ clear: clearCells, paste: pasteCells });
	plugin.register(() => setCellEdits(null));
	// Obsidian's table controls on the plugin's table: its Row, Column and Sort items, before the freeze items in a cell's
	// right-click menu, and its table commands, which act only on the plugin's table.
	setTableItems(tableItems);
	plugin.register(() => setTableItems(null));
	// The drag handles and the + buttons, and drags across cells, on the plugin's table.
	setTableControls({
		press: startDrag,
		add: (table, what) => {
			if (table.view) addAtEnd(table.view, table, what);
		},
		pressCell,
		clickCell,
		selectEvery,
	});
	// A click on a cell selects it, and a double-click opens it, unless the setting says otherwise: on by default.
	setClickSelects(saved.clickSelects ?? true);
	plugin.register(() => setClickSelects(true));
	plugin.addSettingTab(new PreviewSettings(app, plugin, saved, () => plugin.saveData(saved)));
	plugin.register(() => setTableControls(null));
	for (const command of tableCommands()) plugin.addCommand(command);
	// The note's editors answer for an open cell while it's open; their own answers come back as the plugin unloads.
	plugin.register(stopAnsweringAll);
	// Formatting on the plugin's table: each note's editor hands it to the selected cells or the open cell's own editor
	// while the plugin draws its tables, and has its own back as the plugin unloads.
	plugin.register(giveBackAll);
	const use = (drawing: boolean) => {
		on = drawing;
		extensions.length = 0;
		// The freeze items in a table's right-click menu stay, on the plugin's table's cells and its pinned copies.
		extensions.push(...(drawing ? [own.extension, keys, tableMenus, formattingOnCells] : usual));
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
	Object.assign(plugin, { preview: { isOn: () => on, use, cellFormatter, clickSelects: clickSelectsCells, setClickSelects, ...own.debug } });
	if (saved.ownTables) whenStyled(plugin, () => use(true));
}
