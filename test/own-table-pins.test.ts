import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenIn, pinsFit, railOf, stickyTops, stripWidth } from '../src/own-table/pin-sums';

const sizes = { rows: 60, table: 2000, pane: 700, columns: 120, room: 600, slides: true };

test('a freeze is held to the table it marks', () => {
	assert.deepEqual(frozenIn({ rows: 2, columns: 1 }, 51, 8), { rows: 2, columns: 1 });
	assert.deepEqual(frozenIn({ rows: 9, columns: 12 }, 3, 4), { rows: 3, columns: 4 });
});

test('frozen rows stick one under another, the header first', () => {
	assert.deepEqual(stickyTops([31, 40.5, 20]), [0, 31, 71.5]);
	assert.deepEqual(stickyTops([]), []);
});

test('only what leaves room pins', () => {
	assert.deepEqual(pinsFit({ rows: 2, columns: 1 }, sizes), { rows: true, columns: true });
	// Rows taller than half the pane scroll with the table.
	assert.equal(pinsFit({ rows: 2, columns: 1 }, { ...sizes, rows: 351 }).rows, false);
	assert.equal(pinsFit({ rows: 2, columns: 1 }, { ...sizes, rows: 350 }).rows, true);
	// A table no taller than its frozen rows has nothing to pass under them.
	assert.equal(pinsFit({ rows: 2, columns: 0 }, { ...sizes, table: 60 }).rows, false);
	// Columns as wide as the table's box scroll with it, and a table that doesn't move sideways needs no strip.
	assert.equal(pinsFit({ rows: 0, columns: 3 }, { ...sizes, columns: 600 }).columns, false);
	assert.equal(pinsFit({ rows: 0, columns: 1 }, { ...sizes, slides: false }).columns, false);
	assert.deepEqual(pinsFit({ rows: 0, columns: 0 }, sizes), { rows: false, columns: false });
});

test("a block's copy of the frozen rows rides from the table's top, or the rows' height above the block", () => {
	const block = { tableTop: 16, tableBottom: 5016, height: 5032 };
	// The first block's starts at the table's top, so the copy lies over the real rows there.
	assert.deepEqual(railOf({ ...block, first: true, last: false }, 60), { top: 16, bottom: -60 });
	// A middle block's runs the rows' height past both its ends, so copies hand over at each seam.
	assert.deepEqual(railOf({ first: false, last: false, tableTop: 0, tableBottom: 5000, height: 5000 }, 60), { top: -60, bottom: -60 });
	// The last block's ends the rows' height above the table's end, so the rows leave with the table.
	assert.deepEqual(railOf({ first: false, last: true, tableTop: 0, tableBottom: 3000, height: 3016 }, 60), { top: -60, bottom: 76 });
});

test("the strip is as wide as the frozen columns, the space between them, and the table's border at its start", () => {
	assert.equal(stripWidth([100, 50, 70], 2, 0, 1), 151);
	assert.equal(stripWidth([100, 50, 70], 1, 4, 0), 108);
});
