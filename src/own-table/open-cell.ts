import { redo, undo } from '@codemirror/commands';
import { Annotation, EditorSelection, type Extension, type SelectionRange, Transaction, type TransactionSpec } from '@codemirror/state';
import { Direction, type EditorView, type KeyBinding, type ViewUpdate } from '@codemirror/view';
import { type App, editorInfoField, MarkdownView, Notice } from 'obsidian';
import { writesCell } from '../editor/decide';
import { type OwnCell, openCells } from '../editor/layout';
import { type Cell, type Span, toCellEditor, toCellSource } from '../editor/table-text';
import { type CellEditor, type CellHooks, makeCellEditor, suggesting } from './cell-editor';
import { cellPlace, type Padding, paddingFor, writeCell } from './cell-write';
import type { Click, Model } from './model';
import { timed } from './profile';

/**
 * An open cell of the plugin's table: an editor in the drawn cell, holding the cell's text as Obsidian's own cell holds
 * it, with the note's text always the one that counts. Each change in the cell goes to the note at once, with its user
 * event, so the note's history groups typing as it does for Obsidian's cell, and the note's selection follows the
 * cell's caret, so commands act there. Each change to the note from anywhere else comes back into the cell.
 */

/** Where the caret goes in a cell that opens: its text's start or end, all of it, its last line's start, or a click. */
export type At = 'start' | 'end' | 'all' | 'last-line' | Click | { note: { anchor: number; head: number } };

/** On an open cell's drawn text, hidden by the preview's styles.css while its editor shows. */
const HIDDEN_CLASS = 'selectable-tables-open-text';

/** On a change the cell takes from the note, which isn't written back. */
const fromNote = Annotation.define<boolean>();

/** What the open cell needs from the plugin: its app, its fallback's notice, and the plain editor's extensions. */
export interface CellSetup {
	app: App;
	/** Extensions the plain editor takes besides its own, as Obsidian gives the borrowed one the plugin's. */
	plain: () => Extension;
	/** Escape in the cell: closes it and selects it, in two steps back to the table. */
	escape: (view: EditorView) => void;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The place in a cell's editor after `count` visible characters, counting a line break between its lines. */
function placeAfter(view: EditorView, count: number): number | null {
	let left = count;
	const lines = Array.from(view.contentDOM.querySelectorAll(':scope > .cm-line'));
	for (const [index, line] of lines.entries()) {
		const walker = line.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
			// Widgets, such as a checkbox or a picture, aren't text the drawn cell counted.
			if (text.parentElement?.closest('[contenteditable="false"]')) continue;
			if (left <= text.length) {
				try {
					return view.posAtDOM(text, left);
				} catch {
					return null;
				}
			}
			left -= text.length;
		}
		if (index < lines.length - 1) {
			if (left === 0) return view.posAtDOM(line, line.childNodes.length);
			left--;
		}
	}
	return null;
}

export class OpenCell implements OwnCell {
	readonly editor: CellEditor;
	private readonly holder: HTMLDivElement;
	private readonly shown: HTMLElement | null;
	private padding: Padding;
	private syncing = false;
	private closed = false;
	/** A change from elsewhere waits while a composition runs in the cell. */
	private waiting = false;
	/**
	 * Whether the cell's editor has the keyboard, kept by its focus events: an editor whose element a rewrite took out
	 * of the page no longer says it has the focus, and the note should take it then.
	 */
	private focused = false;

	private constructor(
		private readonly setup: CellSetup,
		readonly model: Model,
		readonly note: EditorView,
		public cell: Cell,
		readonly element: HTMLTableCellElement,
	) {
		const { doc } = note.state;
		const place = cellPlace(doc, model, cell);
		const text = toCellEditor(place?.source ?? '').text;
		this.padding = paddingFor(doc, model, cell);
		this.shown = element.querySelector<HTMLElement>(':scope > .table-cell-wrapper');
		// Hidden while it's open, as Obsidian hides its own cell's drawn text. The column keeps its width: it's fixed.
		this.shown?.addClass(HIDDEN_CLASS);
		this.holder = element.createDiv('table-cell-wrapper');
		const owner = note.state.field(editorInfoField, false);
		const hooks: CellHooks = { keys: this.keys(), plain: setup.plain(), onUpdate: (update) => this.onCellUpdate(update) };
		this.editor = makeCellEditor(setup.app, note, owner instanceof MarkdownView ? owner : null, this.holder, text, hooks, () => {
			new Notice('Selectable Tables: cells open in a simpler editor for now, after an Obsidian update. Markdown shows as text until you leave the cell.');
		});
		element.closest('.cm-table-widget')?.addClass('has-focus');
		const content = this.editor.view.contentDOM;
		content.addEventListener('focusin', () => (this.focused = true));
		// Focus that goes nowhere, as when the element leaves the page, still counts as the cell's. CodeMirror can move the
		// cell's block into a new box around a table's blocks as the note scrolls, without drawing it again, which takes the
		// keyboard from the editor: it takes it back, without scrolling, if nothing else has it.
		const boxOf = () => element.closest('.cm-table-widget')?.parentElement ?? null;
		let box = boxOf();
		content.addEventListener('focusin', () => (box = boxOf()));
		content.addEventListener('focusout', (event) => {
			if (event.relatedTarget) {
				this.focused = false;
				return;
			}
			queueMicrotask(() => {
				const page = content.ownerDocument;
				const active = page.activeElement;
				const moved = boxOf() !== box;
				if (!this.closed && moved && content.isConnected && (!active || active === page.body)) content.focus({ preventScroll: true });
			});
		});
		openCells.set(note, this);
		openCells.set(this.editor.view, this);
	}

	/**
	 * Opens a cell of a table, closing any other cell open in the note, with the caret `at`. The cell's row has to be
	 * drawn; one that isn't is brought into view first, and opens once it's drawn. The editor takes the focus right
	 * away, inside a tap's own handler, which is what has iOS show the keyboard.
	 */
	static open(setup: CellSetup, model: Model, cell: Cell, at: At, focus = true): OpenCell | null {
		const note = model.view;
		if (!note || cell.row > model.count || cell.column >= model.grid.columns(cell.row)) return null;
		const open = openCells.get(note);
		if (open instanceof OpenCell && open.model === model && open.cell.row === cell.row && open.cell.column === cell.column) {
			if (focus) open.editor.view.focus();
			return open;
		}
		open?.close();
		const element = model.cellElement(cell);
		if (!element?.isConnected) {
			model.whenDrawn(cell, () => OpenCell.open(setup, model, cell, at, focus));
			return null;
		}
		const opened = new OpenCell(setup, model, note, cell, element);
		model.holdOpen(element.parentElement as HTMLTableRowElement, cell.column);
		if (focus) opened.editor.view.focus();
		opened.place(at);
		model.showCell(cell);
		return opened;
	}

	get view(): EditorView {
		return this.editor.view;
	}

	table(): Span | null {
		return this.model.view === this.note ? { from: this.model.from, to: this.model.to } : null;
	}

	/**
	 * A change made in the note right inside the cell's text, as Obsidian's editor commands make one at the note's
	 * selection (Bold, Insert link, Insert horizontal rule), is taken as a change to the cell's text and written as the
	 * cell writes, as Obsidian's table takes it into its open cell: line breaks and pipes it put there become `<br>`
	 * and `\|`, and the column is padded again, rather than splitting the row. Null for any other transaction.
	 */
	reconcile(tr: Transaction): TransactionSpec | null {
		if (this.closed || !tr.docChanged || tr.annotation(writesCell) || tr.annotation(Transaction.remote)) return null;
		if (['undo', 'redo', 'set', 'input.type.compose'].some((event) => tr.isUserEvent(event))) return null;
		const doc = tr.startState.doc;
		const place = cellPlace(doc, this.model, this.cell);
		if (!place?.segment) return null;
		const from = place.line.from + place.segment.from;
		const to = place.line.from + place.segment.to;
		let inside = true;
		tr.changes.iterChangedRanges((changeFrom, changeTo) => {
			if (changeFrom < from || changeTo > to) inside = false;
		});
		if (!inside) return null;
		// The cell's text after the change, as the change left it in the note: padding off, and what it typed kept.
		const newFrom = tr.changes.mapPos(from, -1);
		const raw = tr.newDoc.sliceString(newFrom, tr.changes.mapPos(to, 1));
		const lead = raw.length - raw.replace(/^[ \t]+/, '').length;
		const text = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
		const shown = toCellEditor(text);
		const source = toCellSource(shown.text);
		const written = writeCell(doc, this.model, this.cell, source.text, this.padding);
		if (!written) return null;
		const map = (pos: number) => {
			const offset = clamp(pos - newFrom - lead, 0, text.length);
			return written.from + clamp(source.changes.mapPos(shown.changes.mapPos(offset, 1), 1), 0, source.text.length);
		};
		const { ranges, mainIndex } = tr.newSelection;
		const selection = EditorSelection.create(ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))), mainIndex);
		this.padding = written.padding;
		const event = tr.annotation(Transaction.userEvent);
		return { changes: written.changes, selection, scrollIntoView: tr.scrollIntoView, ...(event ? { userEvent: event } : {}) };
	}

	/** For the check script: the cell's text as the note has it, unescaped, and as its editor has it. */
	texts(): { note: string | null; cell: string; written: string; source: string | null } {
		const place = cellPlace(this.note.state.doc, this.model, this.cell);
		const cell = this.editor.view.state.doc.toString();
		return { note: place ? toCellEditor(place.source).text : null, cell, written: toCellSource(cell).text, source: place?.source ?? null };
	}

	holds(from: number, to: number): boolean {
		const place = this.closed ? null : this.where();
		return !!place && from >= place.from && to <= place.to;
	}

	/** Where the cell's text is in the note now, its padding around it included. */
	private where(): { from: number; to: number; text: number } | null {
		const place = cellPlace(this.note.state.doc, this.model, this.cell);
		if (!place) return null;
		if (!place.segment) return { from: place.from, to: place.from, text: place.from };
		return { from: place.line.from + place.segment.from, to: place.line.from + place.segment.to, text: place.from };
	}

	private place(at: At): void {
		const view = this.editor.view;
		const length = view.state.doc.length;
		let selection: EditorSelection;
		if (at === 'start') selection = EditorSelection.single(0);
		else if (at === 'all') selection = EditorSelection.single(0, length);
		else if (at === 'last-line') selection = EditorSelection.single(view.moveToLineBoundary(EditorSelection.cursor(length), false, true).from);
		else if (at === 'end') selection = EditorSelection.single(length);
		else if ('note' in at) selection = this.fromNote(at.note) ?? EditorSelection.single(length);
		else {
			// Where the click landed in the drawn text, counted in visible characters, and found again in the editor's drawn
			// text, where Live Preview hides the markup the same way. Else where the click is in the editor.
			const counted = at.visible === null ? null : placeAfter(view, at.visible);
			const pos = counted ?? view.posAtCoords({ x: at.x, y: at.y });
			selection = EditorSelection.single(pos ?? length);
		}
		view.dispatch({ selection, scrollIntoView: true });
	}

	/** Where a selection in the note's text falls in the cell's, or null when it isn't in the cell. */
	private fromNote({ anchor, head }: { anchor: number; head: number }): EditorSelection | null {
		const place = cellPlace(this.note.state.doc, this.model, this.cell);
		const where = this.where();
		// Undo can restore a range whose start is past its end, so its ends are put in order before they're used.
		if (!place || !where || Math.min(anchor, head) < where.from || Math.max(anchor, head) > where.to) return null;
		const shown = toCellEditor(place.source);
		const length = this.editor.view.state.doc.length;
		const map = (pos: number) => clamp(shown.changes.mapPos(clamp(pos - place.from, 0, place.source.length), 1), 0, length);
		return EditorSelection.single(map(anchor), map(head));
	}

	// The cell's keys ---------------------------------------------------------------------------------------------------

	/** As Obsidian's own cell has them, read from 1.15.1. Suggestions, while they show, take them first. */
	private keys(): KeyBinding[] {
		const live = (run: (view: EditorView) => boolean) => (view: EditorView) => !this.closed && !suggesting(this.setup.app) && run(view);
		const caret = (view: EditorView): SelectionRange | null => {
			const { ranges, main } = view.state.selection;
			return ranges.length === 1 && main.empty ? main : null;
		};
		// ← and → follow the text's direction: at the start of right-to-left text, → is the way back.
		const side = (view: EditorView, key: 'left' | 'right'): 'start' | 'end' => {
			const rtl = view.textDirectionAt(view.state.selection.main.head) === Direction.RTL;
			return (key === 'left') !== rtl ? 'start' : 'end';
		};
		const edge = (view: EditorView, toward: 'start' | 'end') => {
			const range = caret(view);
			if (!range || range.head !== (toward === 'start' ? 0 : view.state.doc.length)) return false;
			return this.step(toward === 'start' ? 'previous' : 'next', toward === 'start' ? 'end' : 'start', false);
		};
		// On the text's first or last line as drawn, as Obsidian's cell checks: ↑ or ↓ would stay on the same line.
		const line = (view: EditorView, down: boolean) => {
			const range = caret(view);
			if (!range) return false;
			const moved = view.moveVertically(range, down);
			const from = view.coordsAtPos(range.from);
			const to = view.coordsAtPos(moved.from);
			if (from && to && from.top !== to.top) return false;
			return this.step(down ? 'down' : 'up', down ? 'start' : 'last-line', false);
		};
		return [
			{ key: 'ArrowLeft', run: live((view) => edge(view, side(view, 'left'))) },
			{ key: 'ArrowRight', run: live((view) => edge(view, side(view, 'right'))) },
			{ key: 'Mod-ArrowLeft', run: live((view) => edge(view, side(view, 'left'))) },
			{ key: 'Mod-ArrowRight', run: live((view) => edge(view, side(view, 'right'))) },
			{ key: 'ArrowUp', run: live((view) => line(view, false)) },
			{ key: 'ArrowDown', run: live((view) => line(view, true)) },
			{ key: 'Tab', run: live(() => this.step('next', 'all', true)), shift: live(() => this.step('previous', 'all', true)) },
			{ key: 'Enter', run: live(() => this.step('down', 'all', true)) },
			{ key: 'Escape', run: live((view) => (this.setup.escape(view), true)) },
			{ key: 'Mod-z', run: () => undo(this.note), preventDefault: true },
			{ key: 'Mod-y', mac: 'Mod-Shift-z', run: () => redo(this.note), preventDefault: true },
			{ linux: 'Ctrl-Shift-z', run: () => redo(this.note), preventDefault: true },
			{ key: 'Mod-Shift-z', run: () => redo(this.note), preventDefault: true },
		];
	}

	/**
	 * To the next cell that way, or out of the table at its edge, to the start of the line beyond, as Obsidian's cell
	 * goes. Tab and Enter stay at the table's end, and add no row.
	 */
	private step(way: 'next' | 'previous' | 'up' | 'down', at: At, stay: boolean): boolean {
		let { row, column } = this.cell;
		const rows = this.model.count;
		const columns = this.model.grid.columns(row);
		if (way === 'next') {
			if (column + 1 < columns) column++;
			else if (row < rows) [row, column] = [row + 1, 0];
			else return stay || this.leave(true);
		} else if (way === 'previous') {
			if (column > 0) column--;
			else if (row > 0) [row, column] = [row - 1, columns - 1];
			else return stay || this.leave(false);
		} else if (way === 'up') {
			if (row > 0) row--;
			else return stay || this.leave(false);
		} else if (row < rows) row++;
		else return stay || this.leave(true);
		OpenCell.open(this.setup, this.model, { row, column }, at);
		return true;
	}

	/** Out of the table: the caret at the start of the line beyond it, and the note's keyboard. */
	private leave(after: boolean): boolean {
		const { note, model } = this;
		const { doc } = note.state;
		const number = after ? doc.lineAt(model.to).number + 1 : doc.lineAt(model.from).number - 1;
		if (number < 1 || number > doc.lines) return true;
		this.close();
		note.contentDOM.focus({ preventScroll: true });
		note.dispatch({ selection: EditorSelection.cursor(doc.line(number).from), scrollIntoView: true });
		return true;
	}

	// Writing to the note -----------------------------------------------------------------------------------------------

	private onCellUpdate(update: ViewUpdate): void {
		// The borrowed editor sets its text while it's made, before the cell has it.
		if (this.closed || this.syncing || !this.editor) return;
		for (const tr of update.transactions) {
			if (tr.annotation(fromNote) || tr.isUserEvent('set') || (!tr.docChanged && !tr.selection)) continue;
			this.write(tr);
			if (this.closed) return;
		}
		// Only a change of the cell's height moves rows: a wider line, or a caret move, doesn't.
		if (update.heightChanged) this.model.cellResized();
		if (update.docChanged || update.selectionSet) this.followCaret();
	}

	/**
	 * Writes one change of the cell's editor to the note: only the characters that changed, escaped as Obsidian's cell
	 * escapes them, padded as the table is, with the change's user event, and the note's selection put at the same place
	 * in the cell's text, without scrolling.
	 */
	private write(tr: Transaction): void {
		const spec = timed('cell', () => this.writing(tr));
		if (spec) this.note.dispatch(spec);
	}

	/** What a write sends the note, or null when the cell is gone and closes. */
	private writing(tr: Transaction): TransactionSpec | null {
		const { note, model, cell } = this;
		const { doc } = note.state;
		const source = toCellSource(tr.newDoc.toString());
		let changes: { from: number; to: number; insert: string }[] = [];
		let from: number;
		if (tr.docChanged) {
			const written = writeCell(doc, model, cell, source.text, this.padding);
			if (!written) {
				this.close();
				return null;
			}
			changes = written.changes;
			from = written.from;
			this.padding = written.padding;
		} else {
			const place = cellPlace(doc, model, cell);
			if (!place) return null;
			from = place.from;
		}
		const length = source.text.length;
		const map = (pos: number) => from + clamp(source.changes.mapPos(pos, 1), 0, length);
		const { ranges, mainIndex } = tr.newSelection;
		const selection = EditorSelection.create(
			ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))),
			mainIndex,
		);
		const annotations: Annotation<unknown>[] = [writesCell.of(true)];
		const event = tr.annotation(Transaction.userEvent);
		if (event && !event.startsWith('select')) annotations.push(Transaction.userEvent.of(event));
		return { changes, selection, annotations, scrollIntoView: false };
	}

	/** Puts the note's selection where the cell's caret is, after the note's update that moved it. */
	private mirrorSoon(): void {
		queueMicrotask(() => {
			if (this.closed || this.editor.view.composing) return;
			const { state } = this.editor.view;
			this.write(state.update({ selection: state.selection }));
		});
	}

	/** Keeps the caret in view sideways as it moves or the text grows: no box scrolls the table on a computer. */
	private followCaret(): void {
		const view = this.editor.view;
		view.requestMeasure({
			key: this,
			read: () => (this.closed ? null : view.coordsAtPos(view.state.selection.main.head)),
			write: (coords) => {
				if (coords) this.model.showSideways(coords.left - 4, coords.right + 4);
			},
		});
	}

	// Taking the note's changes ------------------------------------------------------------------------------------------

	/**
	 * The note changed: a change from anywhere but this cell comes into it, with the cell's caret where the note's
	 * selection is, as long as that's in the cell. A selection anywhere else closes it; in another cell of the table,
	 * the caret rule then selects that cell. A cell whose row went, in a rewrite of the table, opens again at the same
	 * row and column while those exist.
	 */
	noteUpdate(update: ViewUpdate, before: readonly Model[], after: readonly Model[]): void {
		timed('cell', () => this.taking(update, before, after));
	}

	private taking(update: ViewUpdate, before: readonly Model[], after: readonly Model[]): void {
		if (this.closed) return;
		const others = update.transactions.filter((tr) => !tr.annotation(writesCell));
		if (!others.length) return;
		if (!after.includes(this.model)) {
			// The table was found anew: by where it starts now, or else in the same place among the note's tables.
			const from = update.changes.mapPos(this.model.from, 1);
			const index = before.indexOf(this.model);
			const found = after.find((model) => model.from === from) ?? (before.length === after.length && index >= 0 ? after[index] : undefined);
			this.reopen(found ?? null);
			return;
		}
		if (!this.element.isConnected || !this.model.holdsOpen(this.element)) {
			this.reopen(this.model);
			return;
		}
		const row = this.model.rowOfOpen();
		if (row !== null) this.cell = { row, column: this.cell.column };
		if (this.editor.view.composing) {
			this.waitForComposition();
			return;
		}
		this.take(others.some((tr) => tr.docChanged), others.some((tr) => tr.selection));
	}

	/** Takes the note's text and selection into the cell, or closes it when the selection left it. */
	private take(text: boolean, selection: boolean): void {
		const { note, model } = this;
		const { doc } = note.state;
		const place = cellPlace(doc, model, this.cell);
		if (!place) {
			this.close(true);
			return;
		}
		const view = this.editor.view;
		if (text) this.padding = paddingFor(doc, model, this.cell);
		const shown = toCellEditor(place.source);
		const now = view.state.doc.toString();
		// Padding and trailing spaces typed are the same to the note, and so is a line break in code, which is written
		// `<br>` and reads back as `<br>`: only a change to the text the cell writes comes in.
		const same = shown.text === now || shown.text === now.trim() || toCellSource(now).text.trim() === place.source;
		const changes = text && !same ? { from: 0, to: now.length, insert: shown.text } : undefined;
		const { main } = note.state.selection;
		let next: EditorSelection | undefined;
		const inside = this.holds(Math.min(main.anchor, main.head), Math.max(main.anchor, main.head));
		if (inside) {
			// Mapped into the cell's text as it will be once the note's text is in.
			const length = changes ? shown.text.length : now.length;
			const map = (pos: number) => clamp(shown.changes.mapPos(clamp(pos - place.from, 0, place.source.length), 1), 0, length);
			next = EditorSelection.single(map(main.anchor), map(main.head));
			if (!changes && next.eq(view.state.selection)) next = undefined;
		} else if (selection) {
			this.close(true);
			return;
		} else if (changes) next = EditorSelection.single(Math.min(view.state.selection.main.head, shown.text.length));
		// A change that took the note's selection out of the cell without setting one, as a rewrite of the whole table
		// does, has the note's selection put back where the cell's caret is, so commands still act there.
		if (!inside && !selection) this.mirrorSoon();
		if (!changes && !next) return;
		this.syncing = true;
		try {
			view.dispatch({ changes, selection: next, annotations: fromNote.of(true), scrollIntoView: false });
		} finally {
			this.syncing = false;
		}
	}

	/** A composition runs in the cell: a change from elsewhere comes in once it ends, and never during it. */
	private waitForComposition(): void {
		if (this.waiting) return;
		this.waiting = true;
		const done = () => {
			this.editor.view.contentDOM.removeEventListener('compositionend', done);
			// CodeMirror ends its own composition after the event: the change comes in once it has.
			window.setTimeout(() => {
				this.waiting = false;
				if (!this.closed && !this.editor.view.composing) this.take(true, true);
			}, 0);
		};
		this.editor.view.contentDOM.addEventListener('compositionend', done);
	}

	/**
	 * The cell's row went from the page, as a rewrite of the whole table takes it: the cell opens again at the same
	 * row and column, with the caret where the note's selection is, if the table still has them.
	 */
	private reopen(model: Model | null): void {
		const focused = this.editor.view.hasFocus || this.focused;
		const { cell, setup, note } = this;
		this.close(focused);
		if (!model || model.view !== note) return;
		queueMicrotask(() => {
			if (openCells.get(note) || model.view !== note || cell.row > model.count || cell.column >= model.grid.columns(cell.row)) return;
			// The caret goes where the note's selection is, if that's in the cell.
			const { anchor, head } = note.state.selection.main;
			OpenCell.open(setup, model, cell, { note: { anchor, head } }, focused);
		});
	}

	// Closing -----------------------------------------------------------------------------------------------------------

	/**
	 * Closes the cell. Nothing typed is lost: every change is already in the note. With `keepKeys`, the note takes the
	 * keyboard if the cell had it, so keys keep working.
	 */
	close(keepKeys = false): void {
		if (this.closed) return;
		this.closed = true;
		const hadFocus = this.editor.view.hasFocus || this.focused;
		if (openCells.get(this.note) === this) openCells.delete(this.note);
		openCells.delete(this.editor.view);
		this.editor.destroy();
		this.holder.remove();
		this.shown?.removeClass(HIDDEN_CLASS);
		this.element.closest('.cm-table-widget')?.removeClass('has-focus');
		this.model.holdOpen(null, -1);
		// Not inside the note's update, which a change of focus would start again.
		if (keepKeys && hadFocus) {
			queueMicrotask(() => {
				const active = this.note.dom.ownerDocument.activeElement;
				if (this.note.dom.isConnected && !openCells.has(this.note) && (!active || active === this.note.dom.ownerDocument.body)) this.note.contentDOM.focus({ preventScroll: true });
			});
		}
	}
}
