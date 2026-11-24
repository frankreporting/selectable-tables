import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Text } from '@codemirror/state';
import { writtenByObsidian } from '../src/editor/table-text';
import { writeCells } from '../src/own-table/cell-write';
import { cellsIn, documentOf, targetsIn, withMark } from '../src/own-table/format-cells';

const cell = (row: number, column: number) => ({ row, column });

/** A table Obsidian wrote. */
const seeds = [
	'| Seed    | Sown  | Notes       |',
	'| ------- | ----- | ----------- |',
	'| Apricot | March | *Soak*      |',
	'| **Pear** |       | warm        |',
	'| apple   | May   | ==keep==    |',
];

const obsidianTable = [
	'| Seed    | Sown  | Notes    |',
	'| ------- | ----- | -------- |',
	'| Apricot | March | *Soak*   |',
	'| Pear    |       | warm     |',
	'| apple   | May   | ==keep== |',
];

test('a range\'s cells are listed row by row from its top left, as Obsidian lists its own range', () => {
	assert.deepEqual(cellsIn({ top: 1, bottom: 2, left: 0, right: 1 }), [cell(1, 0), cell(1, 1), cell(2, 0), cell(2, 1)]);
});

test('formatting skips empty cells and rows of only dashes, and acts on a header cell\'s text after its freeze mark', () => {
	const lines = ['| %%freeze 1 1%% Name | Bed |', '| --- | --- |', '| Fern |  |', '| --- | --- |', '| Ivy | Shade |'];
	const targets = targetsIn(lines, cellsIn({ top: 0, bottom: 4, left: 0, right: 1 }));
	assert.deepEqual(
		targets.map(({ cell, text, mark }) => [cell.row, cell.column, text, mark]),
		[
			[0, 0, 'Name', '%%freeze 1 1%%'],
			[0, 1, 'Bed', null],
			[1, 0, 'Fern', null],
			[3, 0, 'Ivy', null],
			[3, 1, 'Shade', null],
		],
	);
	assert.equal(withMark(targets[0]!, '**Name**'), '%%freeze 1 1%% **Name**');
	assert.equal(withMark(targets[0]!, ''), '%%freeze 1 1%%');
	assert.equal(withMark(targets[1]!, '*Bed*'), '*Bed*');
});

test('a header cell holding only a freeze mark has nothing to format', () => {
	assert.deepEqual(targetsIn(['| %%freeze 1 0%% | B |', '| - | - |'], [cell(0, 0)]), []);
});

test('the cells are read from the table cut down to their rows and columns, the header and delimiter kept', () => {
	const lines = ['| %%freeze 1 1%% Name | Bed | Notes |', '| --- | :-: | --- |', '| Fern | # shade | - none |', '| Ivy | a \\| b | <br>x |', '| Moss | dry | wet |'];
	const targets = targetsIn(lines, cellsIn({ top: 0, bottom: 2, left: 0, right: 1 }));
	const stand = documentOf(lines, targets);
	// After a blank line, so it reads as a table; the mark is left out of the header, and the third column cut away.
	assert.equal(stand.doc, '\n| Name | Bed |\n| --- | :-: |\n| Fern | # shade |\n| Ivy | a \\| b |');
	assert.deepEqual(
		stand.ranges.map(({ from, to }) => stand.doc.slice(from, to)),
		['Name', 'Bed', 'Fern', '# shade', 'Ivy', 'a \\| b'],
	);
	assert.deepEqual(stand.textsAfter('\n| **Name** | Bed |\n| --- | :-: |\n| Fern | **# shade** |\n| *Ivy* | a \\| b |'), ['**Name**', 'Bed', 'Fern', '**# shade**', '*Ivy*', 'a \\| b']);
	// A row whose cells no longer read the same, or a line more or less, can't be read back.
	assert.equal(stand.textsAfter('\n| Name | Bed |\n| --- | :-: |\n| Fern | # | shade |\n| Ivy | a \\| b |'), null);
	assert.equal(stand.textsAfter('\n| Name | Bed |\n| --- | :-: |\n| Fern | # shade |'), null);
});

test('a range below the header still takes the header and delimiter, and only its own rows', () => {
	const lines = ['| A | B |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'];
	const stand = documentOf(lines, targetsIn(lines, cellsIn({ top: 2, bottom: 3, left: 1, right: 1 })));
	assert.equal(stand.doc, '\n| B |\n| - |\n| 4 |\n| 6 |');
	assert.deepEqual(stand.textsAfter('\n| B |\n| - |\n| **4** |\n| 6 |'), ['**4**', '6']);
});

test('in a table Obsidian wrote, a column holding new text is as wide as its longest text and two spaces, its delimiter too', () => {
	assert.ok(writtenByObsidian(Text.of(obsidianTable), { from: 0, to: Text.of(obsidianTable).length }));
	const lines = writeCells(obsidianTable, [{ cell: cell(1, 0), text: '**Apricot**' }], true);
	assert.deepEqual(lines, [
		'| Seed        | Sown  | Notes    |',
		'| ----------- | ----- | -------- |',
		'| **Apricot** | March | *Soak*   |',
		'| Pear        |       | warm     |',
		'| apple       | May   | ==keep== |',
	]);
	assert.ok(writtenByObsidian(Text.of(lines), { from: 0, to: Text.of(lines).length }));
	// Taking it off again narrows the column back.
	assert.deepEqual(writeCells(lines, [{ cell: cell(1, 0), text: 'Apricot' }], true), obsidianTable);
});

test('a new text that fits its column changes only its own cell', () => {
	assert.deepEqual(writeCells(obsidianTable, [{ cell: cell(2, 0), text: '*Pear*' }], true), [
		obsidianTable[0],
		obsidianTable[1],
		obsidianTable[2],
		'| *Pear*  |       | warm     |',
		obsidianTable[4],
	]);
});

test('several columns of a range are padded again at once, as one cell at a time would leave them', () => {
	const texts = [
		{ cell: cell(1, 0), text: '**Apricot**' },
		{ cell: cell(1, 2), text: '***Soak***' },
		{ cell: cell(3, 0), text: '**apple**' },
		{ cell: cell(3, 2), text: '**==keep==**' },
	];
	const lines = writeCells(obsidianTable, texts, true);
	assert.deepEqual(lines, [
		'| Seed        | Sown  | Notes        |',
		'| ----------- | ----- | ------------ |',
		'| **Apricot** | March | ***Soak***   |',
		'| Pear        |       | warm         |',
		'| **apple**   | May   | **==keep==** |',
	]);
	assert.ok(writtenByObsidian(Text.of(lines), { from: 0, to: Text.of(lines).length }));
});

test('an aligned column keeps its alignment as it\'s padded again', () => {
	const table = ['| Name  | Count |', '| :---: | ----: |', '| Fern  |    10 |'];
	assert.deepEqual(writeCells(table, [{ cell: cell(1, 1), text: '**10**' }], true), ['| Name  |  Count |', '| :---: | -----: |', '| Fern  | **10** |']);
});

test('a table spaced by hand keeps its spacing, and only the cells change', () => {
	assert.ok(!writtenByObsidian(Text.of(seeds), { from: 0, to: Text.of(seeds).length }));
	assert.deepEqual(writeCells(seeds, [{ cell: cell(2, 0), text: 'Pear' }, { cell: cell(1, 0), text: '**Apricot**' }], false), [
		seeds[0],
		seeds[1],
		'| **Apricot** | March | *Soak*      |',
		'| Pear     |       | warm        |',
		seeds[4],
	]);
	// Aligned right, the pipes stay at the cell's end.
	assert.deepEqual(writeCells(['| A | N |', '|---|--:|', '|  x |    12 |'], [{ cell: cell(1, 1), text: '*12*' }], false), ['| A | N |', '|---|--:|', '|  x |  *12* |']);
});

test('a freeze mark in a header cell is written back before its new text', () => {
	const lines = ['| %%freeze 1 0%% Name | Bed   |', '| ------------------- | ----- |', '| Fern                | Shade |'];
	const [target] = targetsIn(lines, [cell(0, 0)]);
	assert.deepEqual(writeCells(lines, [{ cell: cell(0, 0), text: withMark(target!, '**Name**') }], true), [
		'| %%freeze 1 0%% **Name** | Bed   |',
		'| ----------------------- | ----- |',
		'| Fern                    | Shade |',
	]);
});
