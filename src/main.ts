import { Plugin } from 'obsidian';
import { selectableTables } from './editor/extension';

export default class SelectableTablesPlugin extends Plugin {
	onload() {
		this.registerEditorExtension(selectableTables());
	}
}
