import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { blankLinesAbove, writesTable } from '../src/editor/decide';
import { editTable, lineChanges, readTable, shownText, type TableEdit } from '../src/own-table/table-edits';

const cell = (row: number, column: number) => ({ row, column });

/** A table Obsidian wrote. */
const plants = [
	'| Plant  | Room    | Count |',
	'| ------ | ------- | ----- |',
	'| Fern   | Kitchen | 10    |',
	'| Basil  | Balcony | 9     |',
	'| Cactus | Office  | 100   |',
];

/** An edit's lines and the cell it goes to. */
function edit(lines: string[], what: TableEdit, at: { row: number; column: number }, options = {}) {
	const edited = editTable(lines, what, at, options);
	assert.ok(edited, `${what} applies`);
	return { lines: edited.lines, cell: edited.cell };
}

test('reading a table as Obsidian does: cells trimmed, short rows filled, and columns as wide as their longest text', () => {
	const grid = readTable(['| A | B |', '|:-|-:|', '| long text |', '| x | y | z |']);
	assert.deepEqual(grid.rows, [
		['A', 'B', ''],
		['long text', '', ''],
		['x', 'y', 'z'],
	]);
	assert.deepEqual(grid.alignments, ['left', 'right', null]);
	assert.deepEqual(grid.widths, [11, 5, 5]);
});

test('a row of only dashes is dropped, as Obsidian\'s parser drops it', () => {
	assert.deepEqual(readTable(['| A | B |', '| - | - |', '| --- | - |', '| x | y |']).rows, [
		['A', 'B'],
		['x', 'y'],
	]);
});

test('a row of only dashes, which the plugin draws and Obsidian drops, doesn\'t shift the rows an edit acts on', () => {
	const dashed = ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |', '| ----- | ---- |', '| Mint  | Den  |', '| Sage  | Loft |'];
	assert.deepEqual(edit(dashed, 'row-delete', cell(3, 0)).lines, ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |', '| Sage  | Loft |']);
	assert.deepEqual(edit(dashed, 'row-up', cell(3, 1)).lines?.slice(2), ['| Mint  | Den  |', '| Fern  | Hall |', '| Sage  | Loft |']);
	assert.deepEqual(edit(dashed, 'row-delete', cell(2, 0)), { lines: ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |', '| Mint  | Den  |', '| Sage  | Loft |'], cell: cell(1, 0) });
});

test('Add row above and below put an empty row there and go to its cell in the same column', () => {
	assert.deepEqual(edit(plants, 'row-before', cell(2, 1)), {
		lines: ['| Plant  | Room    | Count |', '| ------ | ------- | ----- |', '| Fern   | Kitchen | 10    |', '|        |         |       |', '| Basil  | Balcony | 9     |', '| Cactus | Office  | 100   |'],
		cell: cell(2, 1),
	});
	assert.deepEqual(edit(plants, 'row-after', cell(3, 2)).lines?.slice(-2), ['| Cactus | Office  | 100   |', '|        |         |       |']);
	assert.deepEqual(edit(plants, 'row-after', cell(3, 2)).cell, cell(4, 2));
});

test('Add row above on the header puts a new empty header above it', () => {
	const { lines, cell: to } = edit(plants, 'row-before', cell(0, 0));
	assert.deepEqual(lines?.slice(0, 3), ['|        |         |       |', '| ------ | ------- | ----- |', '| Plant  | Room    | Count |']);
	assert.deepEqual(to, cell(0, 0));
});

test('Move row up and down move the row and go with it, and do nothing past the table\'s ends', () => {
	const down = edit(plants, 'row-down', cell(1, 0));
	assert.deepEqual(down.lines?.slice(2), ['| Basil  | Balcony | 9     |', '| Fern   | Kitchen | 10    |', '| Cactus | Office  | 100   |']);
	assert.deepEqual(down.cell, cell(2, 0));
	assert.deepEqual(edit(plants, 'row-up', cell(1, 2)).lines?.slice(0, 3), ['| Fern   | Kitchen | 10    |', '| ------ | ------- | ----- |', '| Plant  | Room    | Count |']);
	assert.equal(editTable(plants, 'row-up', cell(0, 0)), null);
	assert.equal(editTable(plants, 'row-down', cell(3, 0)), null);
});

test('Duplicate row puts the copy above and goes to the row below it', () => {
	const { lines, cell: to } = edit(plants, 'row-copy', cell(2, 1));
	assert.deepEqual(lines?.slice(3, 5), ['| Basil  | Balcony | 9     |', '| Basil  | Balcony | 9     |']);
	assert.deepEqual(to, cell(3, 1));
});

test('Delete row goes to the row above, keeps the columns\' widths as Obsidian does, and takes a last row\'s table away', () => {
	const { lines, cell: to } = edit(plants, 'row-delete', cell(3, 0));
	assert.deepEqual(lines, ['| Plant  | Room    | Count |', '| ------ | ------- | ----- |', '| Fern   | Kitchen | 10    |', '| Basil  | Balcony | 9     |']);
	assert.deepEqual(to, cell(2, 0));
	assert.deepEqual(edit(plants, 'row-delete', cell(0, 1)).cell, cell(0, 1));
	assert.deepEqual(edit(['| A |', '| --- |'], 'row-delete', cell(0, 0)), { lines: null, cell: cell(0, 0) });
});

test('Add column to the left and right take the column\'s alignment, at the narrowest width, and go to its cell', () => {
	const aligned = ['|  A  |   B |', '| :-: | --: |', '|  x  |   y |'];
	assert.deepEqual(edit(aligned, 'col-before', cell(1, 1)), {
		lines: ['|  A  |     |   B |', '| :-: | --: | --: |', '|  x  |     |   y |'],
		cell: cell(1, 1),
	});
	assert.deepEqual(edit(aligned, 'col-after', cell(0, 0)), {
		lines: ['|  A  |     |   B |', '| :-: | :-: | --: |', '|  x  |     |   y |'],
		cell: cell(0, 1),
	});
});

test('Move column, Duplicate column and Delete column', () => {
	assert.deepEqual(edit(plants, 'col-right', cell(2, 0)).lines?.[0], '| Room    | Plant  | Count |');
	assert.deepEqual(edit(plants, 'col-right', cell(2, 0)).cell, cell(2, 1));
	assert.deepEqual(edit(plants, 'col-left', cell(2, 2)).lines?.[2], '| Fern   | 10    | Kitchen |');
	assert.equal(editTable(plants, 'col-left', cell(2, 0)), null);
	assert.equal(editTable(plants, 'col-right', cell(2, 2)), null);
	const copied = edit(plants, 'col-copy', cell(1, 1));
	assert.deepEqual(copied.lines?.[2], '| Fern   | Kitchen | Kitchen | 10    |');
	assert.deepEqual(copied.cell, cell(1, 2));
	const deleted = edit(plants, 'col-delete', cell(1, 1));
	assert.deepEqual(deleted.lines?.[0], '| Plant  | Count |');
	assert.deepEqual(deleted.cell, cell(1, 0));
	assert.deepEqual(edit(['| A |', '| --- |', '| x |'], 'col-delete', cell(1, 0)).lines, null);
});

test('Align left, center and right write the delimiter and pad the column, the other way in a right-to-left table', () => {
	const centered = edit(plants, 'col-align-center', cell(1, 2)).lines!;
	assert.deepEqual(centered.slice(0, 3), ['| Plant  | Room    | Count |', '| ------ | ------- | :---: |', '| Fern   | Kitchen |  10   |']);
	assert.equal(edit(plants, 'col-align-right', cell(1, 2)).lines![4], '| Cactus | Office  |   100 |');
	assert.equal(edit(plants, 'col-align-left', cell(1, 0)).lines![1], '| :----- | ------- | ----- |');
	assert.equal(edit(plants, 'col-align-left', cell(1, 0), { rtl: true }).lines![1], '| -----: | ------- | ----- |');
});

test('Sort orders the rows by their shown text, numbers in number order and case aside, the header kept on top', () => {
	assert.deepEqual(edit(plants, 'sort-az', cell(0, 2)).lines?.slice(2), ['| Basil  | Balcony | 9     |', '| Fern   | Kitchen | 10    |', '| Cactus | Office  | 100   |']);
	assert.deepEqual(edit(plants, 'sort-za', cell(1, 2)).lines?.slice(2), ['| Cactus | Office  | 100   |', '| Fern   | Kitchen | 10    |', '| Basil  | Balcony | 9     |']);
	const names = ['| Seed |', '| --- |', '| **pear** |', '| Apricot |', '| apple |'];
	assert.deepEqual(edit(names, 'sort-az', cell(0, 0), { shown: shownText }).lines?.slice(2), ['| apple    |', '| Apricot  |', '| **pear** |']);
});

test('a sort keeps rows that show the same text in their order, either way', () => {
	const same = ['| A | B |', '| --- | --- |', '| x | 1 |', '| X | 2 |', '| w | 3 |'];
	assert.deepEqual(edit(same, 'sort-za', cell(0, 0)).lines?.slice(2).map((line) => line.split('|')[2]!.trim()), ['1', '2', '3']);
});

test('a table spaced by hand comes out tidied on its first edit', () => {
	const hand = ['|Name|Bed|', '|-|:-:|', '|  Mint   |  North |'];
	assert.deepEqual(edit(hand, 'row-after', cell(1, 0)).lines, ['| Name |  Bed  |', '| ---- | :---: |', '| Mint | North |', '|      |       |']);
});

const frozen = ['| %%freeze 1 1%% Name | Bed   |', '| ------------------- | ----- |', '| Mint                | North |', '| Sage                | South |'];

test('the freeze mark stays in the header when the header row moves down, or goes', () => {
	const down = edit(frozen, 'row-down', cell(0, 1)).lines!;
	assert.equal(down[0], '| %%freeze 1 1%% Mint | North |');
	assert.equal(down[2], '| Name                | Bed   |');
	assert.equal(edit(frozen, 'row-delete', cell(0, 0)).lines![0], '| %%freeze 1 1%% Mint | North |');
	const above = edit(frozen, 'row-before', cell(0, 0)).lines!;
	assert.equal(above[0], '| %%freeze 1 1%%      |       |');
	assert.equal(above[2], '| Name                | Bed   |');
	assert.equal(edit(frozen, 'row-up', cell(1, 0)).lines![0], '| %%freeze 1 1%% Mint | North |');
});

test('the freeze mark moves to the first header cell when its column goes, and a copy of its cell or row doesn\'t copy it', () => {
	assert.deepEqual(edit(frozen, 'col-delete', cell(1, 0)).lines!.slice(0, 3), ['| %%freeze 1 1%% Bed |', '| ------------------ |', '| North              |']);
	assert.equal(edit(frozen, 'col-copy', cell(0, 0)).lines![0], '| Name                | %%freeze 1 1%% Name | Bed   |');
	const row = edit(frozen, 'row-copy', cell(0, 1)).lines!;
	assert.equal(row[0], '| %%freeze 1 1%% Name | Bed   |');
	assert.equal(row[2], '| Name                | Bed   |');
	assert.equal(edit(frozen, 'col-right', cell(0, 0)).lines![0], '| Bed   | %%freeze 1 1%% Name |');
});

test('a table of one column and one with a short row', () => {
	assert.deepEqual(edit(['| A |', '| - |', '| x |'], 'row-after', cell(1, 0)).lines, ['| A   |', '| --- |', '| x   |', '|     |']);
	assert.deepEqual(edit(['| A | B |', '| - | - |', '| x |'], 'col-after', cell(1, 1)).lines, ['| A   | B   |     |', '| --- | --- | --- |', '| x   |     |     |']);
});

/** Applies an edit's line changes to a note holding the table, as CodeMirror does, and checks the note it leaves. */
function applied(lines: string[], what: TableEdit, at: { row: number; column: number }, aligned = true) {
	const doc = Text.of(['Above', '', ...lines, '', 'Below']);
	const table = { from: doc.line(3).from, to: doc.line(2 + lines.length).to };
	const edited = editTable(lines, what, at);
	assert.ok(edited?.lines, `${what} applies`);
	const { changes, to } = lineChanges(doc, table, edited.lines, aligned ? edited.from : undefined);
	const next = ChangeSet.of(changes, doc.length).apply(doc);
	assert.equal(next.sliceString(table.from, to), edited.lines.join('\n'));
	assert.equal(next.toString(), ['Above', '', ...edited.lines, '', 'Below'].join('\n'));
	return { changes, doc };
}

test('only the lines that differ change, and the table\'s end follows', () => {
	assert.equal(applied(plants, 'row-down', cell(1, 0)).changes.length, 2);
	const { changes, doc } = applied(plants, 'row-before', cell(2, 0));
	assert.deepEqual(changes, [{ from: doc.line(5).to + 1, to: doc.line(5).to + 1, insert: '|        |         |       |\n' }]);
	const edits: [TableEdit, number, number][] = [
		['row-after', 3, 0], ['row-after', 1, 0], ['row-delete', 3, 0], ['row-delete', 1, 0], ['row-delete', 0, 0], ['row-before', 0, 0],
		['row-copy', 0, 0], ['row-copy', 3, 1], ['col-delete', 0, 0], ['row-up', 1, 0],
	];
	for (const [what, row, column] of edits) {
		applied(plants, what, cell(row, column));
		applied(plants, what, cell(row, column), false);
	}
});

test('a row added or taken out in a table every line of which is rewritten changes each line in place', () => {
	// Spaced by hand: the edit tidies every line, and takes one out.
	const hand = ['|Plant|Room|', '|-|-|', '|Fern|Hall|', '|Mint|Den|', '|Sage|Loft|'];
	const { changes, doc } = applied(hand, 'row-delete', cell(2, 0));
	// No change runs from one line into another but the one taking out Mint's line.
	const across = changes.filter((change) => doc.lineAt(change.from).number !== doc.lineAt(change.to).number);
	assert.deepEqual(across.map((change) => doc.sliceString(change.from, change.to)), ['|Mint|Den|\n']);
	assert.equal(changes.length, 5);
	applied(hand, 'row-after', cell(3, 1));
	applied(hand, 'row-delete', cell(3, 1));
	applied(hand, 'row-delete', cell(0, 1));
	const dashed = ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |', '| Mint  | Den  |', '| ----- | ---- |'];
	applied(dashed, 'row-delete', cell(1, 0));
	applied(dashed, 'row-after', cell(2, 0));
});

test('a cell\'s shown text, as Obsidian draws it', () => {
	assert.equal(shownText('**bold** and *it*'), 'bold and it');
	assert.equal(shownText('[[Watering schedule]]'), 'Watering schedule');
	assert.equal(shownText('[[Watering schedule|water]]'), 'water');
	assert.equal(shownText('[[Note#Part]]'), 'Note > Part');
	assert.equal(shownText('[site](https://example.com) `a*b*`'), 'site a*b*');
	assert.equal(shownText('==high== ~~gone~~ #tag'), 'high gone #tag');
	assert.equal(shownText('a<br>b \\| c %%hidden%%'), 'a\nb | c');
	assert.equal(shownText('snake_case_name'), 'snake_case_name');
	assert.equal(shownText('<span>x</span> &amp; y'), 'x & y');
	assert.equal(shownText('&#1114112; &#65;'), '&#1114112; A');
});

test('Add row above on the header stays one table: the blank line above it is left as it is', () => {
	const doc = Text.of(['Above', '', ...plants, '', 'Below']);
	const table = { from: doc.line(3).from, to: doc.line(7).to };
	const edited = editTable(plants, 'row-before', cell(0, 0))!;
	const { changes } = lineChanges(doc, table, edited.lines!, edited.from);
	const state = EditorState.create({ doc: doc.toString() });
	// Its new header goes in at the table's start, where text typed on the line above would have to move off.
	assert.notDeepEqual(blankLinesAbove(state.update({ changes }), [table]), []);
	assert.deepEqual(blankLinesAbove(state.update({ changes, annotations: writesTable.of('rows') }), [table]), []);
});
