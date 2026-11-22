import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { toCellEditor, toCellSource, writtenByObsidian } from '../src/editor/table-text';
import { cellPlace, paddingFor, writeCell } from '../src/own-table/cell-write';

const doc = (...lines: string[]) => Text.of(lines);
const whole = (text: Text) => ({ from: 0, to: text.length });

/** Types `text` into a cell, as an open cell writes each change, and gives back the note's lines and the write. */
function type(lines: string[], cell: { row: number; column: number }, text: string) {
	const before = doc(...lines);
	const padding = paddingFor(before, whole(before), cell);
	const written = writeCell(before, whole(before), cell, text, padding)!;
	const after = ChangeSet.of(written.changes, before.length).apply(before);
	return { lines: after.toJSON(), written, after };
}

test('a cell reads in its editor as Obsidian\'s cell shows it, and writes back escaped', () => {
	assert.equal(toCellEditor('a \\| b<br>c').text, 'a | b\nc');
	assert.equal(toCellSource('a | b\nc').text, 'a \\| b<br>c');
	// A pipe already escaped in the editor stays as it is, and `<br>` in code stays text.
	assert.equal(toCellSource('a \\| b').text, 'a \\| b');
	assert.equal(toCellEditor('`x<br>y`').text, '`x<br>y`');
	assert.equal(toCellEditor('a \\\\| b').text, 'a \\\\| b');
});

test('places in a cell map between its editor and the note', () => {
	const source = 'a \\| b<br>c';
	const shown = toCellEditor(source);
	// After the pipe, in the editor, is after the escaped pipe in the note.
	assert.equal(shown.changes.mapPos('a \\|'.length, 1), 'a |'.length);
	assert.equal(toCellSource(shown.text).changes.mapPos('a | b\n'.length, 1), 'a \\| b<br>'.length);
});

test('a cell\'s text is found between its pipes, padding left out', () => {
	const table = doc('| Plant | Room |', '| ----- | ---- |', '| Fern  |      |', '| Ivy |');
	const at = (row: number, column: number) => cellPlace(table, whole(table), { row, column });
	assert.deepEqual([at(1, 0)!.from, at(1, 0)!.source], [table.line(3).from + 2, 'Fern']);
	// An empty cell's text starts after one space, and a short row's missing cell is at the row's end.
	assert.deepEqual([at(1, 1)!.from, at(1, 1)!.source], [table.line(3).from + '| Fern  | '.length, '']);
	assert.deepEqual([at(2, 1)!.from, at(2, 1)!.segment], [table.line(4).to, null]);
	assert.equal(at(3, 0), null);
});

const obsidian = ['| Plant | Room |', '| ----- | ---- |', '| Fern  | Hall |'];

test('in a table Obsidian wrote, a cell that fits its column changes alone, its pipes kept', () => {
	assert.ok(writtenByObsidian(doc(...obsidian), whole(doc(...obsidian))));
	const { lines, written } = type(obsidian, { row: 1, column: 0 }, 'Ferns');
	assert.deepEqual(lines, ['| Plant | Room |', '| ----- | ---- |', '| Ferns | Hall |']);
	// Only the characters that changed: a write over the whole cell would have undo restore broken selections.
	assert.deepEqual(written.changes, [{ from: '| Plant | Room |\n| ----- | ---- |\n| Fern'.length, to: '| Plant | Room |\n| ----- | ---- |\n| Fern'.length + 1, insert: 's' }]);
});

test('a cell that outgrows its column pads the whole column again, as Obsidian does, and narrows it back', () => {
	const wide = type(obsidian, { row: 1, column: 0 }, 'Ferns and moss');
	assert.deepEqual(wide.lines, ['| Plant          | Room |', '| -------------- | ---- |', '| Ferns and moss | Hall |']);
	assert.ok(writtenByObsidian(wide.after, whole(wide.after)));
	assert.equal(wide.after.sliceString(wide.written.from, wide.written.from + 5), 'Ferns');
	// Back to fitting: the column narrows to its longest other cell.
	const narrow = writeCell(wide.after, whole(wide.after), { row: 1, column: 0 }, 'Fern', wide.written.padding)!;
	assert.deepEqual(ChangeSet.of(narrow.changes, wide.after.length).apply(wide.after).toJSON(), obsidian);
});

test('a header cell outgrowing its column, with the column aligned, keeps the alignment', () => {
	const lines = ['| Plant | Room |', '| ----: | :--: |', '|  Fern | Hall |'];
	assert.ok(writtenByObsidian(doc(...lines), whole(doc(...lines))));
	const { lines: after } = type(lines, { row: 0, column: 1 }, 'Rooms');
	assert.deepEqual(after, ['| Plant | Rooms |', '| ----: | :---: |', '|  Fern | Hall  |']);
});

test('a table Obsidian did not write keeps its own spacing: only the cell changes, its pipes kept while it fits', () => {
	assert.deepEqual(type(['|a|b|', '|-|-|', '|1|2|'], { row: 1, column: 0 }, '12').lines, ['|a|b|', '|-|-|', '|12|2|']);
	assert.deepEqual(type(['| a    | b |', '|-|-|'], { row: 0, column: 0 }, 'abc').lines, ['| abc  | b |', '|-|-|']);
	assert.deepEqual(type(['| a | b |', '|-|-|'], { row: 0, column: 0 }, 'abcdef').lines, ['| abcdef | b |', '|-|-|']);
});

test('typing in a cell a short row lacks adds the row\'s missing cells', () => {
	const { lines, written, after } = type(['| a | b | c |', '| - | - | - |', '| 1 |'], { row: 1, column: 2 }, 'x');
	assert.deepEqual(lines, ['| a | b | c |', '| - | - | - |', '| 1 |   | x |']);
	assert.equal(after.sliceString(written.from, written.from + 1), 'x');
});

test('a line break and a pipe typed in a cell are written escaped, as Obsidian\'s cell writes them', () => {
	const { lines } = type(['| a | b |', '| - | - |', '| 1 | 2 |'], { row: 1, column: 0 }, toCellSource('1 | 2\n3').text);
	assert.deepEqual(lines, ['| a | b |', '| - | - |', '| 1 \\| 2<br>3 | 2 |']);
});

test('a backslash typed at a cell\'s end keeps a space after it, so it can\'t escape the pipe and merge two cells', () => {
	assert.deepEqual(type(['|a|b|', '|-|-|'], { row: 0, column: 0 }, 'a\\').lines, ['|a\\ |b|', '|-|-|']);
	assert.deepEqual(type(['|  c|b|', '|--:|-|'], { row: 0, column: 0 }, 'cd\\').lines, ['| cd\\ |b|', '|--:|-|']);
	// An escaped backslash, two of them, escapes nothing.
	assert.deepEqual(type(['|a|b|', '|-|-|'], { row: 0, column: 0 }, 'a\\\\').lines, ['|a\\\\|b|', '|-|-|']);
});

test('padding a right-aligned column again puts the spaces before each cell\'s text, as the rule writes them', () => {
	const lines = ['| Plant | Room |', '| ----: | ---- |', '|  Fern | Hall |', '|  Moss | Shed |'];
	assert.ok(writtenByObsidian(doc(...lines), whole(doc(...lines))));
	const wide = type(lines, { row: 1, column: 0 }, 'Ferns and moss');
	assert.deepEqual(wide.lines, ['|          Plant | Room |', '| -------------: | ---- |', '| Ferns and moss | Hall |', '|           Moss | Shed |']);
	assert.ok(writtenByObsidian(wide.after, whole(wide.after)));
	const narrow = writeCell(wide.after, whole(wide.after), { row: 1, column: 0 }, 'Fern', wide.written.padding)!;
	assert.deepEqual(ChangeSet.of(narrow.changes, wide.after.length).apply(wide.after).toJSON(), lines);
});
