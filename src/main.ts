import { Plugin } from 'obsidian';
import { selectableTables } from './editor/extension';
import { themeChanged } from './editor/freeze';
import { freezeCommands } from './editor/freeze-commands';

export default class SelectableTablesPlugin extends Plugin {
	onload() {
		this.registerEditorExtension(selectableTables());
		// Frozen tables paint their cells with the theme's colors, read when they're marked.
		this.registerEvent(this.app.workspace.on('css-change', themeChanged));
		for (const command of freezeCommands()) this.addCommand(command);
	}
}
