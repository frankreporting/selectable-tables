import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, Text } from '@codemirror/state';
import { arrow, backspace, blankLinesAbove, caretInTable, Cells, deleteForward, Direction, enter, noCells } from '../src/editor/decide';
import { spanAt } from '../src/editor/layout';
import { cellAt } from '../src/editor/table-text';
import { count, matchSpans } from '../src/own-table/matches';
import { layoutOf, note } from './notes';

// The rules that are new on the plugin's own table, drawn here as a block per row.
const TABLE = '| Plant  | Room |\n| ------ | ---- |\n| Fern   | Hall |\n| Ivy    | Desk |';
const own = { own: true };

function spanOf(marked: string) {
	const text = marked.replace(/[‸⟨⟩]/g, '');
	const from = text.indexOf(TABLE);
	return { from, to: from + TABLE.length };
}

function press(marked: string, direction: Direction, { stops = true, leaves = true, goal }: { stops?: boolean; leaves?: boolean; goal?: number } = {}) {
	let state = note(marked);
	if (goal !== undefined) {
		const { anchor, head } = state.selection.main;
		state = state.update({ selection: EditorSelection.create([EditorSelection.range(anchor, head, goal)]) }).state;
	}
	return arrow({ state, layout: layoutOf(state, own), leavesLine: () => leaves, cells: noCells, stops }, direction, false);
}

describe('↑ and ↓ on the plugin\'s table', () => {
	test('a tap of ↓ on the line above stops on the table and selects it', () => {
		const text = `Intro\n‸\n${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'down'), { type: 'stop', table: spanOf(text), fromAbove: true });
	});

	test('a tap of ↑ on the line below selects it from below', () => {
		const text = `Intro\n\n${TABLE}\n‸\nAfter`;
		assert.deepEqual(press(text, 'up'), { type: 'stop', table: spanOf(text), fromAbove: false });
	});

	test('a held key, or Vim, passes the table as before', () => {
		const text = `Intro\n‸\n${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'down', { stops: false }), { type: 'pass', table: spanOf(text), forward: true });
	});

	test('a wrapped line keeps its rows first', () => {
		assert.equal(press(`A long line‸ that wraps\n${TABLE}\n\nAfter`, 'down', { leaves: false }), null);
	});

	test('↓ on a table it stopped on goes on to the line beyond, at the place across it had', () => {
		const text = `Intro\n\n⟨${TABLE}⟩\n\nAfter`;
		assert.deepEqual(press(text, 'down', { goal: 40 }), { type: 'pass', table: spanOf(text), forward: true });
		assert.deepEqual(press(text, 'up', { goal: 40 }), { type: 'pass', table: spanOf(text), forward: false });
	});

	test('↓ on a table selected another way goes to the line beyond\'s start, as before', () => {
		const text = `Intro\n\n⟨${TABLE}⟩\n\nAfter`;
		assert.deepEqual(press(text, 'down'), { type: 'caret', pos: spanOf(text).to + 1 });
	});

	test('→ and ← at its edge still select it', () => {
		const text = `Intro\n‸\n${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'right'), { type: 'select', table: spanOf(text), fromAbove: true });
	});
});

describe('Enter, Delete and Backspace beside the plugin\'s table', () => {
	const cells = (selected: Cells['selected']): Cells => ({ selected, left: null, grid: { rows: 3, columns: () => 2 } });

	test('Enter on a selected table selects its first cell, and on a selected cell does nothing yet', () => {
		const state = note(`Intro\n\n⟨${TABLE}⟩\n\nAfter`);
		assert.deepEqual(enter({ state, layout: layoutOf(state, own), cells: noCells }), { type: 'cell', cell: { row: 0, column: 0 } });
		assert.deepEqual(enter({ state, layout: layoutOf(state, own), cells: cells({ row: 1, column: 1 }) }), { type: 'stay' });
	});

	test('Delete at the end of the line above does nothing', () => {
		const state = note(`Intro\n‸\n${TABLE}\n\nAfter`);
		assert.deepEqual(deleteForward(state, layoutOf(state, own)), { type: 'stay' });
	});

	test('Backspace at the start of the line below selects the table from below', () => {
		const text = `Intro\n\n${TABLE}\n‸\nAfter`;
		const state = note(text);
		assert.deepEqual(backspace(state, layoutOf(state, own)), { type: 'select', table: spanOf(text), fromAbove: false });
	});

	test('Backspace on the blank line above, under text, moves the caret up and deletes nothing', () => {
		const state = note(`Intro\n‸\n${TABLE}\n\nAfter`);
		assert.deepEqual(backspace(state, layoutOf(state, own)), { type: 'caret', pos: 'Intro'.length });
	});

	test('Backspace elsewhere is Obsidian\'s: on a second blank line, inside a line, or beside Obsidian\'s table', () => {
		for (const text of [`Intro\n\n‸\n${TABLE}`, `Intro\n\n${TABLE}\n\nAf‸ter`, `Intro\n\n${TABLE}\nA‸`]) {
			const state = note(text);
			assert.equal(backspace(state, layoutOf(state, own)), null, text);
		}
		const state = note(`Intro\n\n${TABLE}\n‸\nAfter`);
		assert.equal(backspace(state, layoutOf(state)), null);
	});
});

describe('a selection put inside the plugin\'s table', () => {
	const text = `Intro\n\n${TABLE}\n\nAfter`;
	const at = (from: number, to = from) => {
		const state = EditorState.create({ doc: text, selection: EditorSelection.single(from, to) });
		return caretInTable(state, layoutOf(state, own));
	};
	const table = spanOf(text);
	const ivy = text.indexOf('Ivy');

	test('a caret in a cell selects the table and that cell', () => {
		assert.deepEqual(at(ivy + 1), { table, cell: { row: 2, column: 0 } });
		assert.deepEqual(at(text.indexOf('Desk')), { table, cell: { row: 2, column: 1 } });
	});

	test('a match from Find selects the cell it starts in', () => {
		assert.deepEqual(at(ivy, ivy + 3), { table, cell: { row: 2, column: 0 } });
	});

	test('a caret on the delimiter line selects a header cell', () => {
		assert.deepEqual(at(text.indexOf('| ---- |') + 3), { table, cell: { row: 0, column: 1 } });
	});

	test('the table selected whole, a caret on its edge, or a selection reaching past it, are left alone', () => {
		assert.equal(at(table.from, table.to), null);
		assert.equal(at(table.from), null);
		assert.equal(at(table.to), null);
		assert.equal(at(ivy, table.to + 2), null);
		assert.equal(at(1), null);
	});

	test('on Obsidian\'s table nothing changes: a caret there opens a cell', () => {
		const state = EditorState.create({ doc: text, selection: EditorSelection.single(ivy) });
		assert.equal(caretInTable(state, layoutOf(state)), null);
	});
});

describe('the blank line above the plugin\'s table', () => {
	const text = `Intro\n\n${TABLE}\n\nAfter`;
	const table = spanOf(text);
	const state = EditorState.create({ doc: text });
	const breaks = (changes: { from: number; to?: number; insert?: string }) => {
		const tr = state.update({ changes });
		return { breaks: blankLinesAbove(tr, [table]), doc: tr.newDoc };
	};

	test('typing on it puts a line break back at the table\'s start', () => {
		const { breaks: at, doc } = breaks({ from: table.from - 1, insert: 'w' });
		assert.deepEqual(at, [table.from + 1]);
		assert.equal(doc.sliceString(at[0]!, at[0]! + 7), '| Plant');
	});

	test('joining it to the line above, as Delete at that line\'s end does, puts it back too', () => {
		assert.deepEqual(breaks({ from: 'Intro'.length, to: 'Intro'.length + 1 }).breaks, [table.from - 1]);
	});

	test('an edit elsewhere, or one that leaves a blank line, changes nothing', () => {
		assert.deepEqual(breaks({ from: 0, insert: 'More ' }).breaks, []);
		assert.deepEqual(breaks({ from: table.from - 1, insert: '\n' }).breaks, []);
		assert.deepEqual(breaks({ from: table.to + 2, insert: 'x' }).breaks, []);
	});

	test('a table deleted whole is left alone', () => {
		assert.deepEqual(breaks({ from: table.from - 1, to: table.to }).breaks, []);
	});
});

describe('finding the plugin\'s tables and cells', () => {
	const spans = [
		{ from: 10, to: 20 },
		{ from: 30, to: 40 },
		{ from: 41, to: 50 },
	];

	test('a place finds the table holding it, its edges included', () => {
		assert.deepEqual(spanAt(spans, 10), spans[0]);
		assert.deepEqual(spanAt(spans, 20), spans[0]);
		assert.deepEqual(spanAt(spans, 35), spans[1]);
		assert.deepEqual(spanAt(spans, 41), spans[2]);
		assert.equal(spanAt(spans, 25), null);
		assert.equal(spanAt(spans, 5), null);
		assert.equal(spanAt(spans, 60), null);
		assert.equal(spanAt([], 0), null);
	});

	test('a place in a row finds its cell, an escaped pipe not counting', () => {
		const doc = Text.of(['| A | B |', '| - | - |', '| x \\| y | z |']);
		const table = { from: 0, to: doc.length };
		const row = doc.line(3);
		assert.deepEqual(cellAt(doc, table, row.from + 2), { row: 1, column: 0 });
		assert.deepEqual(cellAt(doc, table, row.from + 6), { row: 1, column: 0 });
		assert.deepEqual(cellAt(doc, table, row.from + 11), { row: 1, column: 1 });
		assert.deepEqual(cellAt(doc, table, 0), { row: 0, column: 0 });
	});

	test('matches are kept by row, the header being -1, in their lines, and none on the delimiter', () => {
		const doc = Text.of(['Intro', '', '| Frost | B |', '| - | - |', '| Frost | z |']);
		const table = { from: doc.line(3).from, to: doc.length };
		const rows = matchSpans([
			{ from: doc.line(3).from + 2, to: doc.line(3).from + 7, flash: false },
			{ from: doc.line(4).from, to: doc.line(4).from + 1, flash: false },
			{ from: doc.line(5).from + 2, to: doc.line(5).from + 7, flash: true },
			{ from: 0, to: 3, flash: false },
		], doc, table);
		assert.deepEqual([...rows], [[-1, [{ start: 2, end: 7, flash: false }]], [0, [{ start: 2, end: 7, flash: true }]]]);
	});
});

describe('counting a match\'s words in a cell', () => {
	test('counts them without overlap, up to an end', () => {
		assert.equal(count('Frost then frost and Frost', 'Frost'), 2);
		assert.equal(count('Frost then Frost', 'Frost', 5), 1);
		assert.equal(count('aaaa', 'aa'), 2);
	});

	test('an empty match counts nothing, and stops', () => {
		assert.equal(count('Frost', ''), 0);
	});
});
