import { ensureSyntaxTree, type Language, language, StreamLanguage } from '@codemirror/language';
import { EditorState, Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { editorEditorField, editorInfoField, editorLivePreviewField, MarkdownView } from 'obsidian';
import { hidingRows, type TokenParser } from './hide-rows';
import { lineClassProp, treeRows } from './tree-rows';

/**
 * Obsidian's own table is kept out of a note by a copy of its Markdown language, the plugin's one private change:
 * Obsidian finds a table only by the line class its Markdown mode puts on a table's rows, and the copy puts another
 * one there (hide-rows.ts). Each Live Preview note's editor gets the copy; Source mode and Obsidian's own editors
 * inside cells keep Obsidian's language, and so does everything outside a note, such as a canvas card.
 */

/** Obsidian's languages and their copies; null where one can't be copied. */
const copies = new Map<Language, Language | null>();
/** The copies, to tell them from Obsidian's own. */
const made = new WeakSet<Language>();
/** The language Obsidian gave each note's editor, as the editor showed it. */
const originals = new WeakMap<EditorView, Language>();
/** The language Obsidian gave the last note's editor seen: a new note's editor will have it too. */
let noteLanguage: Language | null = null;

/** Whether a language is the plugin's copy. */
export const isCopy = (lang: Language | null): boolean => !!lang && made.has(lang);

/** The parts of a StreamLanguage the copy reads. They're internal to CodeMirror, and Obsidian's could change. */
interface Streamed {
	streamParser?: TokenParser<unknown> & object;
}

/** A small table, to check the copy marks its rows and only them. */
const SAMPLE = 'Text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nText';

/** Whether a copy marks the sample's three table lines, and nothing else, with the plugin's row class. */
function marksRows(copy: Language): boolean {
	if (!lineClassProp) return false;
	const state = EditorState.create({ doc: SAMPLE, extensions: copy });
	const tree = ensureSyntaxTree(state, state.doc.length, 200);
	if (!tree) return false;
	const rows = treeRows(tree, lineClassProp);
	const found: number[] = [];
	for (let pos = rows.next(0, state.doc.length); pos >= 0; pos = rows.next(pos + 1, state.doc.length)) found.push(state.doc.lineAt(pos).number);
	return found.join(',') === '3,4,5';
}

/** The copy of one of Obsidian's languages, made the first time, or null when it can't be made or doesn't work. */
function copyOf(original: Language): Language | null {
	let copy = copies.get(original);
	if (copy !== undefined) return copy;
	copy = null;
	const parser = (original as unknown as Streamed).streamParser;
	if (original instanceof StreamLanguage && parser && typeof parser.token === 'function') {
		try {
			const candidate = StreamLanguage.define(hidingRows(parser));
			made.add(candidate);
			if (marksRows(candidate)) copy = candidate;
		} catch (error) {
			console.error('Selectable Tables: the copy of the Markdown language failed', error);
		}
	}
	copies.set(original, copy);
	return copy;
}

/**
 * A note's own editor: the editor of a note in a tab, not one of Obsidian's editors inside a table cell, which are
 * set up the same way, nor an editor outside a note.
 */
function inNote(state: EditorState): boolean {
	const view = state.field(editorEditorField, false);
	return state.field(editorInfoField, false) instanceof MarkdownView && !!view && !view.dom.closest('.cm-table-widget');
}

/** The copy an editor's state starts with: as the editor is made, once there's a note's language to copy. */
function startingCopy(state: EditorState): Language | null {
	if (!inNote(state)) return null;
	const view = state.field(editorEditorField, false);
	const original = (view && originals.get(view)) ?? noteLanguage;
	return original ? copyOf(original) : null;
}

/** Puts an editor on a copy it learned of after it was made. */
const learned = StateEffect.define<Language | null>();

/** The copy for this editor, whatever its mode: Source mode leaves it unused. */
const copyField = StateField.define<Language | null>({
	create: startingCopy,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(learned)) value = effect.value;
		return value;
	},
});

/** The editor's language: the copy in Live Preview, and Obsidian's, under it, in Source mode. */
const copyInLivePreview = Prec.highest(
	language.computeN([copyField, editorLivePreviewField], (state) => {
		const copy = state.field(copyField);
		return copy && state.field(editorLivePreviewField, false) ? [copy] : [];
	}),
);

/**
 * Learns the language Obsidian gives a note's editor, and puts the editor on its copy if it isn't already: the
 * first note after Obsidian starts, and any editor made before the plugin knew Obsidian's language. That editor
 * has already parsed its first part on Obsidian's language, a moment before. When the copy can't be made, `failed`
 * hears it.
 */
function learner(failed: () => void) {
	return ViewPlugin.define((view) => {
		const learn = (state: EditorState) => {
			if (!inNote(state)) return;
			const current = state.facet(language);
			if (!current || isCopy(current)) return;
			originals.set(view, current);
			noteLanguage = current;
			const copy = copyOf(current);
			if (!copy) {
				failed();
				return;
			}
			if (state.field(copyField) === copy) return;
			queueMicrotask(() => {
				if (view.state.field(copyField, false) !== undefined && view.state.field(copyField) !== copy) view.dispatch({ effects: learned.of(copy) });
			});
		};
		learn(view.state);
		return {
			update(update: ViewUpdate) {
				if (update.startState.facet(language) !== update.state.facet(language)) learn(update.state);
			},
		};
	});
}

/** The language copy, for a Live Preview note's editor. `failed` hears it each time an editor finds it can't be made. */
export function languageCopy(failed: () => void): Extension {
	return [copyField, copyInLivePreview, learner(failed)];
}

/** For the check script: Obsidian's language for notes, as last seen or as this note's editor has it, and its copy. */
export function knownLanguages(view: EditorView): { obsidian: Language | null; copy: Language | null } {
	const current = view.state.facet(language);
	const obsidian = noteLanguage ?? (current && !isCopy(current) ? current : null);
	return { obsidian, copy: obsidian ? copyOf(obsidian) : null };
}
