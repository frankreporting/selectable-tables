import type { Extension } from '@codemirror/state';
import { Plugin } from 'obsidian';
import { selectableTables } from './editor/extension';
import { themeChanged } from './editor/freeze';
import { cellMenu, freezeCommands, tableMenus } from './editor/freeze-commands';
import { previewSwitch } from './preview';

export default class SelectableTablesPlugin extends Plugin {
	async onload() {
		// Obsidian keeps this array, so the preview switch can change what's in it.
		const extensions: Extension[] = [selectableTables(), tableMenus];
		this.registerEditorExtension(extensions);
		// Frozen tables paint their cells with the theme's colors, read when they're marked.
		this.registerEvent(this.app.workspace.on('css-change', themeChanged));
		for (const command of freezeCommands()) this.addCommand(command);
		// The right-click menu offers the same: tableMenus adds them to a cell's menu, and this to an open cell's.
		this.registerEvent(this.app.workspace.on('editor-menu', cellMenu));
		await previewSwitch(this, extensions);
	}
}
