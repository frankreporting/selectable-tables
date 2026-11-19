import * as cmLanguage from '@codemirror/language';
import type { NodeProp, NodeType, Tree } from '@lezer/common';
import type { Rows } from './find';
import { ROW_CLASS } from './hide-rows';

/**
 * The node prop that holds a line's classes in Obsidian's syntax tree. Obsidian's parser gives every line with a
 * class one node over the whole line, and its own copy of @codemirror/language exports this prop; CodeMirror's
 * doesn't, so it's read by name. Null where it's missing, and then the plugin leaves tables to Obsidian.
 */
export const lineClassProp: NodeProp<string> | null = (cmLanguage as unknown as { lineClassNodeProp?: NodeProp<string> }).lineClassNodeProp ?? null;

const rowTypes = new WeakMap<NodeType, boolean>();

function isRowType(type: NodeType, prop: NodeProp<string>): boolean {
	let row = rowTypes.get(type);
	if (row === undefined) {
		row = ` ${type.prop(prop) ?? ''} `.includes(` ${ROW_CLASS} `);
		rowTypes.set(type, row);
	}
	return row;
}

/** The first window `next` looks in. Each one after is twice as long, so a long stretch of text costs little more. */
const FIRST_WINDOW = 4096;

/** The table rows the parser marks in a syntax tree. */
export function treeRows(tree: Tree, prop: NodeProp<string>): Rows {
	return {
		length: tree.length,
		next(from, to) {
			let found = -1;
			for (let start = from, size = FIRST_WINDOW; start < to && found < 0; start += size, size *= 2) {
				tree.iterate({
					from: start,
					to: Math.min(to, start + size),
					enter(node) {
						if (found >= 0) return false;
						// A node with no line classes holds the lines' nodes: look inside it.
						if (node.type.prop(prop) === undefined) return undefined;
						if (node.from >= from && node.from < to && isRowType(node.type, prop)) found = node.from;
						return false;
					},
				});
			}
			return found;
		},
		gap(from, to) {
			const named = (start: number, end: number, test: (node: { from: number; to: number }) => void) =>
				tree.iterate({
					from: start,
					to: end,
					enter(node) {
						// Only named nodes come here: the document, and the lines' and tokens' nodes.
						if (node.type.isTop) return undefined;
						test(node);
						return false;
					},
				});
			let inside = false;
			named(from, to, (node) => {
				if (node.to > from && node.from < to) inside = true;
			});
			if (inside) return 0;
			// The end of the last node before `from`, and the start of the first after `to`, in windows that grow.
			let start = 0;
			for (let size = FIRST_WINDOW, edge = from; edge > 0; size *= 2) {
				const low = Math.max(0, edge - size);
				let last = -1;
				named(low, edge, (node) => {
					if (node.to <= from) last = Math.max(last, node.to);
				});
				if (last >= 0) {
					start = last;
					break;
				}
				edge = low;
			}
			let end = tree.length;
			for (let size = FIRST_WINDOW, edge = to; edge < tree.length; size *= 2) {
				const high = Math.min(tree.length, edge + size);
				let first = -1;
				named(edge, high, (node) => {
					if (node.from >= to && (first < 0 || node.from < first)) first = node.from;
				});
				if (first >= 0) {
					end = first;
					break;
				}
				edge = high;
			}
			return Math.max(0, end - start);
		},
	};
}
