import type { Extension } from '@codemirror/state';
import type { Plugin } from 'obsidian';

/**
 * What a release build has in place of the preview switch: nothing. esbuild.config.mjs puts this module where
 * `./preview` is imported, so a release carries none of the plugin's own table and makes no private change.
 */
export function previewSwitch(plugin: Plugin, extensions: Extension[]): Promise<void> {
	void plugin;
	void extensions;
	return Promise.resolve();
}
