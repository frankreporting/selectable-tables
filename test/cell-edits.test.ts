import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Text } from '@codemirror/state';
import { boundsOf } from '../src/editor/decide';
import type { Alignment } from '../src/editor/table-text';
import { editCells, lineChanges, readTableData } from '../src/own-table/table-edits';

const cell = (row: number, column: number) => ({ row, column });

/** A table Obsidian wrote, as the test vault's Seed trays has it. Invented. */
const trays = [
	'| Tray | Seed                        | Notes         |',
	'| ---- | --------------------------- | ------------- |',
	'| A1   | [[Watering schedule\\|Fern]] | **Keep damp** |',
	'| A2   | `Basil`                     |               |',
	'| B1   | Tomato                      | a \\| b        |',
	'| B2   | #seed/late                  | Water twice   |',
];

/** Backspace (or Delete, `forward`) on a range from `anchor` to `head`, the cell moved to last. */
function remove(lines: string[], anchor: { row: number; column: number }, head: { row: number; column: number }, forward = false) {
	const edited = editCells(lines, { kind: 'delete', bounds: boundsOf(anchor, head), head, forward });
	assert.ok(edited, 'the delete applies');
	return { lines: edited.lines, cell: edited.cell };
}

function paste(lines: string[], at: { row: number; column: number }, rows: string[][], alignment: Alignment[] = rows[0]!.map(() => null)) {
	const edited = editCells(lines, { kind: 'paste', at, rows, alignment });
	assert.ok(edited, 'the paste applies');
	return { lines: edited.lines, cell: edited.cell, from: edited.from };
}

test('Backspace on a range empties its cells, the columns narrowed to their longest text, and goes to its first cell', () => {
	assert.deepEqual(remove(trays, cell(1, 1), cell(2, 2)), {
		lines: [
			'| Tray | Seed       | Notes       |',
			'| ---- | ---------- | ----------- |',
			'| A1   |            |             |',
			'| A2   |            |             |',
			'| B1   | Tomato     | a \\| b      |',
			'| B2   | #seed/late | Water twice |',
		],
		cell: cell(1, 1),
	});
});

test('Delete on a range does the same and goes to its last cell, whichever corner it started from', () => {
	assert.deepEqual(remove(trays, cell(2, 2), cell(1, 1), true).cell, cell(2, 2));
	assert.deepEqual(remove(trays, cell(1, 1), cell(2, 2), true).lines, remove(trays, cell(1, 1), cell(2, 2)).lines);
});

test('a range across every column deletes its rows: Backspace goes to the row above, Delete to the row below, in the column moved to last', () => {
	const back = remove(trays, cell(2, 0), cell(2, 2));
	assert.deepEqual(back.lines, [trays[0], trays[1], trays[2], trays[4], trays[5]]);
	assert.deepEqual(back.cell, cell(1, 2));
	assert.deepEqual(remove(trays, cell(2, 2), cell(3, 0), true).cell, cell(2, 0));
});

test('deleting the header rows makes the next row the header, and deleting the last rows goes to the row above them', () => {
	const header = remove(trays, cell(0, 0), cell(1, 2), true);
	assert.deepEqual(header.lines, [trays[3], trays[1], trays[4], trays[5]]);
	assert.deepEqual(header.cell, cell(0, 2));
	const end = remove(trays, cell(3, 0), cell(4, 2));
	assert.deepEqual(end.lines, trays.slice(0, 4));
	assert.deepEqual(end.cell, cell(2, 2));
});

test('a range across every row deletes its columns: Backspace goes to the column before, Delete to the column after, in the row moved to last', () => {
	const back = remove(trays, cell(0, 1), cell(4, 1), true);
	assert.deepEqual(back.lines, ['| Tray | Notes         |', '| ---- | ------------- |', '| A1   | **Keep damp** |', '| A2   |               |', '| B1   | a \\| b        |', '| B2   | Water twice   |']);
	assert.deepEqual(back.cell, cell(4, 1));
	assert.deepEqual(remove(trays, cell(4, 1), cell(0, 1)).cell, cell(0, 0));
	// From the first column, Backspace stays in the first.
	assert.deepEqual(remove(trays, cell(0, 0), cell(4, 0)).cell, cell(4, 0));
});

test('a range across every row and every column takes the whole table away', () => {
	assert.equal(remove(trays, cell(0, 0), cell(4, 2)).lines, null);
});

test('pasting cells writes over the cells from the one pasted at, growing the table a column and a row, and goes to the last cell pasted', () => {
	const walks = ['| Day | Walk       | Steps |', '| --- | ---------- | ----- |', '| Mon | Park loop  | 6200  |', '| Tue | River path | 7400  |'];
	const pasted = paste(walks, cell(2, 2), [
		['Fern', 'Kitchen'],
		['Basil', 'Balcony'],
	]);
	assert.deepEqual(pasted.lines, [
		'| Day | Walk       | Steps |         |',
		'| --- | ---------- | ----- | ------- |',
		'| Mon | Park loop  | 6200  |         |',
		'| Tue | River path | Fern  | Kitchen |',
		'|     |            | Basil | Balcony |',
	]);
	assert.deepEqual(pasted.cell, cell(3, 3));
	// Every line but the new row's is the one it was, so each is written in place.
	assert.deepEqual(pasted.from, [0, 1, 2, 3, -1]);
});

test('pasted onto the header, cells bring their columns\' alignments; onto another row, only new columns take one, from the first, as Obsidian has it', () => {
	const table = ['| A   | B   |', '| --- | --- |', '| 1   | 2   |'];
	assert.deepEqual(paste(table, cell(0, 1), [['x', 'y']], ['center', 'right']).lines, ['| A   |  x  |   y |', '| --- | :-: | --: |', '| 1   |  2  |     |']);
	assert.deepEqual(paste(table, cell(1, 1), [['x', 'y']], ['center', 'right']).lines, ['| A   | B   |     |', '| --- | --- | :-: |', '| 1   | x   |  y  |']);
});

test('the freeze mark stays in its header cell, before what\'s pasted or with nothing after it once cleared', () => {
	const plants = ['| %%freeze 2 1%% Name | Bed   |', '| ------------------- | ----- |', '| Plant 1             | **A** |', '| Plant 2             | **B** |'];
	assert.deepEqual(
		paste(plants, cell(0, 0), [
			['Plant 1', '**A**'],
			['Plant 2', '**B**'],
		]).lines,
		['| %%freeze 2 1%% Plant 1 | **A** |', '| ---------------------- | ----- |', '| Plant 2                | **B** |', '| Plant 2                | **B** |'],
	);
	assert.deepEqual(remove(plants, cell(0, 0), cell(0, 0)).lines?.slice(0, 3), ['| %%freeze 2 1%% | Bed   |', '| -------------- | ----- |', '| Plant 1        | **A** |']);
	// Deleting the header row puts the mark in the new header's first cell, as Delete row does.
	assert.equal(remove(plants, cell(0, 0), cell(0, 1)).lines?.[0], '| %%freeze 2 1%% Plant 1 | **A** |');
	// A mark pasted from another table's header is left out: the table keeps its own.
	assert.equal(paste(plants, cell(0, 1), [['%%freeze 1 0%% Bed']]).lines?.[0], '| %%freeze 2 1%% Name | Bed   |');
});

test('pasted text that holds a raw pipe or line break stays inside its cell', () => {
	const table = ['| A   | B   |', '| --- | --- |', '| 1   | 2   |'];
	assert.equal(paste(table, cell(1, 0), [['x | y\nz']]).lines?.[2], '| x \\| y<br>z | 2   |');
});

test('a table spaced by hand comes out tidied, as Obsidian writes it', () => {
	const hand = ['|A|B|', '|-|-|', '|one|two|', '|three|four|'];
	assert.deepEqual(remove(hand, cell(1, 0), cell(1, 0)).lines, ['| A     | B    |', '| ----- | ---- |', '|       | two  |', '| three | four |']);
});

test('a range\'s rows deleted from a long table are taken out line by line, so the rows that stay keep their places', () => {
	const lines = ['| N   |', '| --- |', ...Array.from({ length: 6 }, (_, i) => `| ${i}   |`)];
	const doc = Text.of(lines);
	const edited = editCells(lines, { kind: 'delete', bounds: boundsOf(cell(2, 0), cell(4, 0)), head: cell(4, 0), forward: false })!;
	const { changes } = lineChanges(doc, { from: 0, to: doc.length }, edited.lines!, edited.from);
	assert.equal(changes.length, 3);
	assert.ok(changes.every((change) => change.insert === ''));
});

test('Obsidian\'s table data is read only in its shape', () => {
	assert.deepEqual(readTableData('{"rows":[["a","b"]],"alignment":[null,"left"]}'), { rows: [['a', 'b']], alignment: [null, 'left'] });
	for (const bad of ['', 'not json', '{}', '{"rows":[],"alignment":[null]}', '{"rows":[["a"]],"alignment":[]}', '{"rows":[[1]],"alignment":[null]}', '{"rows":[["a"]],"alignment":["middle"]}', '[]']) {
		assert.equal(readTableData(bad), null, bad);
	}
});
