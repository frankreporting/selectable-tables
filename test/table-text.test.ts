import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { cellCaret, cellSource, frontmatterEnd, looksLikeTable, writtenByObsidian } from '../src/editor/table-text';

const doc = (...lines: string[]) => Text.of(lines);
const whole = (text: Text) => ({ from: 0, to: text.length });

test('a table has a pipe in its first row and a delimiter row after it', () => {
	assert.ok(looksLikeTable(doc('| Plant | Room |', '| ----- | :--: |', '| Fern | Kitchen |'), whole(doc('| Plant | Room |', '| ----- | :--: |', '| Fern | Kitchen |'))));
	const bare = doc('Plant | Room', '--- | ---', 'Fern | Kitchen');
	assert.ok(looksLikeTable(bare, whole(bare)));
});

test('callouts, rows without a delimiter row, and single lines are not tables', () => {
	const callout = doc('> [!note] Title', '> | a | b |', '> | - | - |');
	assert.ok(!looksLikeTable(callout, whole(callout)));
	const noDelimiter = doc('| a | b |', '| c | d |');
	assert.ok(!looksLikeTable(noDelimiter, whole(noDelimiter)));
	const single = doc('| a | b |');
	assert.ok(!looksLikeTable(single, whole(single)));
});

test('Enter lands at the end of the first cell text', () => {
	const caret = (text: Text) => cellCaret(text, whole(text), { row: 0, column: 0 });
	const padded = doc('| Plant  | Room |', '| ------ | ---- |');
	assert.equal(caret(padded), '| Plant'.length);
	const bare = doc('Plant | Room', '--- | ---');
	assert.equal(caret(bare), 'Plant'.length);
	const escaped = doc('| a \\| b | c |', '| - | - |');
	assert.equal(caret(escaped), '| a \\| b'.length);
	const empty = doc('|    | c |', '| - | - |');
	assert.equal(caret(empty), 1);
	const indented = doc('  | x | y |', '  | - | - |');
	assert.equal(caret(indented), '  | x'.length);
});

const lines = ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |', '| a \\| b |  |', '| Ivy |', '| 1 | 2 | 3 | 4 |'];
const table = doc(...lines);
/** The position of `column` characters into a line of `table`. */
const at = (line: number, column: number) => table.line(line + 1).from + column;

test('a row below the header skips the delimiter line', () => {
	assert.equal(cellCaret(table, whole(table), { row: 1, column: 0 }), at(2, '| Fern'.length));
	assert.equal(cellCaret(table, whole(table), { row: 1, column: 1 }), at(2, '| Fern  | Hall'.length));
});

test('an escaped pipe stays inside its cell', () => {
	assert.equal(cellCaret(table, whole(table), { row: 2, column: 0 }), at(3, '| a \\| b'.length));
});

test('an empty cell takes the caret right after its pipe', () => {
	assert.equal(cellCaret(table, whole(table), { row: 2, column: 1 }), at(3, '| a \\| b |'.length));
});

test('a cell past the end of a short row lands in the last cell the row has', () => {
	assert.equal(cellCaret(table, whole(table), { row: 3, column: 1 }), at(4, '| Ivy'.length));
});

test('a cell beyond the header is found in a long row', () => {
	assert.equal(cellCaret(table, whole(table), { row: 4, column: 3 }), at(5, '| 1 | 2 | 3 | 4'.length));
});

test('a row with no outer pipes has its cells at the line\'s ends', () => {
	const bare = doc('Plant | Room', '--- | ---', 'Fern | Hall');
	assert.equal(cellCaret(bare, whole(bare), { row: 1, column: 0 }), bare.line(3).from + 'Fern'.length);
	assert.equal(cellCaret(bare, whole(bare), { row: 1, column: 1 }), bare.line(3).to);
});

test('a row past the table\'s end lands on its last line', () => {
	assert.equal(cellCaret(table, whole(table), { row: 9, column: 0 }), at(5, '| 1'.length));
});

test('a line holding only a pipe gives a caret on that line', () => {
	const stub = doc('| a | b |', '| - | - |', '|');
	assert.equal(cellCaret(stub, whole(stub), { row: 1, column: 0 }), stub.length);
});

test('a cell\'s source is its text without padding', () => {
	assert.equal(cellSource(table, whole(table), { row: 1, column: 1 }), 'Hall');
	assert.equal(cellSource(table, whole(table), { row: 2, column: 1 }), '');
});

test('a cell past the end of a short row has no source', () => {
	assert.equal(cellSource(table, whole(table), { row: 3, column: 1 }), '');
});

test('a cell\'s source shows pipes and line breaks as its editor does', () => {
	const row = (...cells: string[]) => `| ${cells.join(' | ')} |`;
	const cells = doc(
		'| a |',
		'| - |',
		row('[[Watering schedule\\|Fern]]'),
		row('one<br>two<BR>three'),
		row('`a<br>b`'),
		row('a\\\\|b'.replace('|', '\\|')),
	);
	const source = (r: number) => cellSource(cells, whole(cells), { row: r, column: 0 });
	assert.equal(source(1), '[[Watering schedule|Fern]]');
	assert.equal(source(2), 'one\ntwo\nthree');
	assert.equal(source(3), '`a<br>b`');
	assert.equal(source(4), 'a\\\\|b');
});

const written = (...lines: string[]) => writtenByObsidian(doc(...lines), whole(doc(...lines)));

test('a table as Obsidian writes it counts as written by Obsidian', () => {
	assert.ok(written('| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |'));
	assert.ok(written('| a   | b   |', '| --- | --- |', '| c   | d   |'));
	assert.ok(written('| a \\| b |', '| ------ |', '| c      |'));
	assert.ok(written('| a   |     |', '| --- | --- |', '|     | d   |'));
});

test('aligned columns count when padded the way Obsidian pads them', () => {
	assert.ok(written('| Plant | Count |', '| :---- | ----: |', '| Fern  |    10 |'));
	assert.ok(written('| Plant |', '| :---: |', '|  ab   |'));
});

test('a short row or a long one does not count', () => {
	assert.ok(!written('| Shelf | Pots | Soil |', '| ----- | ---- | ---- |', '| Mid   | 5    |'));
	assert.ok(!written('| a   | b   |', '| --- | --- |', '| c   | d   | e   |'));
});

test('a column wider than its text does not count: closing a cell trims it without writing that', () => {
	assert.ok(!written('| Fruit      | Qty |', '| ---------- | --- |', '| Apple red  | 10  |', '| Pear       | 20  |'));
});

test('hand-typed padding does not count', () => {
	assert.ok(!written('| a | bbbb |', '|---|---|', '| cc | d |'));
	assert.ok(!written('|Fruit|Qty|', '|---|---|', '|Apple|10|'));
	assert.ok(!written('|   a |', '| --- |', '| b   |'));
});

test('a table with no outer pipes does not count', () => {
	assert.ok(!written('Plant | Room', '--- | ---', 'Fern | Hall'));
});

test('anything outside the outer pipes does not count', () => {
	assert.ok(!written('| a   |  ', '| --- |', '| b   |'));
	assert.ok(!written(' | a   |', ' | --- |', ' | b   |'));
});

test('the delimiter\'s dash count does not matter: Obsidian ignores it, so a click wouldn\'t change it', () => {
	assert.ok(written('| Name | Value |', '| --- | --- |', '| a    | b     |'));
	assert.ok(written('| Name | Value |', '|---|---|', '| a    | b     |'));
	assert.ok(written('| a   |', '| ------- |', '| b   |'));
});

test('a delimiter with other columns than the rows does not count', () => {
	assert.ok(!written('| a   | b   |', '| --- |', '| c   | d   |'));
	assert.ok(!written('| a   |', '| --- | --- |', '| b   |'));
});

test('alignment still decides where the padding goes, whatever the dash count', () => {
	assert.ok(written('| Plant | Count |', '| :-- | --: |', '| Fern  |    10 |'));
	assert.ok(!written('| Plant | Count |', '| :-- | --: |', '| Fern  | 10    |'));
});

test('a row of only dashes does not count: Obsidian\'s parser drops it', () => {
	assert.ok(!written('| a   | b   |', '| --- | --- |', '| --- | --- |', '| c   | d   |'));
	assert.ok(!written('| --- | --- |', '| --- | --- |', '| c   | d   |'));
});

test('a line with only its leading pipe does not count: Obsidian\'s parser stops there', () => {
	assert.ok(!written('| a   |', '| --- |', '| Pears and more', '| b   |'));
	assert.ok(!written('| a   |', '| --- |', '|'));
});

test('padding that is not plain spaces does not count', () => {
	assert.ok(!written('| a\u00a0  |', '| --- |', '| b   |'));
	assert.ok(!written('| a\u3000  |', '| --- |', '| b   |'));
	assert.ok(!written('|\ta   |', '| --- |', '| b   |'));
});

test('the frontmatter ends at its closing line', () => {
	assert.equal(frontmatterEnd(doc('---', 'status: draft', '---', '| a |')), '---\nstatus: draft\n---'.length);
	assert.equal(frontmatterEnd(doc('# Title', '---')), -1);
	assert.equal(frontmatterEnd(doc('---', 'never closed')), -1);
});
