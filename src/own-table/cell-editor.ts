import { defaultKeymap, insertNewline } from '@codemirror/commands';
import { type Language, StreamLanguage, type StreamParser } from '@codemirror/language';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { EditorView, type KeyBinding, keymap, type ViewUpdate } from '@codemirror/view';
import type { App, MarkdownView } from 'obsidian';
import { inOwnCell } from '../editor/layout';

/**
 * The editor an open cell of the plugin's table edits in: Obsidian's own Markdown editor, borrowed, as Obsidian builds
 * its own cells from it, or a plain one of the plugin's when that can't be had. The borrowed editor brings Live Preview,
 * link and tag suggestions, paired brackets, spell check, Obsidian's paste and other plugins' editor extensions.
 *
 * Every private call it takes is in this module, read from Obsidian 1.15.1, and checked before use (`missingPiece`):
 *
 * 1. The base Markdown editor class: the first class up from `MarkdownView.editMode` that has `editTableCell`, made
 *    with `(app, containerEl, owner)`.
 * 2. Its `set`, `cm`, `editorEl`, `sourceMode`, `buildLocalExtensions`, `onUpdate` and `destroy`, besides the public
 *    `load` and `unload`.
 * 3. The `activeCM` getter of `editMode` and the `inTableCell` getter of the note's `Editor`, answered for the open cell.
 * 4. `app.workspace.editorSuggest.isShowingSuggestion()`.
 * 5. `window.CodeMirror.getMode`, with the `hypermd` mode and the options of Obsidian's own cell's language.
 * 6. The base editor's own `editor`, Obsidian's `Editor` over the cell's view, whose formatting methods the note's
 *    editor hands an open cell's formatting to (formatting.ts). Without it, formatting in a cell acts as before.
 */

/** What the cell needs from its editor. */
export interface CellEditor {
	readonly view: EditorView;
	readonly borrowed: boolean;
	destroy(): void;
}

/** What the open cell gives its editor: its keys, its other extensions, and what to do with each update. */
export interface CellHooks {
	keys: readonly KeyBinding[];
	/** Its own handlers for the editor's events, ahead of Obsidian's: a paste of cells copied from a table. */
	events: Extension;
	/** Extensions the plain editor takes besides its keys, as Obsidian loads the plugin's into the borrowed one. */
	plain: Extension;
	onUpdate(update: ViewUpdate): void;
}

interface Owner {
	editMode?: object & { editor?: object };
	editor?: { cm?: unknown };
}

/** The base editor's instance, as the cell uses it. */
interface BaseEditor {
	cm: EditorView;
	editor?: object;
	editorEl: HTMLElement;
	sourceMode: boolean;
	set(text: string, clear?: boolean): void;
	buildLocalExtensions(): Extension[];
	onUpdate(update: ViewUpdate, typed: boolean): void;
	load(): void;
	unload(): void;
	destroy(): void;
}

type BaseClass = new (app: App, containerEl: HTMLElement, owner: unknown) => BaseEditor;

interface Modes {
	getMode?: (config: object, spec: object) => StreamParser<unknown>;
}

/** The base Markdown editor's class, from a note's edit mode: piece 1. */
function baseClass(editMode: object | undefined): BaseClass | null {
	let proto = editMode ? (Object.getPrototypeOf(editMode) as object | null) : null;
	while (proto && !Object.prototype.hasOwnProperty.call(proto, 'editTableCell')) proto = Object.getPrototypeOf(proto) as object | null;
	const ctor = (proto as { constructor?: unknown } | null)?.constructor;
	return typeof ctor === 'function' ? (ctor as BaseClass) : null;
}

/** A getter up an object's prototypes, to call on the object: piece 3. */
function getterOf(object: object, name: string): ((on: object) => unknown) | null {
	for (let proto = Object.getPrototypeOf(object) as object | null; proto; proto = Object.getPrototypeOf(proto) as object | null) {
		const descriptor: { get?: (this: void) => unknown } | undefined = Object.getOwnPropertyDescriptor(proto, name);
		const get = descriptor?.get;
		if (get) return (on) => Reflect.apply(get, on, []) as unknown;
	}
	return null;
}

const METHODS = ['set', 'buildLocalExtensions', 'onUpdate', 'destroy', 'load', 'unload'] as const;

/** Which private piece the borrowed editor can't find in this Obsidian, or null when it has them all. */
export function missingPiece(app: App, owner: Owner | null): string | null {
	const editMode = owner?.editMode;
	const Base = baseClass(editMode);
	if (!Base) return 'the base Markdown editor class';
	const missing = METHODS.find((name) => typeof (Base.prototype as Record<string, unknown>)[name] !== 'function');
	if (missing) return `the base editor's ${missing}`;
	if (!editMode || !getterOf(editMode, 'activeCM')) return "the edit mode's activeCM";
	if (!editMode.editor || !getterOf(editMode.editor, 'inTableCell')) return "the editor's inTableCell";
	const suggest = (app.workspace as unknown as { editorSuggest?: { isShowingSuggestion?: unknown } }).editorSuggest;
	if (typeof suggest?.isShowingSuggestion !== 'function') return 'editorSuggest.isShowingSuggestion';
	if (!cellLanguage()) return "CodeMirror's hypermd mode";
	return null;
}

/** Whether link or tag suggestions show, which take the arrows, Enter, Tab and Escape first: piece 4. */
export function suggesting(app: App): boolean {
	const suggest = (app.workspace as unknown as { editorSuggest?: { isShowingSuggestion?: () => boolean } }).editorSuggest;
	return !!suggest?.isShowingSuggestion?.();
}

let language: Language | null | undefined;

/**
 * The Markdown language Obsidian's own cell editor has, read from 1.15.1: its CodeMirror 5 HyperMD mode without
 * tables, lists, headings, quotes, code blocks or rules. Obsidian keeps its copy private, so it's built the same way
 * from the global CodeMirror's modes, once, in the main window: piece 5. Without it nothing in the cell is parsed,
 * and Live Preview shows nothing.
 */
function cellLanguage(): Language | null {
	if (language !== undefined) return language;
	const modes = (window as unknown as { CodeMirror?: Modes }).CodeMirror;
	try {
		const mode = modes?.getMode?.({}, { name: 'hypermd', front_matter: false, table: false, fencedCodeBlockHighlighting: false, taskLists: false, headers: false, blockquotes: false, indentedCode: false, lists: false, hr: false, blockId: false });
		language = mode && typeof mode.token === 'function' ? StreamLanguage.define(mode) : null;
	} catch (error) {
		console.error('Selectable Tables: no Markdown language for a cell', error);
		language = null;
	}
	return language;
}

/** The hooks of the borrowed editor being made: its base class builds its extensions in its constructor. */
let making: CellHooks | null = null;
const borrowedClasses = new WeakMap<BaseClass, new (app: App, holder: HTMLElement, owner: unknown, hooks: CellHooks) => BaseEditor>();

function borrowedClass(Base: BaseClass) {
	let Borrowed = borrowedClasses.get(Base);
	if (Borrowed) return Borrowed;
	Borrowed = class extends Base {
		hooks: CellHooks;
		constructor(app: App, holder: HTMLElement, owner: unknown, hooks: CellHooks) {
			making = hooks;
			try {
				super(app, holder, owner);
			} finally {
				making = null;
			}
			this.hooks = hooks;
		}

		buildLocalExtensions(): Extension[] {
			const extensions = super.buildLocalExtensions();
			const hooks = (this as { hooks?: CellHooks }).hooks ?? making;
			const lang = cellLanguage();
			if (lang) extensions.push(lang);
			extensions.push(inOwnCell.of(true));
			if (hooks) extensions.push(Prec.high(keymap.of(hooks.keys)), Prec.high(hooks.events));
			return extensions;
		}

		onUpdate(update: ViewUpdate, typed: boolean): void {
			super.onUpdate(update, typed);
			(this as { hooks?: CellHooks }).hooks?.onUpdate(update);
		}
	};
	borrowedClasses.set(Base, Borrowed);
	return Borrowed;
}

/** Obsidian's `Editor` of each borrowed cell editor, by its view: piece 6. */
const formatters = new WeakMap<EditorView, object>();

/** The `Editor` Obsidian's own base editor made for a borrowed cell's editor, or null for a plain one. */
export function cellFormatter(view: EditorView): object | null {
	return formatters.get(view) ?? null;
}

/** The open cell's editor, by the edit mode it answers for: commands that ask the note's editor get it. */
const answering = new WeakMap<object, EditorView>();
const answered = new Set<object>();

/**
 * Has the note's editor answer for the open cell, as for Obsidian's own: `activeCM` gives the cell's editor, so
 * `focus` and `exec` go there, and `inTableCell` is true, so Toggle checkbox, lists, quotes and callouts leave the
 * table's row alone. Answered with instance getters, taken off when the plugin unloads.
 */
function answerFor(editMode: object & { editor?: object }, view: EditorView): void {
	answering.set(editMode, view);
	if (answered.has(editMode)) return;
	const activeCM = getterOf(editMode, 'activeCM');
	const editor = editMode.editor;
	const inTableCell = editor ? getterOf(editor, 'inTableCell') : null;
	if (!activeCM || !editor || !inTableCell) return;
	Object.defineProperty(editMode, 'activeCM', {
		configurable: true,
		get(this: object) {
			return answering.get(this) ?? activeCM(this);
		},
	});
	Object.defineProperty(editor, 'inTableCell', {
		configurable: true,
		get(this: { editorComponent?: object }) {
			return (!!this.editorComponent && answering.has(this.editorComponent)) || inTableCell(this);
		},
	});
	answered.add(editMode);
}

function stopAnswering(editMode: object, view: EditorView): void {
	if (answering.get(editMode) === view) answering.delete(editMode);
}

/** Takes the getters off every note's editor, as the plugin unloads. */
export function stopAnsweringAll(): void {
	for (const editMode of answered) {
		delete (editMode as { activeCM?: unknown }).activeCM;
		const editor = (editMode as { editor?: object }).editor;
		if (editor) delete (editor as { inTableCell?: unknown }).inTableCell;
	}
	answered.clear();
}

/**
 * Obsidian's own Markdown editor in `holder`, owned by the note, holding `text`. Throws when a private piece it
 * reaches isn't what it was in 1.15.1.
 */
function makeBorrowed(app: App, owner: MarkdownView, holder: HTMLElement, text: string, hooks: CellHooks): CellEditor {
	const editMode = (owner as unknown as Owner).editMode!;
	const Borrowed = borrowedClass(baseClass(editMode)!);
	const editor = new Borrowed(app, holder, owner, hooks);
	let loaded = false;
	try {
		if (!(editor.cm instanceof EditorView) || !editor.editorEl?.instanceOf?.(HTMLElement)) throw new Error('the base editor has no cm or editorEl');
		// As Obsidian's own cell does: no source view's look, and Live Preview whatever the note's mode.
		editor.editorEl.removeClass('markdown-source-view');
		editor.sourceMode = false;
		editor.set(text);
		editor.load();
		loaded = true;
	} catch (error) {
		if (loaded) editor.unload();
		editor.destroy();
		throw error;
	}
	const view = editor.cm;
	answerFor(editMode, view);
	if (editor.editor) formatters.set(view, editor.editor);
	return {
		view,
		borrowed: true,
		destroy() {
			formatters.delete(view);
			stopAnswering(editMode, view);
			editor.unload();
			editor.destroy();
		},
	};
}

/** The plugin's own CodeMirror editor: public calls only, the cell's Markdown as text, no history of its own. */
function makePlain(note: EditorView, owner: MarkdownView | null, holder: HTMLElement, text: string, hooks: CellHooks): CellEditor {
	const spellcheck = note.contentDOM.getAttribute('spellcheck') === 'true' ? 'true' : 'false';
	const view = new EditorView({
		parent: holder,
		state: EditorState.create({
			doc: text,
			extensions: [
				inOwnCell.of(true),
				hooks.plain,
				Prec.high(keymap.of(hooks.keys)),
				Prec.high(hooks.events),
				keymap.of([{ key: 'Shift-Enter', run: insertNewline }, ...defaultKeymap]),
				EditorView.lineWrapping,
				EditorView.contentAttributes.of({ spellcheck, autocorrect: 'on', autocapitalize: 'on' }),
				EditorView.updateListener.of((update) => hooks.onUpdate(update)),
			],
		}),
	});
	const editMode = (owner as unknown as Owner | null)?.editMode;
	if (editMode) answerFor(editMode, view);
	return {
		view,
		borrowed: false,
		destroy() {
			if (editMode) stopAnswering(editMode, view);
			view.destroy();
		},
	};
}

/** Why cells open in the plain editor, once one was found: a missing piece, an error, or the preview's command. */
let fallback: string | null = null;
let forced = false;
let told = false;

/** For the preview's command and the check script: cells open in the plain editor, or borrowed again. */
export function forcePlain(on: boolean): void {
	forced = on;
}

export const plainForced = () => forced;

/** Why cells open in the plain editor now, or null when they open borrowed. */
export function plainBecause(): string | null {
	return forced ? 'forced' : fallback;
}

/** For the check script: forget a fallback found, as after a restart, so the next cell checks again. */
export function resetFallback(): void {
	fallback = null;
	told = false;
}

/**
 * The editor for a cell that opens now: borrowed while every private piece is there, else plain until Obsidian
 * restarts. A borrowed editor that fails to build falls back the same way, its error in the console. `notice` hears,
 * once, that cells open in the plain editor because of an Obsidian update.
 */
export function makeCellEditor(app: App, note: EditorView, owner: MarkdownView | null, holder: HTMLElement, text: string, hooks: CellHooks, notice: (why: string) => void): CellEditor {
	if (!forced && !fallback) {
		const missing = owner && (owner as unknown as Owner).editor?.cm === note ? missingPiece(app, owner as unknown as Owner) : 'the note that owns the cell';
		if (!missing) {
			try {
				return makeBorrowed(app, owner!, holder, text, hooks);
			} catch (error) {
				console.error('Selectable Tables: Obsidian\'s editor could not be borrowed for a cell', error);
				fallback = 'an error';
				holder.empty();
			}
		} else fallback = missing;
		if (!told) {
			told = true;
			notice(fallback);
		}
	}
	return makePlain(note, owner, holder, text, hooks);
}
