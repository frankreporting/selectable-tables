import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenIn, pinsFit, railOf, showDown, stickyTops, stripWidth } from '../src/own-table/pin-sums';

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

// A pane from 100 to 800 on the screen, with 60 px of rows pinned at its top.
const pane = { top: 100, bottom: 800, margin: 8, under: 60, pinned: false, tableTop: null };

test('a cell that passes under the pinned rows is shown below them, and only as far as it must', () => {
	// Half under the pinned rows: down to just below them, its margin kept.
	assert.equal(showDown({ ...pane, cellTop: 130, cellBottom: 160 }), 130 - 8 - 160);
	// Clear of them already: the note stays.
	assert.equal(showDown({ ...pane, cellTop: 200, cellBottom: 230 }), 0);
	// Past the pane's bottom: up to the bottom, as before.
	assert.equal(showDown({ ...pane, cellTop: 790, cellBottom: 820 }), 820 + 8 - 800);
	// With nothing pinned, the pane's top is the limit.
	assert.equal(showDown({ ...pane, under: 0, cellTop: 130, cellBottom: 160 }), 0);
	// A cell taller than the room left below the pinned rows starts right under them.
	assert.equal(showDown({ ...pane, cellTop: 300, cellBottom: 1000 }), 300 - 8 - 160);
});

test('a pinned cell moves the note only when it is out of the pane, or a key went up into the pinned rows', () => {
	const pinned = { ...pane, pinned: true, under: 0 };
	// Where the rows pin, at the pane's top, it's in view whatever its margin.
	assert.equal(showDown({ ...pinned, cellTop: 100, cellBottom: 130 }), 0);
	// Left behind above the pane with the table's end: back to it.
	assert.equal(showDown({ ...pinned, cellTop: -400, cellBottom: -370 }), -500);
	// Below the pane, before the table: down to it.
	assert.equal(showDown({ ...pinned, cellTop: 900, cellBottom: 930 }), 130);
	// Up into the pinned rows from below: the table goes back to its top, so the rows under them show again.
	assert.equal(showDown({ ...pinned, cellTop: 100, cellBottom: 130, tableTop: -2400 }), -2500);
	assert.equal(showDown({ ...pinned, cellTop: 300, cellBottom: 330, tableTop: 300 }), 0);
});
