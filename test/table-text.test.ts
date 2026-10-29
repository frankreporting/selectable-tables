import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { firstCellCaret, frontmatterEnd, looksLikeTable } from '../src/editor/table-text';

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
	const padded = doc('| Plant  | Room |', '| ------ | ---- |');
	assert.equal(firstCellCaret(padded, whole(padded)), '| Plant'.length);
	const bare = doc('Plant | Room', '--- | ---');
	assert.equal(firstCellCaret(bare, whole(bare)), 'Plant'.length);
	const escaped = doc('| a \\| b | c |', '| - | - |');
	assert.equal(firstCellCaret(escaped, whole(escaped)), '| a \\| b'.length);
	const empty = doc('|    | c |', '| - | - |');
	assert.equal(firstCellCaret(empty, whole(empty)), 1);
	const indented = doc('  | x | y |', '  | - | - |');
	assert.equal(firstCellCaret(indented, whole(indented)), '  | x'.length);
});

test('the frontmatter ends at its closing line', () => {
	assert.equal(frontmatterEnd(doc('---', 'status: draft', '---', '| a |')), '---\nstatus: draft\n---'.length);
	assert.equal(frontmatterEnd(doc('# Title', '---')), -1);
	assert.equal(frontmatterEnd(doc('---', 'never closed')), -1);
});
