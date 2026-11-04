import { Plugin } from 'obsidian';
import { selectableTables } from './editor/extension';
import { themeChanged } from './editor/freeze';
import { cellMenu, freezeCommands, tableMenus } from './editor/freeze-commands';

export default class SelectableTablesPlugin extends Plugin {
	onload() {
		this.registerEditorExtension([selectableTables(), tableMenus]);
		// Frozen tables paint their cells with the theme's colors, read when they're marked.
		this.registerEvent(this.app.workspace.on('css-change', themeChanged));
		for (const command of freezeCommands()) this.addCommand(command);
		// The right-click menu offers the same: tableMenus adds them to a cell's menu, and this to an open cell's.
		this.registerEvent(this.app.workspace.on('editor-menu', cellMenu));
	}
}
