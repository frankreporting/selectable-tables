import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { endAfter, endOfNextLine, findTables, lineChange, opensTable, type Rows, textEnd, updateTables } from '../src/own-table/find';
import { linesOf, rowSplices } from '../src/own-table/shape';
import { parsed } from './own-table-parser';

const doc = (...lines: string[]) => Text.of(lines);
const spans = (doc: Text, rows: Rows = parsed(doc)) => findTables(doc, rows).map(({ from, to }) => doc.sliceString(from, to));

test('finds each table the parser marks, from its header to the end its text gives', () => {
	const note = doc('Intro', '', '| a | b |', '| - | - |', '| 1 | 2 |', 'After the table', '', '| c |', '| - |', '| 3 |');
	assert.deepEqual(spans(note), ['| a | b |\n| - | - |\n| 1 | 2 |', '| c |\n| - |\n| 3 |']);
});

test('two tables with a blank line between stay two tables', () => {
	const note = doc('', '| a |', '| - |', '| 1 |', '', '| b |', '| - |', '| 2 |');
	assert.equal(findTables(note, parsed(note)).length, 2);
});

test("a table's end comes from the text past where the parser stopped", () => {
	const note = doc('', '| a |', '| - |', '| 1 |', '| 2 |', '| 3 |', 'Text');
	// The parser has read only the header and the delimiter.
	const rows = parsed(note, note.line(3).to);
	assert.deepEqual(spans(note, rows), ['| a |\n| - |\n| 1 |\n| 2 |\n| 3 |']);
});

test('a table without pipes at its ends goes on while lines hold a pipe after their first character', () => {
	const note = doc('', 'a | b', '- | -', '1 | 2', 'no pipe', '3 | 4');
	assert.equal(note.sliceString(note.line(2).from, textEnd(note, note.line(2).from)), 'a | b\n- | -\n1 | 2');
});

test('a piped table ends at the first line not starting with a pipe', () => {
	const note = doc('| a |', '| - |', '| 1 |', ' | 2 |', '| 3 |');
	assert.equal(textEnd(note, 0), note.line(3).to);
});

test("a marked line that isn't followed by a delimiter doesn't start a table", () => {
	const note = doc('', '| a |', 'text');
	const rows: Rows = { length: note.length, next: (from, to) => (from <= note.line(2).from && note.line(2).from < to ? note.line(2).from : -1), gap: () => 0 };
	assert.deepEqual(findTables(note, rows), []);
});

test('a table opens after the note start, a blank line, a heading or the frontmatter, and not after text', () => {
	const at = (note: Text, n: number) => opensTable(note, note.line(n).from);
	assert.equal(at(doc('| a |', '| - |'), 1), true);
	assert.equal(at(doc('', '| a |', '| - |'), 2), true);
	assert.equal(at(doc('## Heading', '| a |', '| - |'), 2), true);
	assert.equal(at(doc('---', 'tags: x', '---', '| a |', '| - |'), 4), true);
	assert.equal(at(doc('Text', '| a |', '| - |'), 2), false);
	assert.equal(at(doc('', '| a |', 'text'), 2), false);
});

/** Applies changes to a note, and gives the tables after them both ways: updated, and found from scratch. */
function bothWays(before: Text, changes: ChangeSet, read?: number) {
	const after = changes.apply(before);
	const old = findTables(before, parsed(before));
	const updated = updateTables(old, changes, before.length, before, after, parsed(after, read ?? after.length));
	return { after, old, updated, scratch: findTables(after, parsed(after)) };
}

const at = (spans: { from: number; to: number }[]) => spans.map(({ from, to }) => [from, to]);

test('typing on a line above a table keeps the table, moved along', () => {
	const before = doc('Text', '', '| a | b |', '| - | - |', '| 1 | 2 |', '', 'End');
	const { updated, scratch } = bothWays(before, ChangeSet.of({ from: 2, insert: 'xyz' }, before.length));
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated[0]!.was, 0);
});

test('typing in a row keeps the table and its end', () => {
	const before = doc('', '| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '', 'End');
	const { updated, scratch } = bothWays(before, ChangeSet.of({ from: before.line(4).from + 2, insert: '99' }, before.length));
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated[0]!.was, 0);
});

test('a new row typed on the line after a table joins it', () => {
	const before = doc('', '| a |', '| - |', '| 1 |', 'Text');
	const { updated, scratch } = bothWays(before, ChangeSet.of({ from: before.line(5).from, insert: '| 2 |\n' }, before.length));
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated.length, 1);
});

test('taking out the blank line between two tables joins them', () => {
	const before = doc('', '| a |', '| - |', '| 1 |', '', '| 2 |', '| - |', '| 3 |');
	const { updated, scratch } = bothWays(before, ChangeSet.of({ from: before.line(5).from, to: before.line(6).from }, before.length));
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated.length, 1);
});

test('taking out the blank line above a table ends it', () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |');
	const { updated, scratch } = bothWays(before, ChangeSet.of({ from: before.line(2).from, to: before.line(3).from }, before.length));
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated.length, 0);
});

test('a table past what the parser has read stays where it was', () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |', '', 'More');
	const changes = ChangeSet.of({ from: 0, insert: 'New ' }, before.length);
	// The parser has read only the first line since the change.
	const { updated } = bothWays(before, changes, 5);
	assert.equal(updated.length, 1);
	assert.equal(updated[0]!.was, 0);
	assert.equal(updated[0]!.from, changes.mapPos(before.line(3).from));
});

test('a table in a stretch the parser skipped is kept while its text still opens a table', () => {
	const filler = 'Text that runs on without any Markdown in it at all, for a long way down the note.';
	const skippedIn = (note: Text): Rows => ({ length: note.length, next: () => -1, gap: () => note.length });
	const before = doc('Text', '', '| a |', '| - |', '| 1 |', '', ...Array.from({ length: 1400 }, () => filler));
	const old = findTables(before, parsed(before));
	assert.deepEqual(at(updateTables(old, null, 0, before, before, skippedIn(before))), at(old));
	// A stretch shorter than the parser's jump can't have been skipped: the table is gone.
	const short = doc('Text', '', '| a |', '| - |', '| 1 |');
	assert.deepEqual(updateTables(findTables(short, parsed(short)), null, 0, short, short, skippedIn(short)), []);
	// A table whose text no longer opens a table is gone, skipped or not.
	const broken = before.replace(before.line(4).from, before.line(4).to, Text.of(['| x |']));
	assert.deepEqual(updateTables(old, null, 0, broken, broken, skippedIn(broken)), []);
});

test('a table whose header the parser skipped, starting again on one of its rows, is kept', () => {
	const row = (n: number) => `| Row ${n} | some text in a cell, to make the row a little longer than a short one |`;
	const before = doc('Text', '', '| Name | Notes |', '| - | - |', ...Array.from({ length: 2000 }, (_, n) => row(n + 1)), '', 'End');
	const old = findTables(before, parsed(before));
	// The parser jumped from the note's start to row 1,500, and read the rows from there as text: they have nodes, but
	// none is a table row.
	const restart = before.line(4 + 1500).from;
	const restarted: Rows = {
		length: before.length,
		next: () => -1,
		gap: (from, to) => (to > restart ? 0 : restart),
	};
	assert.deepEqual(at(updateTables(old, null, 0, before, before, restarted)), at(old));
});

test('deleting everything leaves no table, even past what the parser has read', () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |', '', '| b |', '| - |', '| 2 |');
	const changes = ChangeSet.of({ from: 0, to: before.length }, before.length);
	const after = changes.apply(before);
	assert.deepEqual(updateTables(findTables(before, parsed(before)), changes, before.length, before, after, parsed(after)), []);
	// The parser hasn't read the new text at all yet.
	assert.deepEqual(updateTables(findTables(before, parsed(before)), changes, before.length, before, after, parsed(after, 0)), []);
});

test("deleting a note's last table, with no line after it, leaves no table", () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |');
	const changes = ChangeSet.of({ from: before.line(3).from, to: before.length }, before.length);
	const after = changes.apply(before);
	assert.deepEqual(updateTables(findTables(before, parsed(before)), changes, before.length, before, after, parsed(after, 0)), []);
});

test('two tables joined past what the parser has read become one, not two over the same text', () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |', '', '| b |', '| - |', '| 2 |');
	const changes = ChangeSet.of({ from: before.line(6).from, to: before.line(7).from }, before.length);
	const after = changes.apply(before);
	const found = updateTables(findTables(before, parsed(before)), changes, before.length, before, after, parsed(after, 2));
	assert.equal(found.length, 1);
	assert.equal(found[0]!.to, after.length);
});

test('a line typed right above a table, at its header, keeps the table as the same one', () => {
	const before = doc('Text', '', '| a |', '| - |', '| 1 |');
	const changes = ChangeSet.of({ from: before.line(3).from, insert: 'New text\n\n' }, before.length);
	const { updated, scratch } = bothWays(before, changes);
	assert.deepEqual(at(updated), at(scratch));
	assert.equal(updated[0]!.was, 0);
});

test('the parser\'s rules for a header and its delimiter', () => {
	const opens = (...lines: string[]) => opensTable(doc('', ...lines), 1);
	assert.equal(opens('| a | b |', '| --- | :-: |'), true);
	assert.equal(opens('a | b', '--- | ---:'), true);
	assert.equal(opens('| a | b |', '| --- | |'), false);
	assert.equal(opens('| a | b |', '| --- | x |'), false);
	assert.equal(opens('a | b |', '--- | ---'), false);
	assert.equal(opens('| a | b |', '--- | ---'), false);
});

test('the parser reading further finds the tables it reaches', () => {
	const note = doc('Text', '', '| a |', '| - |', '| 1 |', '', '| b |', '| - |', '| 2 |');
	const early = findTables(note, parsed(note, note.line(5).to));
	const later = updateTables(early, null, note.line(5).to, note, note, parsed(note));
	assert.deepEqual(at(later), at(findTables(note, parsed(note))));
	assert.equal(later[0]!.was, 0);
	assert.equal(later[1]!.was, -1);
});

test("a table's end after a change reads only the changed lines when the old end is past them", () => {
	const before = doc('', '| a |', '| - |', '| 1 |', '| 2 |', '| 3 |', 'Text');
	const changes = ChangeSet.of({ from: before.line(4).from + 2, insert: 'x' }, before.length);
	const after = changes.apply(before);
	const change = lineChange(changes, before, after, before.line(2).from, before.line(7).to)!;
	assert.equal(endAfter(after, after.line(2).from, change, changes.mapPos(before.line(6).to, -1)), after.line(6).to);
	assert.equal(textEnd(after, after.line(2).from), after.line(6).to);
});

/** A small random generator, seeded, so a failure can be run again. */
function random(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

test('after any change, the tables updated are the tables found from scratch', () => {
	const pieces = ['Text', '', '## Heading', '| a | b |', '| - | - |', '| 1 | 2 |', '| 3 |', 'x | y', '- | -', '1 | 2', '|', '> quote'];
	const next = random(Number(process.env.FUZZ_SEED ?? 57));
	const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
	for (let round = 0; round < 2000; round++) {
		const before = doc(...Array.from({ length: 3 + Math.floor(next() * 14) }, () => pick(pieces)));
		// One to three changes at once, as a replace-all or several carets make.
		const changes: { from: number; to: number; insert: string }[] = [];
		let start = 0;
		for (let count = 1 + Math.floor(next() * 3); count > 0 && start <= before.length; count--) {
			const from = start + Math.floor(next() * (before.length - start + 1));
			const to = Math.min(before.length, from + Math.floor(next() * 12));
			changes.push({ from, to, insert: pick(['', '\n', '|', ' | ', '\n| 9 |', 'word', '\n\n', '- ']) });
			start = to + 1;
		}
		const { updated, scratch, after } = bothWays(before, ChangeSet.of(changes, before.length));
		assert.deepEqual(at(updated), at(scratch), `round ${round}: ${JSON.stringify(before.toString())} → ${JSON.stringify(after.toString())}`);
	}
});

test("after any change, a table's rows spliced from its old ones are its new rows", () => {
	const pieces = ['Text', '', '| a | b |', '| - | - |', '| 1 | 2 |', '| 3 |', '| 4 | 5 |', 'x | y', '|'];
	const next = random(86);
	const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
	const rowsOf = (note: Text, table: { from: number; to: number }) => {
		const { header, count } = linesOf(note, table);
		return Array.from({ length: count }, (_, r) => note.line(header + 2 + r).text);
	};
	let checked = 0;
	for (let round = 0; round < 2000; round++) {
		const before = doc('', '| h | i |', '| - | - |', ...Array.from({ length: 1 + Math.floor(next() * 8) }, () => pick(pieces)));
		const from = Math.floor(next() * (before.length + 1));
		const to = Math.min(before.length, from + Math.floor(next() * 10));
		const changes = ChangeSet.of({ from, to, insert: pick(['', '\n', '| 9 |', '\n| 8 | 7 |', 'z', '\n\n']) }, before.length);
		const { after, old, updated } = bothWays(before, changes);
		const table = updated.find((found) => found.was === 0);
		if (!old[0] || !table) continue;
		const change = lineChange(changes, before, after, old[0].from, endOfNextLine(before, old[0].to));
		const splices = change ? rowSplices(linesOf(before, old[0]), linesOf(after, table), change) : [];
		if (!splices) continue;
		const rows = rowsOf(before, old[0]);
		const now = rowsOf(after, table);
		for (const { at, removed, added } of splices) rows.splice(at, removed, ...now.slice(at, at + added));
		assert.deepEqual(rows, now, `round ${round}: ${JSON.stringify(before.toString())} → ${JSON.stringify(after.toString())}`);
		checked++;
	}
	assert.ok(checked > 500);
});
