import * as cmLanguage from '@codemirror/language';
import { ensureSyntaxTree, type Language, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { NodeProp, TreeCursor } from '@lezer/common';
import { editorInfoField, type IconName, MarkdownView, type Menu, Notice } from 'obsidian';
import { boundsOf } from '../editor/decide';
import { openCells } from '../editor/layout';
import { writtenByObsidian } from '../editor/table-text';
import { cellFormatter } from './cell-editor';
import { writeCells } from './cell-write';
import { cellsIn, documentOf, type Stand, targetsIn, withMark } from './format-cells';
import { knownLanguages } from './language';
import { linesOf, selectedCells, submenuOf, writeLines } from './table-commands';
import { lineClassProp } from './tree-rows';

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
 * - **On a selected cell or a range,** Obsidian's own method runs on a stand-in for the editor, whose document is the
 *   table cut down to the cells' rows and columns, parsed by Obsidian's own Markdown language for notes, as it parses
 *   its own table, and whose formatting ranges are the cells' text: so its rules are Obsidian's (the first cell decides
 *   on a range, a highlight's colors, Comment only coming off when every cell has one). Its changes are read back cell
 *   by cell and written to the note as an open cell writes, in one step Undo takes back alone, with the cell or range
 *   still selected.
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
 * The cells' new text after Obsidian's `method` acts on them all at once, as on its own range, or the texts as they
 * were when it changes nothing: null when it can't run, and 'unread' when its change can't be read back cell by cell.
 */
function formatted(stand: Stand, language: Language, proto: object, method: Method, args: readonly unknown[]): string[] | 'same' | 'unread' | null {
	const { doc, ranges } = stand;
	const state = parsed(doc, language);
	if (!state) return null;
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
	if (!spec.sent?.changes) return 'same';
	return stand.textsAfter(state.changes(spec.sent.changes).apply(state.doc).toString()) ?? 'unread';
}

/** A stand-in's document, parsed to its end by `language`, or null when it can't be. */
function parsed(doc: string, language: Language): EditorState | null {
	let state = EditorState.create({ doc, extensions: language });
	// Parsed to the end before Obsidian reads it: a new state parses only its start, and a transaction then takes in the
	// rest that `ensureSyntaxTree` parsed.
	if (!ensureSyntaxTree(state, state.doc.length, 5000)) return null;
	state = state.update({}).state;
	return syntaxTree(state).length < state.doc.length ? null : state;
}

/** Formatting on the note's selected cell or range of the plugin's table: whether there was one to act on. */
function formatCells(view: EditorView, editor: object, name: Formatting, args: readonly unknown[]): boolean {
	const found = selectedCells(view);
	if (!found) return false;
	const { table, own, cell, anchor } = found;
	const lines = linesOf(view, table);
	const targets = targetsIn(lines, anchor ? cellsIn(boundsOf(anchor, cell)) : [cell]);
	if (!targets.length) return true;
	const method = methodOf(editor, name);
	// Obsidian's language for notes, which the plugin's copy is made from: it reads a table's cells as Obsidian's range does.
	const language = knownLanguages(view).obsidian;
	let texts: string[] | 'same' | 'unread' | null = null;
	try {
		texts = method && language && formatted(documentOf(lines, targets), language, Object.getPrototypeOf(editor) as object, method, args);
	} catch (error) {
		cantFormat(error);
		return true;
	}
	if (texts === 'same') return true;
	if (texts === 'unread') {
		// A cell's text ran on into another's: nothing is written rather than a cell put in the wrong place.
		console.warn('Selectable Tables: formatting changed the cells in a way that could not be read back');
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
		Object.defineProperty(editor, name, {
			configurable: true,
			writable: true,
			value(this: { cm?: unknown }, ...args: unknown[]) {
				const view = this.cm;
				if (view instanceof EditorView && handOver(this, view, name, args)) return;
				// Looked up as it runs, so a change another plugin makes to Obsidian's method later still runs here.
				const original = methodOf(this, name);
				return original ? Reflect.apply(original, this, args) : undefined;
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

// The range menu's Format submenu ----------------------------------------------------------------------------------------

/**
 * The node prop holding a token's classes in Obsidian's syntax tree. Obsidian's own copy of @codemirror/language exports
 * it, as it does the line classes (tree-rows.ts); CodeMirror's doesn't, so it's read by name. Null where it's missing,
 * and then nothing in the submenu is checked.
 */
const tokenClassProp: NodeProp<string> | null = (cmLanguage as unknown as { tokenClassNodeProp?: NodeProp<string> }).tokenClassNodeProp ?? null;

/** The formatting a cell's text has throughout, as Obsidian's range menu reads its first cell for its checkmarks. */
export interface Formats {
	bold: boolean;
	italic: boolean;
	strikethrough: boolean;
	highlight: boolean;
	/** The highlight's color, or '' for the default one. */
	highlightColor: string;
	code: boolean;
	math: boolean;
	comment: boolean;
}

const NO_FORMATS: Formats = { bold: false, italic: false, strikethrough: false, highlight: false, highlightColor: '', code: false, math: false, comment: false };

/** Each kind of formatting and the class its text's tokens carry. */
const KINDS = { italic: 'em', code: 'inline-code', comment: 'comment', bold: 'strong', highlight: 'highlight', strikethrough: 'strikethrough', math: 'math' } as const;
type Kind = keyof typeof KINDS;

/** A highlight's color, from the character after its `==`, as Obsidian writes them (1.15.1). */
const HIGHLIGHT_COLORS: Record<string, string> = {
	'\u{1F534}': 'red',
	'\u{1F7E5}': 'red',
	'\u{1F7E0}': 'orange',
	'\u{1F7E7}': 'orange',
	'\u{1F7E1}': 'yellow',
	'\u{1F7E8}': 'yellow',
	'\u{1F7E2}': 'green',
	'\u{1F7E9}': 'green',
	'\u{1F535}': 'blue',
	'\u{1F7E6}': 'blue',
	'\u{1F7E3}': 'purple',
	'\u{1F7EA}': 'purple',
};

/** The classes of the node a cursor is on. */
const classesAt = (cursor: TreeCursor, prop: NodeProp<string>) => new Set((cursor.type.prop(prop) ?? '').split(' '));

/**
 * The formatting a cell's text has throughout, read from a parsed table as Obsidian's range menu reads its first cell
 * (1.15.1's `bd`, for one line): each kind holds only while every token from the text's start to its end that isn't
 * formatting carries it, with no text between tokens.
 */
function formatsAt(state: EditorState, { from, to }: { from: number; to: number }, prop: NodeProp<string>): Formats {
	const cursor = syntaxTree(state).cursor();
	let left: Partial<Record<Kind, string>> = { ...KINDS };
	let seen = false;
	cursor.moveTo(from, -1);
	// The row's own node holds its tokens: from inside it, the token at the text's start.
	if (!cursor.node.parent || (lineClassProp && (cursor.node.type.prop(lineClassProp) ?? '').includes('table'))) cursor.moveTo(from, 1);
	let at = cursor.from;
	if (!cursor.node.parent) left = {};
	for (;;) {
		const classes = classesAt(cursor, prop);
		for (const kind of Object.keys(left) as Kind[]) {
			if (classes.has('formatting')) continue;
			seen = true;
			if (!classes.has(left[kind]!)) delete left[kind];
		}
		if (at < cursor.from) left = {};
		at = cursor.to;
		if (at >= to || !cursor.next()) break;
	}
	if (at < to || !seen) left = {};
	if (left.math) {
		while (cursor.prevSibling()) {
			const classes = classesAt(cursor, prop);
			if (!classes.has('format-math-begin')) continue;
			if (classes.has('math-block')) delete left.math;
			break;
		}
	}
	let highlightColor = '';
	if (left.highlight) {
		// The highlight's opening `==`, and the character after it.
		syntaxTree(state).iterate({
			from,
			to,
			enter: (node) => {
				const classes = new Set((node.type.prop(prop) ?? '').split(' '));
				if (!classes.has('formatting') || !classes.has('highlight') || highlightColor) return;
				const after = state.sliceDoc(node.from + 2, node.from + 4);
				const code = after.codePointAt(0);
				highlightColor = code === undefined ? '' : (HIGHLIGHT_COLORS[String.fromCodePoint(code)] ?? '');
				return false;
			},
		});
	}
	return { bold: !!left.bold, italic: !!left.italic, strikethrough: !!left.strikethrough, highlight: !!left.highlight, highlightColor, code: !!left.code, math: !!left.math, comment: !!left.comment };
}

/**
 * The formatting the note's selected range's first cell has throughout, as Obsidian's range menu reads it for its
 * checkmarks: its text in a stand-in table, parsed by Obsidian's own language for notes. An empty cell has none.
 */
export function firstCellFormats(view: EditorView): Formats {
	const found = selectedCells(view);
	const language = knownLanguages(view).obsidian;
	if (!found || !language || !tokenClassProp) return NO_FORMATS;
	const { top, left } = boundsOf(found.anchor ?? found.cell, found.cell);
	const lines = linesOf(view, found.table);
	const targets = targetsIn(lines, [{ row: top, column: left }]);
	if (!targets.length) return NO_FORMATS;
	const stand = documentOf(lines, targets);
	try {
		const state = parsed(stand.doc, language);
		return state ? formatsAt(state, stand.ranges[0]!, tokenClassProp) : NO_FORMATS;
	} catch (error) {
		console.error('Selectable Tables: reading a cell\'s formatting failed', error);
		return NO_FORMATS;
	}
}

/** Obsidian's highlight colors, in its order, with their names and swatch icons (see `highlightIcons` in preview.ts). */
export const HIGHLIGHTS = [
	{ color: 'red', name: 'Red' },
	{ color: 'orange', name: 'Orange' },
	{ color: 'yellow', name: 'Yellow' },
	{ color: 'green', name: 'Green' },
	{ color: 'blue', name: 'Blue' },
	{ color: 'purple', name: 'Purple' },
] as const;

/** A highlight color's swatch icon, which the plugin adds: Obsidian's own swatch isn't an icon a plugin can set. */
export const swatchIcon = (color: string) => `selectable-tables-highlight-${color}`;

/**
 * The range menu's Format submenu, as Obsidian's range has it (1.15.1's `T5`, in section `selection`): Bold, Italic,
 * Strikethrough and Highlight, with its colors; Code, Math and Comment; then Clear formatting. Each calls the note's
 * `Editor`, which hands formatting over to the selected cells, as the formatting commands do; each is checked when the
 * range's first cell has it throughout.
 */
export function formatItems(menu: Menu, view: EditorView): void {
	const info = view.state.field(editorInfoField, false);
	const editor = info instanceof MarkdownView ? (info.editor as unknown as Record<string, unknown>) : null;
	if (!editor) return;
	const run = (name: Formatting, ...args: unknown[]) => () => {
		const method = editor[name];
		if (typeof method === 'function') Reflect.apply(method, editor, args);
	};
	const has = firstCellFormats(view);
	menu.addItem((item) => {
		item.setSection('selection').setTitle('Format').setIcon('lucide-paintbrush');
		const sub = submenuOf(item);
		// Without a submenu, the items follow the title in the menu itself.
		if (!sub) item.setIsLabel(true);
		const into = sub ?? menu;
		const section = (name: string) => (sub ? `selection.${name}` : 'selection');
		const add = (name: string, title: string, icon: IconName, checked: boolean | null, onClick: () => void) =>
			into.addItem((entry) => {
				entry.setSection(section(name)).setTitle(title).setIcon(icon).onClick(onClick);
				if (checked !== null) entry.setChecked(checked);
			});
		add('basic', 'Bold', 'lucide-bold', has.bold, run('toggleMarkdownFormatting', 'bold'));
		add('basic', 'Italic', 'lucide-italic', has.italic, run('toggleMarkdownFormatting', 'italic'));
		add('basic', 'Strikethrough', 'lucide-strikethrough', has.strikethrough, run('toggleMarkdownFormatting', 'strikethrough'));
		const color = has.highlight ? has.highlightColor : null;
		into.addItem((entry) => {
			entry.setSection(section('basic')).setTitle('Highlight').setIcon('lucide-highlighter');
			const colors = submenuOf(entry);
			if (!colors) {
				// Without a submenu, the default highlight.
				entry.setChecked(color !== null).onClick(run('toggleHighlight', ''));
				return;
			}
			colors.addItem((each) => each.setTitle('Default').setIcon('lucide-highlighter').setChecked(color === '').onClick(run('toggleHighlight', '')));
			for (const { color: name, name: title } of HIGHLIGHTS) colors.addItem((each) => each.setTitle(title).setIcon(swatchIcon(name)).setChecked(color === name).onClick(run('toggleHighlight', name)));
		});
		add('advanced', 'Code', 'lucide-code-2', has.code, run('toggleMarkdownFormatting', 'code'));
		add('advanced', 'Math', 'lucide-sigma', has.math, run('toggleMarkdownFormatting', 'math'));
		add('advanced', 'Comment', 'lucide-percent', has.comment, run('toggleComment'));
		add('danger', 'Clear formatting', 'lucide-eraser', null, run('clearMarkdownFormatting'));
	});
}
