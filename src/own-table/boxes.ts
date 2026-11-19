import type { Facet, Range, RangeSet, RangeValue } from '@codemirror/state';
import * as cmView from '@codemirror/view';
import type { EditorView } from '@codemirror/view';

/** On the box CodeMirror puts around a table's blocks, beside Obsidian's class for a table's box. */
export const BOX_CLASS = 'selectable-tables-blocks';
/** The attribute that says which table a box is around, by its model's id: no two tables share a box. */
export const BOX_ID = 'data-selectable-tables-table';

/** A box around a table's blocks, as a range in the note. */
export type BoxRange = RangeValue;

/**
 * CodeMirror's block wrappers (@codemirror/view 6.39 and later, in Obsidian 1.15.1), read by name: the `obsidian`
 * package's types pin an older @codemirror/view, which npm won't install beside a newer one. A block wrapper is an
 * element CodeMirror puts around a run of lines, here a table's blocks.
 */
interface Wrappers {
	BlockWrapper?: {
		create(spec: { tagName: string; attributes?: Record<string, string> }): RangeValue;
		set(of: readonly Range<RangeValue>[], sort?: boolean): RangeSet<RangeValue>;
	};
	EditorView: { blockWrappers?: Facet<RangeSet<RangeValue> | ((view: EditorView) => RangeSet<RangeValue>)> };
}

/**
 * The box around a table's blocks: it scrolls them sideways together, and carries Obsidian's classes for a table's
 * box, so a theme's sizes for that box land on it once, as on Obsidian's one widget. Null in a CodeMirror without
 * block wrappers.
 */
export const boxes = (() => {
	const { BlockWrapper, EditorView } = cmView as unknown as Wrappers;
	const facet = EditorView.blockWrappers;
	if (!BlockWrapper || !facet) return null;
	return {
		facet,
		box: (id: number) => BlockWrapper.create({ tagName: 'div', attributes: { class: `cm-embed-block cm-table-widget markdown-rendered ${BOX_CLASS}`, [BOX_ID]: String(id) } }),
		set: (ranges: readonly Range<RangeValue>[]) => BlockWrapper.set(ranges, true),
	};
})();
