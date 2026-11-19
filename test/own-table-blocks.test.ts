import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@codemirror/state';
import { BLOCK_ROWS, blockCount, blockHeight, blockOf, blockRows, blockSpans, bodyLayout, topInBlock } from '../src/own-table/blocks';
import { Heights } from '../src/own-table/heights';

const table = (rows: number) => Text.of(['Text', '', '| a | b |', '| - | - |', ...Array.from({ length: rows }, (_, n) => `| ${n + 1} | x |`), '', 'End']);
const spanOf = (doc: Text, rows: number) => ({ from: doc.line(3).from, to: doc.line(4 + rows).to });

test('a table of up to 100 rows is one block, and a longer one a block per 100 rows', () => {
	assert.equal(BLOCK_ROWS, 100);
	assert.equal(blockCount(0), 1);
	assert.equal(blockCount(100), 1);
	assert.equal(blockCount(101), 2);
	assert.equal(blockCount(2000), 20);
	assert.deepEqual(blockRows(50, 0), { first: 0, end: 50 });
	assert.deepEqual(blockRows(250, 1), { first: 100, end: 200 });
	assert.deepEqual(blockRows(250, 2), { first: 200, end: 250 });
	assert.equal(blockOf(250, 99), 0);
	assert.equal(blockOf(250, 100), 1);
	assert.equal(blockOf(250, 249), 2);
	assert.equal(blockOf(50, 49), 0);
});

test("each block covers its rows' lines: the first from the header, the last to the table's end", () => {
	const small = table(100);
	assert.deepEqual(blockSpans(small, spanOf(small, 100)), [spanOf(small, 100)]);
	const doc = table(250);
	const spans = blockSpans(doc, spanOf(doc, 250));
	assert.equal(spans.length, 3);
	assert.equal(spans[0]!.from, doc.line(3).from);
	// Row 1 is line 5; block 0 ends on row 100's line, and block 1 starts on row 101's.
	assert.equal(spans[0]!.to, doc.line(104).to);
	assert.equal(spans[1]!.from, doc.line(105).from);
	assert.equal(spans[1]!.to, doc.line(204).to);
	assert.equal(spans[2]!.from, doc.line(205).from);
	assert.equal(spans[2]!.to, doc.line(254).to);
	assert.equal(doc.sliceString(spans[1]!.from, spans[1]!.from + 7), '| 101 |');
});

test("a block's height takes the header and the box's padding only at the table's ends", () => {
	const heights = new Heights(Array.from({ length: 250 }, () => 10));
	assert.equal(blockHeight(heights, 0, 30, 16, 16), 16 + 30 + 1000);
	assert.equal(blockHeight(heights, 1, 30, 16, 16), 1000);
	assert.equal(blockHeight(heights, 2, 30, 16, 16), 500 + 16);
	const one = new Heights([10, 20]);
	assert.equal(blockHeight(one, 0, 30, 16, 12), 16 + 30 + 30 + 12);
	assert.equal(topInBlock(heights, 0, 30), 30);
	assert.equal(topInBlock(heights, 99, 30), 30 + 990);
	assert.equal(topInBlock(heights, 100, 30), 0);
	assert.equal(topInBlock(heights, 105, 30), 50);
});

test("a block's body keeps every drawn row odd or even as in one table, and hidden first and last rows inside", () => {
	const heights = new Heights(Array.from({ length: 300 }, () => 10));
	const all = () => true;
	// Block 1, rows 100 to 199, all drawn: a hidden first row, no spacer, and row 100 is the 101st body row, odd, as the
	// lead makes it the second: so a parity row, to make it third.
	const whole = bodyLayout(heights, 1, { first: 0, end: 300 }, all);
	assert.deepEqual(whole, { lead: true, above: null, parity: true, rows: { first: 100, end: 200 }, below: null, tail: true });
	// Rows 150 to 179 drawn: a spacer for 50 rows above, then row 150, the 151st, odd: lead and spacer before it, so
	// it would be third, odd, with no parity row.
	const middle = bodyLayout(heights, 1, { first: 150, end: 180 }, all);
	assert.deepEqual(middle, { lead: true, above: 500, parity: false, rows: { first: 150, end: 180 }, below: 200, tail: true });
	// Block 0: no hidden first row, and the last block no hidden last row.
	assert.deepEqual(bodyLayout(heights, 0, { first: 0, end: 40 }, all), { lead: false, above: null, parity: false, rows: { first: 0, end: 40 }, below: 600, tail: true });
	assert.deepEqual(bodyLayout(heights, 2, { first: 250, end: 300 }, all), { lead: true, above: 500, parity: false, rows: { first: 250, end: 300 }, below: null, tail: false });
	// Nothing of the block drawn: one spacer for all of it.
	assert.deepEqual(bodyLayout(heights, 2, { first: 0, end: 50 }, all), { lead: true, above: null, parity: true, rows: { first: 200, end: 200 }, below: 1000, tail: false });
	// Rows not rendered yet at the ends of those wanted close up into the spacers.
	assert.deepEqual(bodyLayout(heights, 1, { first: 100, end: 200 }, (row) => row >= 120 && row < 130).rows, { first: 120, end: 130 });
	// A table of one block, as part A drew it: no hidden rows.
	const one = new Heights(Array.from({ length: 50 }, () => 10));
	assert.deepEqual(bodyLayout(one, 0, { first: 10, end: 20 }, all), { lead: false, above: 100, parity: true, rows: { first: 10, end: 20 }, below: 300, tail: false });
});

test('the body rows before each drawn row count as many as in one table, so stripes run on across seams', () => {
	const heights = new Heights(Array.from({ length: 400 }, () => 10));
	for (const block of [0, 1, 2, 3]) {
		for (const [first, end] of [
			[block * 100, block * 100 + 100],
			[block * 100 + 7, block * 100 + 40],
			[block * 100 + 50, block * 100 + 51],
		]) {
			const body = bodyLayout(heights, block, { first: first!, end: end! }, () => true);
			const before = (body.lead ? 1 : 0) + (body.above !== null ? 1 : 0) + (body.parity ? 1 : 0);
			// The first drawn row is the (before + 1)th child; in one table it's the (first + 1)th body row.
			assert.equal((before + 1) % 2, (body.rows.first + 1) % 2, `block ${block}, rows ${first} to ${end}`);
		}
	}
});
