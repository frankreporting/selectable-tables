import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { editorInfoField, MarkdownView, Notice } from 'obsidian';
import { boundsOf } from '../editor/decide';
import { openCells } from '../editor/layout';
import { writtenByObsidian } from '../editor/table-text';
import { cellFormatter, cellLanguage } from './cell-editor';
import { writeCells } from './cell-write';
import { cellsIn, documentOf, type Target, targetsIn, textsIn, withMark } from './format-cells';
import { linesOf, selectedCells, writeLines } from './table-commands';

/**
 * Obsidian's formatting on the plugin's table, in a preview build: Bold, Italic, Strikethrough, Highlight, Code, Math,
 * Comment and Clear formatting act on a selected cell's text, or on every cell of a range, as on Obsidian's own range
 * of cells, and in an open cell they take formatting off as well as add it.
 *
 * Every formatting command and the Formatting submenu call one of four methods of the note's `Editor` (read from
 * 1.15.1): `toggleMarkdownFormatting(kind)`, `toggleHighlight(color?)`, `toggleComment()` and
 * `clearMarkdownFormatting()`. Each acts on `getFormattingRanges()`, the cells of Obsidian's range or else the
 * selection, and reads what's already formatted from the syntax tree of `cm`, the note's view. The note's tree has
 * nothing inside the plugin's tables (hide-rows.ts), so on their own they only ever add formatting there, and on a
 * selected cell the edit guard stops them, since the note's selection is the whole table.
 *
 * So each note's `Editor` gets the four as instance methods, while the plugin's table is drawn, which hand over:
 *
 * - **On a selected cell or a range,** Obsidian's own method runs on a stand-in for the editor, whose document holds
 *   the cells' text alone, parsed by the Markdown language of Obsidian's own cells, and whose formatting ranges are
 *   the cells: so its rules are Obsidian's (the first cell decides on a range, a highlight's colors, Comment only coming
 *   off when every cell has one). Its changes are read back cell by cell and written to the note as an open cell writes,
 *   in one step Undo takes back alone, with the cell or range still selected.
 * - **In an open cell,** the cell's own `Editor`, which Obsidian's base editor made over the cell's view, with the
 *   cell's Markdown language, runs it: it reads the cell's formatting, and its change reaches the note as typing does.
 * - **Anywhere else,** Obsidian's method runs as it would: Obsidian's table, text, a table selected whole.
 *
 * Private, each checked before use: the four methods' names on the `Editor`, the `cm` it holds, the stand-in's
 * `getFormattingRanges`, `getTableSelection` and `focus`, which those methods call, and the base editor's own `editor`
 * (cell-editor.ts, piece 6).
 */

export const FORMATTING = ['toggleMarkdownFormatting', 'toggleHighlight', 'toggleComment', 'clearMarkdownFormatting'] as const;
export type Formatting = (typeof FORMATTING)[number];

type Method = (...args: unknown[]) => unknown;

/** Obsidian's own method, up an object's prototypes, past any of the instance's own. */
function methodOf(object: object, name: Formatting): Method | null {
	for (let proto = Object.getPrototypeOf(object) as object | null; proto; proto = Object.getPrototypeOf(proto) as object | null) {
		const value: unknown = Object.getOwnPropertyDescriptor(proto, name)?.value;
		if (typeof value === 'function') return value as Method;
	}
	return null;
}

/** Says once that formatting can't reach selected cells in this Obsidian. */
let told = false;
function cantFormat(why: unknown): void {
	if (why) console.error('Selectable Tables: formatting on selected cells failed', why);
	if (told) return;
	told = true;
	new Notice("Selectable Tables can't format selected cells in this version of Obsidian.");
}

/**
 * The cells' new text after Obsidian's `method` acts on them all at once, as on its own range: null when it can't run.
 * Unchanged texts come back as they were.
 */
function formatted(texts: readonly string[], proto: object, method: Method, args: readonly unknown[]): string[] | null {
	const language = cellLanguage();
	if (!language) return null;
	const { doc, ranges } = documentOf(texts);
	let state = EditorState.create({ doc, extensions: language });
	// Parsed to the end before Obsidian reads it: a new state parses only its start, and a transaction then takes in the
	// rest that `ensureSyntaxTree` parsed.
	if (!ensureSyntaxTree(state, state.doc.length, 5000)) return null;
	state = state.update({}).state;
	if (syntaxTree(state).length < state.doc.length) return null;
	const spec: { sent: TransactionSpec | null } = { sent: null };
	const standIn = Object.assign(Object.create(proto) as object, {
		cm: {
			state,
			dispatch(sent: TransactionSpec) {
				spec.sent = sent;
			},
		},
		getFormattingRanges: () => ranges.map(({ from, to }) => EditorSelection.range(from, to)),
		// Not empty, as on Obsidian's range: only its length is read.
		getTableSelection: () => ranges,
		focus: () => undefined,
	});
	Reflect.apply(method, standIn, [...args]);
	if (!spec.sent?.changes) return [...texts];
	return textsIn(state.changes(spec.sent.changes).apply(state.doc).toString(), texts.length);
}

/** Formatting on the note's selected cell or range of the plugin's table: whether there was one to act on. */
function formatCells(view: EditorView, editor: object, name: Formatting, args: readonly unknown[]): boolean {
	const found = selectedCells(view);
	if (!found) return false;
	const { table, own, cell, anchor } = found;
	const lines = linesOf(view, table);
	const targets: Target[] = targetsIn(lines, anchor ? cellsIn(boundsOf(anchor, cell)) : [cell]);
	if (!targets.length) return true;
	const method = methodOf(editor, name);
	let texts: string[] | null = null;
	try {
		texts = method && formatted(targets.map(({ text }) => text), Object.getPrototypeOf(editor) as object, method, args);
	} catch (error) {
		cantFormat(error);
		return true;
	}
	if (!texts) {
		cantFormat(null);
		return true;
	}
	const changed = targets.flatMap((target, index) => (texts[index] === target.text ? [] : [{ cell: target.cell, text: withMark(target, texts[index]!) }]));
	if (!changed.length) return true;
	writeLines(view, table, own, writeCells(lines, changed, writtenByObsidian(view.state.doc, table)), cell, anchor);
	return true;
}

/**
 * Formatting the note's editor hands over, on the plugin's table: to an open cell's own `Editor`, or to the selected
 * cells. False leaves it to Obsidian's method, as on Obsidian's table, in text, or on a cell open in the plain editor.
 */
function handOver(editor: object, view: EditorView, name: Formatting, args: readonly unknown[]): boolean {
	const open = openCells.get(view);
	if (open && open.note === view) {
		const formatter = cellFormatter(open.view);
		const method = formatter && (formatter as Record<string, unknown>)[name];
		if (typeof method !== 'function') return false;
		Reflect.apply(method, formatter, [...args]);
		return true;
	}
	return formatCells(view, editor, name, args);
}

/** The note editors that format the plugin's table, to give their own methods back as the plugin unloads. */
const taken = new Set<object>();

/** Has a note's `Editor` hand its formatting over on the plugin's table. Says whether it could. */
function takeOver(editor: object): boolean {
	if (taken.has(editor)) return true;
	if (!FORMATTING.every((name) => methodOf(editor, name))) return false;
	for (const name of FORMATTING) {
		const original = methodOf(editor, name)!;
		Object.defineProperty(editor, name, {
			configurable: true,
			writable: true,
			value(this: { cm?: unknown }, ...args: unknown[]) {
				const view = this.cm;
				if (view instanceof EditorView && handOver(this, view, name, args)) return;
				return Reflect.apply(original, this, args);
			},
		});
	}
	taken.add(editor);
	return true;
}

function giveBack(editor: object): void {
	if (!taken.delete(editor)) return;
	for (const name of FORMATTING) delete (editor as Record<string, unknown>)[name];
}

/** Gives every note's editor its own formatting back, as the plugin unloads. */
export function giveBackAll(): void {
	for (const editor of [...taken]) giveBack(editor);
}

/**
 * For each note's editor while the plugin draws its tables: its `Editor` hands formatting over, from when the editor
 * holds a note, and has its own back when the plugin's table stops being drawn there.
 */
export const formattingOnCells = ViewPlugin.define((view) => {
	let editor: object | null = null;
	const find = () => {
		if (editor) return;
		const info = view.state.field(editorInfoField, false);
		const candidate = info instanceof MarkdownView ? (info.editor as unknown as { cm?: unknown }) : null;
		if (candidate?.cm === view && takeOver(candidate)) editor = candidate;
	};
	find();
	return {
		update: find,
		destroy() {
			if (editor) giveBack(editor);
		},
	};
});
