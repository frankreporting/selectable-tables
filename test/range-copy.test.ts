import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyRange } from '../src/own-table/range';

const cell = (row: number, column: number) => ({ row, column });

/** A table Obsidian wrote, with a link holding an escaped pipe, inline code and bold. Invented. */
const trays = [
	'| Tray | Seed                        | Notes         |',
	'| ---- | --------------------------- | ------------- |',
	'| A1   | [[Watering schedule\\|Fern]] | **Keep damp** |',
	'| A2   | `Basil`                     |               |',
	'| B1   | Tomato                      | a \\| b        |',
];

test('a range copies as a Markdown table, its first row the header, each cell at its whole column\'s width', () => {
	const { markdown, rows, alignment } = copyRange(trays, cell(1, 0), cell(2, 1));
	assert.equal(markdown, ['| A1   | [[Watering schedule\\|Fern]] |', '| ---- | --------------------------- |', '| A2   | `Basil`                     |'].join('\n'));
	assert.deepEqual(rows, [['A1', '[[Watering schedule\\|Fern]]'], ['A2', '`Basil`']]);
	assert.deepEqual(alignment, [null, null]);
});

test('either corner can be the one moved to last', () => {
	assert.deepEqual(copyRange(trays, cell(2, 1), cell(1, 0)), copyRange(trays, cell(1, 0), cell(2, 1)));
	assert.deepEqual(copyRange(trays, cell(1, 1), cell(2, 0)), copyRange(trays, cell(1, 0), cell(2, 1)));
});

test('a range of one row still gets its alignment row', () => {
	assert.equal(copyRange(trays, cell(3, 1), cell(3, 2)).markdown, ['| Tomato                      | a \\| b        |', '| --------------------------- | ------------- |'].join('\n'));
});

test('each column is padded by its alignment, as Obsidian writes it', () => {
	const aligned = ['| L | C | R |', '|:--|:-:|--:|', '| a | bb | ccc |', '| dddd | e | f |'];
	const { markdown, alignment } = copyRange(aligned, cell(0, 0), cell(2, 2));
	assert.deepEqual(alignment, ['left', 'center', 'right']);
	assert.equal(markdown, ['| L    |  C  |   R |', '| :--- | :-: | --: |', '| a    | bb  | ccc |', '| dddd |  e  |   f |'].join('\n'));
});

test('the freeze mark stays out, and its column is as wide as it would be without it', () => {
	const frozen = ['| %%freeze 1 1%% Name | Bed  |', '| ------------------- | ---- |', '| Fern                | East |'];
	const { markdown, rows } = copyRange(frozen, cell(0, 0), cell(1, 1));
	assert.deepEqual(rows, [['Name', 'Bed'], ['Fern', 'East']]);
	assert.equal(markdown, ['| Name | Bed  |', '| ---- | ---- |', '| Fern | East |'].join('\n'));
});

test('a row of only dashes, which Obsidian drops, isn\'t copied', () => {
	const dashes = ['| A | B |', '| - | - |', '| x | y |', '| --- | --- |', '| z | w |'];
	assert.deepEqual(copyRange(dashes, cell(1, 0), cell(3, 1)).rows, [['x', 'y'], ['z', 'w']]);
});
