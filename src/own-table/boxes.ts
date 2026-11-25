import type { Range } from '@codemirror/state';
import { BlockWrapper, EditorView } from '@codemirror/view';

/** On the box CodeMirror puts around a table's blocks, beside Obsidian's class for a table's box. */
export const BOX_CLASS = 'selectable-tables-blocks';
/** The attribute that says which table a box is around, by its model's id: no two tables share a box. */
export const BOX_ID = 'data-selectable-tables-table';

/** A box around a table's blocks, as a range in the note. */
export type BoxRange = BlockWrapper;

/**
 * The box around a table's blocks: it scrolls them sideways together, and carries Obsidian's classes for a table's
 * box, so a theme's sizes for that box land on it once, as on Obsidian's one widget. It's a CodeMirror block wrapper
 * (@codemirror/view 6.39 and later, in Obsidian 1.15.1), an element CodeMirror puts around a run of lines, here a
 * table's blocks. Null in a CodeMirror without block wrappers: @codemirror/view stays outside the bundle, so at run
 * time these are Obsidian's copy, and a missing export reads as undefined.
 */
export const boxes = (() => {
	const facet = EditorView.blockWrappers as typeof EditorView.blockWrappers | undefined;
	if (!(BlockWrapper as typeof BlockWrapper | undefined) || !facet) return null;
	return {
		facet,
		box: (id: number) => BlockWrapper.create({ tagName: 'div', attributes: { class: `cm-embed-block cm-table-widget markdown-rendered ${BOX_CLASS}`, [BOX_ID]: String(id) } }),
		set: (ranges: readonly Range<BlockWrapper>[]) => BlockWrapper.set(ranges, true),
	};
})();
