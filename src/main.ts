import type { Extension } from '@codemirror/state';
import { Plugin } from 'obsidian';
import { cellMenu, freezeCommands } from './editor/freeze-commands';
import { drawTables } from './tables';

export default class BetterMarkdownTablesPlugin extends Plugin {
	onload() {
		// Obsidian keeps this array, so what's in it can change: the plugin's table, or nothing where Obsidian's draws.
		const extensions: Extension[] = [];
		this.registerEditorExtension(extensions);
		for (const command of freezeCommands()) this.addCommand(command);
		// The right-click menu offers the same: tableMenus adds them to a cell's menu, and this to an open cell's.
		this.registerEvent(this.app.workspace.on('editor-menu', cellMenu));
		drawTables(this, extensions);
	}
}
