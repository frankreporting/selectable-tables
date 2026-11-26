import type { Extension } from '@codemirror/state';
import { addIcon, type App, Notice, type Plugin, PluginSettingTab, removeIcon, type SettingDefinitionItem } from 'obsidian';
import { escapeCell, selectableTables, setCellEdits } from './editor/extension';
import { setTableItems, tableMenus } from './editor/freeze-commands';
import { breakCopy } from './own-table/language';
import { cellFormatter, stopAnsweringAll } from './own-table/cell-editor';
import { ownTables } from './own-table';
import { addAtEnd, clearCells, gripItems, pasteCells, pasteIntoCell, tableCommands, tableItems } from './own-table/table-commands';
import { startDrag } from './own-table/drag';
import { clickCell, clickSelectsCells, pressCell, selectEvery, setClickSelects } from './own-table/cell-drag';
import { setTableControls } from './own-table/grips';
import { formattingOnCells, giveBackAll, HIGHLIGHTS, swatchIcon } from './own-table/formatting';
import { rangeItems } from './own-table/range-menu';
import { followLinks } from './own-table/links';

/** Set on the body by the plugin's stylesheet, styles.css. */
const STYLED = '--selectable-tables-styled';

/** What the plugin says, once, when an Obsidian update keeps it from drawing tables. */
export const CANT_DRAW = "Better Markdown Tables can't draw tables in this version of Obsidian. Tables are Obsidian's own until the plugin is updated.";

/**
 * Calls `ready` once the plugin's stylesheet is in the page. Obsidian adds a plugin's styles.css after its start-up,
 * so on a reload the plugin's table would be drawn for a moment without it. Its hidden parts then take room beside the
 * note, the note narrows, and the tables are laid out again; Obsidian's own editor code measures in each update, so
 * that never ends, and the stylesheet never gets its turn.
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

/**
 * What the plugin saves: whether a click on a cell selects it. Builds before the relaunch also saved whether their
 * preview switch was on, as `ownTables`, which is kept as it was and no longer read.
 */
interface Saved {
	ownTables?: boolean;
	clickSelects?: boolean;
}

/** The one setting: whether a click on a cell of the plugin's table selects it, the default, or opens it. */
const CLICK_SELECTS = 'clickSelects';

/**
 * The plugin's settings tab: how a click on a cell works. Obsidian draws it from its declarative settings (1.13 on),
 * which settings search finds.
 */
class Settings extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private readonly saved: Saved,
		private readonly save: () => Promise<void>,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
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
}

/**
 * The plugin draws Live Preview tables itself, in every note's tab, in place of Obsidian's table, and the keys run on
 * them. Its frozen rows and columns pin on a computer (pins.ts), and the freeze commands and the freeze items in the
 * right-click menu act on it, as do Obsidian's Row, Column and Sort items and its table commands, rebuilt for it
 * (table-commands.ts), its drag handles and + buttons (grips.ts, drag.ts), its range of cells, dragged across
 * (cell-drag.ts), Backspace, Delete, Cut and Paste on a selected cell or a range (table-commands.ts), and formatting on
 * them (formatting.ts). A click on a cell selects it, and a double-click opens it, unless the settings tab's one
 * setting says otherwise; the setting is saved with the plugin's data, which Sync can carry to other devices.
 *
 * Where the plugin's table doesn't draw, Obsidian draws its own, as it does without the plugin: in canvas cards,
 * hover previews and other editors outside a note's tab, and in every note when the copy of Obsidian's Markdown
 * language can't be made, after an Obsidian update say. Then the plugin says so once, and adds nothing to any editor.
 * `extensions` is the array the plugin registered, which Obsidian keeps, so what's in it can change.
 */
export async function drawTables(plugin: Plugin, extensions: Extension[]): Promise<void> {
	const { app } = plugin;
	const saved: Saved = ((await plugin.loadData()) as Saved | null) ?? {};
	let on = false;
	let given = false;

	const keys = selectableTables({ frozen: false });
	// Obsidian's link commands on a selected cell or an open one (links.ts).
	const links = followLinks(app);
	const own = ownTables(
		app,
		() => {
			// The copy of Obsidian's language can't be made, after an Obsidian update say: tables stay Obsidian's.
			if (given) return;
			given = true;
			new Notice(CANT_DRAW);
			queueMicrotask(() => use(false));
		},
		// The plain cell editor gets the plugin's keys, as Obsidian gives its own editor every plugin's extensions.
		{ plain: () => keys, escape: (view) => void escapeCell(view), pasteCells: pasteIntoCell },
	);
	// Backspace, Delete, Cut and Paste on a selected cell or a range of cells of the plugin's table.
	setCellEdits({ clear: clearCells, paste: pasteCells });
	plugin.register(() => setCellEdits(null));
	// Obsidian's table controls on the plugin's table: its Row, Column and Sort items, before the freeze items in a cell's
	// right-click menu, and its table commands, which act only on the plugin's table.
	// A range of cells has its own menu, with Obsidian's highlight colors as swatches, which the plugin adds as icons.
	setTableItems((menu, view, place, kind) => (kind === 'range' ? rangeItems(menu, view) : kind ? gripItems(menu, view, place, kind) : tableItems(menu, view, place)));
	for (const { color } of HIGHLIGHTS) addIcon(swatchIcon(color), `<circle cx="50" cy="50" r="38" style="fill: var(--color-${color}); stroke: none" />`);
	plugin.register(() => {
		for (const { color } of HIGHLIGHTS) removeIcon(swatchIcon(color));
	});
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
	plugin.addSettingTab(new Settings(app, plugin, saved, () => plugin.saveData(saved)));
	plugin.register(() => setTableControls(null));
	for (const command of tableCommands()) plugin.addCommand(command);
	// The note's editors answer for an open cell while it's open; their own answers come back as the plugin unloads.
	plugin.register(stopAnsweringAll);
	// Formatting on the plugin's table: each note's editor hands it to the selected cells or the open cell's own editor
	// while the plugin draws its tables, and has its own back as the plugin unloads.
	plugin.register(giveBackAll);
	/** Draws the plugin's tables, or leaves every table to Obsidian, adding nothing to any editor. */
	const use = (drawing: boolean) => {
		on = drawing;
		extensions.length = 0;
		// The freeze items in a table's right-click menu stay, on the plugin's table's cells and its pinned copies.
		if (drawing) extensions.push(own.extension, keys, tableMenus, formattingOnCells, links);
		app.workspace.updateOptions();
	};

	plugin.registerEvent(app.workspace.on('css-change', () => own.themeChanged()));
	// A theme's font loads once text first uses it, after the plugin may have measured the theme's tables with the
	// font standing in for it, and Obsidian sends nothing then.
	const fontsLoaded = () => own.themeChanged();
	activeDocument.fonts.addEventListener('loadingdone', fontsLoaded);
	plugin.register(() => activeDocument.fonts.removeEventListener('loadingdone', fontsLoaded));
	// For the check script and timing runs, on the plugin: whether it draws tables, Obsidian's own tables to compare
	// against (`use(false)`), the copy made to fail as after an Obsidian update, and the tables' insides. The timing
	// scripts in .dev/measure, which compare against builds from before the relaunch, read it as `preview` too.
	const debug = { isOn: () => on, use, breakCopy, cellFormatter, clickSelects: clickSelectsCells, setClickSelects, ...own.debug };
	Object.assign(plugin, { debug, preview: debug });
	whenStyled(plugin, () => use(true));
}
