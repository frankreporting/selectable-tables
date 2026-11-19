import { ensureSyntaxTree, forceParsing, type Language, language, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension, Prec, StateField, type Text, type Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type PluginValue, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { type App, editorEditorField, Platform } from 'obsidian';
import { noCells, stopsEdit, typeBelow, typesText } from '../editor/decide';
import { viewLayout } from '../editor/layout';
import { frontmatterEnd, type Span } from '../editor/table-text';
import { endOfNextLine, findTables, type Found, lineChange, updateTables } from './find';
import { OBSIDIAN_ROW, ROW_CLASS } from './hide-rows';
import { isCopy, knownLanguages, languageCopy } from './language';
import { availableWidth, forgetMetrics, knownMetrics, metricsFor } from './metrics';
import { Model, skewEstimates } from './model';
import { profile, timed } from './profile';
import { linesOf } from './shape';
import { lineClassProp, treeRows } from './tree-rows';

/**
 * The plugin's own table, for Live Preview notes: it draws each table Obsidian would draw, as one block, with only
 * the rows near the pane in the page. A preview, behind a switch (preview.ts): it can't edit a cell, freeze a table
 * or run the table keys yet, and Obsidian's table controls aren't there.
 */

/** Where Ctrl+Option types nothing, so Ctrl+Alt isn't AltGr. */
const APPLE = Platform.isMacOS || Platform.isIosApp;

/** On every editor while the plugin runs. styles.css scopes what it changes in tables to it. */
const ACTIVE_CLASS = 'selectable-tables';
/** On the editor while a table is selected whole; styles.css hides the caret and frames the table. */
const SELECTED_CLASS = 'selectable-tables-selected';

/**
 * The tables of one editor's state, where each was in this state, and the syntax tree they were found in. The
 * spans are kept here, not read back from the models, which follow the newest state.
 */
interface Tables {
	models: readonly Model[];
	spans: readonly Span[];
	decorations: DecorationSet;
	tree: Tree | null;
}

const EMPTY: Tables = { models: [], spans: [], decorations: Decoration.none, tree: null };

/** A table drawn by the plugin, over the table's whole text. */
class TableBlock extends WidgetType {
	constructor(readonly model: Model) {
		super();
	}

	eq(other: TableBlock): boolean {
		return other.model === this.model;
	}

	toDOM(view: EditorView): HTMLElement {
		return this.model.mount(view, metricsFor(view));
	}

	get estimatedHeight(): number {
		return this.model.shaped ? this.model.height : -1;
	}

	/** Every event in the table is the table's: CodeMirror moves no caret for it. */
	ignoreEvent(): boolean {
		return true;
	}

	coordsAt(dom: HTMLElement, pos: number) {
		return this.model.coordsAt(pos);
	}
}

/** Whether a state's editor draws its own tables: its language is the copy, which hides them from Obsidian. */
const drawsTables = (state: EditorState) => !!lineClassProp && isCopy(state.facet(language));

/**
 * One block per table, over the same text as Obsidian's. A table at the note's start or right below the frontmatter
 * starts exclusively, as Obsidian's does, and one at the note's end ends so.
 */
function decorate(doc: Text, models: readonly Model[]): DecorationSet {
	if (!models.length) return Decoration.none;
	const frontmatter = frontmatterEnd(doc);
	return Decoration.set(
		models.map((model) =>
			Decoration.replace({
				widget: new TableBlock(model),
				block: true,
				inclusiveStart: model.from > 0 && model.from > frontmatter + 1,
				inclusiveEnd: model.to < doc.length,
			}).range(model.from, model.to),
		),
	);
}

/** The runs of lines a language marks with a line class, in a text parsed whole: where it puts tables. */
function runsOf(text: string, lang: Language, lineClass: string): Span[] {
	const state = EditorState.create({ doc: text, extensions: lang });
	const tree = ensureSyntaxTree(state, state.doc.length, 20000);
	const runs: Span[] = [];
	if (!tree || !lineClassProp) return runs;
	const prop = lineClassProp;
	let last = -2;
	tree.iterate({
		enter(node) {
			const classes = node.type.prop(prop);
			if (classes === undefined) return undefined;
			if (` ${classes} `.includes(` ${lineClass} `)) {
				const line = state.doc.lineAt(node.from);
				const run = runs[runs.length - 1];
				if (run && line.number === last + 1) run.to = line.to;
				else runs.push({ from: line.from, to: line.to });
				last = line.number;
			}
			return false;
		},
	});
	return runs;
}

const spansOf = (found: readonly Found[]): Span[] => found.map(({ from, to }) => ({ from, to }));

/** Models after closing, once the update that dropped them is over. */
function retire(models: Iterable<Model>): void {
	const gone = Array.from(models);
	if (gone.length) queueMicrotask(() => gone.forEach((model) => model.destroy()));
}

/** The tables field, the editor plugin and the rest, for one copy of the plugin. */
export function ownTables(app: App, failed: () => void) {
	const select = (model: Model) => {
		const view = model.view;
		if (!view) return;
		if (!view.hasFocus) view.contentDOM.focus({ preventScroll: true });
		view.dispatch({ selection: { anchor: model.from, head: model.to }, userEvent: 'select.pointer' });
	};

	const modelsFor = (state: EditorState, found: readonly Found[], before: readonly Model[]) => {
		const metrics = knownMetrics(state.field(editorEditorField, false) ?? null);
		return found.map((table) => {
			const model = table.was >= 0 ? before[table.was]! : new Model(app, table.from, table.to, select);
			model.from = table.from;
			model.to = table.to;
			// Shaped now, so CodeMirror has its height before it's drawn.
			model.ensureShape(state.doc, metrics);
			return model;
		});
	};

	const create = (state: EditorState): Tables => {
		if (!drawsTables(state)) return EMPTY;
		const tree = timed('tree', () => syntaxTree(state));
		const found = findTables(state.doc, treeRows(tree, lineClassProp!));
		const models = modelsFor(state, found, []);
		return { models, spans: spansOf(found), decorations: decorate(state.doc, models), tree };
	};

	const tables = StateField.define<Tables>({
		create: (state) => timed('field', () => create(state)),
		update: (value, tr) => timed('field', () => updateTablesField(value, tr)),
		provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
	});

	/** The tables after a transaction: the same models where the tables are the same, and new ones for new tables. */
	function updateTablesField(value: Tables, tr: Transaction): Tables {
		const { state, startState } = tr;
		if (!drawsTables(state)) {
			retire(value.models);
			return EMPTY;
		}
		if (!value.tree || startState.facet(language) !== state.facet(language)) {
			retire(value.models);
			return create(state);
		}
		const tree = timed('tree', () => syntaxTree(state));
		if (!tr.docChanged && tree === value.tree) return value;
		const before = value.models;
		const found = updateTables(value.spans, tr.docChanged ? tr.changes : null, value.tree.length, startState.doc, state.doc, treeRows(tree, lineClassProp!));
		// Each table that was there before follows the change: a change in it takes the new text, row by row.
		for (const table of found) {
			if (table.was < 0) continue;
			const model = before[table.was]!;
			const old = value.spans[table.was]!;
			const change = tr.docChanged ? lineChange(tr.changes, startState.doc, state.doc, old.from, endOfNextLine(startState.doc, old.to)) : null;
			model.from = table.from;
			model.to = table.to;
			model.track(startState.doc, state.doc, linesOf(startState.doc, old), change);
		}
		const used = new Set(found.map((table) => table.was));
		retire(before.filter((_, index) => !used.has(index)));
		const models = modelsFor(state, found, before);
		const spans = spansOf(found);
		// Mapped, a block that ends where text is inserted would take in the new text: drawn anew on any change.
		const same = !tr.docChanged && models.length === before.length && models.every((model, i) => model === before[i] && spans[i]!.from === value.spans[i]!.from && spans[i]!.to === value.spans[i]!.to);
		const decorations = same ? value.decorations : decorate(state.doc, models);
		return { models, spans, decorations, tree };
	}

	/** Whether the selection is exactly one of the tables, as a press or Backspace below a table leaves it. */
	const selectedModel = (state: EditorState): Model | null => {
		const { ranges, main } = state.selection;
		if (ranges.length !== 1 || main.empty) return null;
		return state.field(tables, false)?.models.find((model) => main.from === model.from && main.to === model.to) ?? null;
	};

	const attributes = EditorView.editorAttributes.of((view) => ({ class: selectedModel(view.state) ? `${ACTIVE_CLASS} ${SELECTED_CLASS}` : ACTIVE_CLASS }));

	/**
	 * Typing over a table selected whole does nothing, as with the plugin's keys: it would replace the table with a
	 * letter. Typing with a keydown goes below it (`typing`); this stops the rest, such as the emoji picker's.
	 * Deleting, cutting and pasting still act on it, and so does anything that isn't typing.
	 */
	const keepSelectedTable = EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged) return tr;
		const model = selectedModel(tr.startState);
		return model && stopsEdit(tr, model, false) ? [] : tr;
	});

	/**
	 * A key that types on a table selected whole starts a new paragraph below it, as with the plugin's keys, and
	 * its text goes there: the caret moves on the key's keydown, before the text, and before an input method's
	 * composition starts, which mustn't be touched once it runs.
	 */
	const typing = EditorView.domEventHandlers({
		keydown(event, view) {
			if (event.defaultPrevented || event.isComposing || !typesText(event, APPLE) || !selectedModel(view.state)) return false;
			const action = typeBelow({ state: view.state, layout: viewLayout(view), cells: noCells });
			if (action?.type === 'below') view.dispatch({ changes: { from: action.from, to: action.to, insert: action.insert }, selection: EditorSelection.cursor(action.pos), scrollIntoView: true });
			return false;
		},
	});

	const editors = new Set<Editor>();

	class Editor implements PluginValue {
		private models: readonly Model[];
		private width: number;

		constructor(readonly view: EditorView) {
			this.models = view.state.field(tables, false)?.models ?? [];
			this.width = -1;
			view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
			editors.add(this);
		}

		private readonly onScroll = () => {
			for (const model of this.models) if (model.view === this.view && model.shown) model.schedule();
		};

		update(update: ViewUpdate) {
			timed('editor', () => this.catchUp(update));
		}

		private catchUp(update: ViewUpdate) {
			this.models = update.state.field(tables, false)?.models ?? [];
			// The editor's own sizes, once it can be measured: a table shaped before, with another note's sizes or
			// none, in a tab behind another say, is shaped again with them.
			const metrics = this.models.length ? metricsFor(update.view) : null;
			for (const model of this.models) {
				if (model.view !== update.view) continue;
				model.ensureShape(update.state.doc, metrics);
				if (model.behind) model.refresh();
			}
			if (update.selectionSet || update.docChanged) {
				const selected = selectedModel(update.state);
				for (const model of this.models) model.box?.toggleClass('is-selected', model === selected);
			}
			if (update.geometryChanged) {
				update.view.requestMeasure({
					key: this,
					read: (view) => availableWidth(view),
					write: (width, view) => {
						if (this.width >= 0 && Math.abs(width - this.width) >= 1) this.resize(view);
						this.width = width;
					},
				});
			}
			if (update.viewportChanged || update.heightChanged || update.geometryChanged) this.onScroll();
		}

		/** The pane's width or the theme changed: every table is laid out again, once its editor can be measured. */
		resize(view: EditorView) {
			forgetMetrics(view);
			const metrics = metricsFor(view);
			for (const model of this.models) {
				model.resize();
				model.ensureShape(view.state.doc, metrics);
				if (model.view === view) model.refresh();
			}
		}

		destroy() {
			this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
			editors.delete(this);
			retire(this.models);
		}
	}

	return {
		extension: [Prec.highest(tables), languageCopy(failed), ViewPlugin.fromClass(Editor), attributes, keepSelectedTable, Prec.highest(typing)] as Extension,
		/** Obsidian's `css-change`: a new theme, font or snippet, so every table is laid out again. */
		themeChanged() {
			for (const editor of editors) editor.resize(editor.view);
		},
		/** For the check script: an editor's tables, every table found from scratch, and where each parser puts tables. */
		debug: {
			models: (view: EditorView) => view.state.field(tables, false)?.models ?? [],
			scan: (state: EditorState) => (lineClassProp && drawsTables(state) ? findTables(state.doc, treeRows(syntaxTree(state), lineClassProp)) : []),
			drawsTables,
			forceParse: (view: EditorView) => forceParsing(view, view.state.doc.length, 10000),
			/** Runs of lines Obsidian's language marks as table rows, and the copy, in a text parsed whole. */
			runs: (text: string, view: EditorView) => {
				const { obsidian, copy } = knownLanguages(view);
				return { obsidian: obsidian && runsOf(text, obsidian, OBSIDIAN_ROW), copy: copy && runsOf(text, copy, ROW_CLASS) };
			},
			skew: skewEstimates,
			profile,
		},
	};
}
