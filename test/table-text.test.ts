import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { cellCaret, cellSource, frontmatterEnd, looksLikeTable, needsRepair } from '../src/editor/table-text';

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

test('a table as Obsidian pads it needs no repair', () => {
	const padded = doc('| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |');
	assert.equal(needsRepair(padded, whole(padded)), false);
	const narrow = doc('| a   | b   |', '| --- | --- |', '| c   | d   |');
	assert.equal(needsRepair(narrow, whole(narrow)), false);
	const aligned = doc('| Plant | Count |', '| :---- | ----: |', '| Fern  |    10 |');
	assert.equal(needsRepair(aligned, whole(aligned)), false);
	const escaped = doc('| a \\| b |', '| ------ |', '| c      |');
	assert.equal(needsRepair(escaped, whole(escaped)), false);
});

test('a short row needs repair: its filler cells have no text to edit', () => {
	const short = doc('| Shelf | Pots | Soil |', '| ----- | ---- | ---- |', '| Mid   | 5    |');
	assert.ok(needsRepair(short, whole(short)));
});

test('a long row needs repair', () => {
	const long = doc('| a   | b   |', '| --- | --- |', '| c   | d   | e   |');
	assert.ok(needsRepair(long, whole(long)));
});

test('a column wider than its text needs repair: Obsidian trims a cell on leaving it without writing that', () => {
	const stale = doc('| Fruit      | Qty |', '| ---------- | --- |', '| Apple red  | 10  |', '| Pear       | 20  |');
	assert.ok(needsRepair(stale, whole(stale)));
});

test('padding that differs between rows needs repair', () => {
	const unpadded = doc('| a | bbbb |', '|---|---|', '| cc | d |');
	assert.ok(needsRepair(unpadded, whole(unpadded)));
});

test('a table with no outer pipes needs repair', () => {
	const bare = doc('Plant | Room', '--- | ---', 'Fern | Hall');
	assert.ok(needsRepair(bare, whole(bare)));
});

test('the delimiter line does not count towards a column', () => {
	const wide = doc('| a   |', '| ------- |', '| b   |');
	assert.equal(needsRepair(wide, whole(wide)), false);
});

test('the frontmatter ends at its closing line', () => {
	assert.equal(frontmatterEnd(doc('---', 'status: draft', '---', '| a |')), '---\nstatus: draft\n---'.length);
	assert.equal(frontmatterEnd(doc('# Title', '---')), -1);
	assert.equal(frontmatterEnd(doc('---', 'never closed')), -1);
});
