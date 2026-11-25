import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clickOpens, columnExtents, type DragArea, edgeScroll, landing, lookAt, overPinned, targetEdge, zoneScroll } from '../src/own-table/drag-sums';

const pane = { top: 100, bottom: 700, left: 0, right: 800 };

test('a dragged handle scrolls the box only within 16 px a device pixel of its edges, faster the deeper it is', () => {
	assert.deepEqual(edgeScroll(pane, 400, 400, 16, 2), { dx: 0, dy: 0 });
	assert.deepEqual(edgeScroll(pane, 400, 100 + 32, 16, 2), { dx: 0, dy: 0 });
	// At the very edge, 2 px a millisecond, as Obsidian has it.
	assert.equal(edgeScroll(pane, 400, 700, 16, 2).dy, 32);
	assert.equal(edgeScroll(pane, 400, 100, 16, 2).dy, -32);
	// Halfway into the band, half that.
	assert.equal(edgeScroll(pane, 400, 700 - 16, 16, 2).dy, 16);
	// Past the edge, faster still.
	assert.ok(edgeScroll(pane, 400, 750, 16, 2).dy > 32);
	assert.deepEqual(edgeScroll(pane, 790, 400, 16, 1), { dx: (2 * 16 * 6) / 16, dy: 0 });
});

test('the band is a third of a small box at most', () => {
	const small = { top: 0, bottom: 30, left: 0, right: 30 };
	assert.equal(edgeScroll(small, 15, 15, 16, 2).dy, 0);
	assert.ok(edgeScroll(small, 15, 25, 16, 2).dy > 0);
});

test('a handle lands on the row or column its middle is over, kept within the table', () => {
	const columns = columnExtents([100, 50, 80], 0, 0, 230, false);
	assert.deepEqual(columns.map((c) => [c.index, c.start, c.end]), [
		[0, 0, 100],
		[1, 100, 150],
		[2, 150, 230],
	]);
	assert.equal(landing(columns, 120, 230)?.index, 1);
	assert.equal(landing(columns, -40, 230)?.index, 0);
	assert.equal(landing(columns, 900, 230)?.index, 2);
});

test('columns from the right in a table that runs right to left, with the borders\' and spacing\'s room', () => {
	const columns = columnExtents([100, 50], 2, 4, 2 + 4 * 3 + 150, true);
	// Column 0 is at the right: its right edge sits a border's half and a space in from the table's right.
	const first = columns.find((c) => c.index === 0)!;
	assert.equal(first.end, 164 - 1 - 4);
	assert.equal(first.start, 164 - 1 - 4 - 100);
	assert.equal(landing(columns, 10, 164)?.index, 1);
});

test('the line goes on the landing row\'s near edge, toward where the handle came from, and nowhere where it started', () => {
	assert.equal(targetEdge({ index: 2, start: 40, end: 60 }, 5), 40);
	assert.equal(targetEdge({ index: 7, start: 140, end: 160 }, 5), 160);
	assert.equal(targetEdge({ index: 5, start: 100, end: 120 }, 5), null);
});

test('in the space a theme puts between cells, a handle lands on the nearer column, never the last', () => {
	const spaced = columnExtents([100, 50, 80], 0, 10, 270, false);
	// Column 0 runs 10 to 110 and column 1 120 to 170.
	assert.equal(landing(spaced, 116, 270)?.index, 1);
	assert.equal(landing(spaced, 114, 270)?.index, 0);
	assert.equal(landing(spaced, 2, 270)?.index, 0);
});

/** A table running past the pane's top and bottom, in a box narrower than it, nothing pinned. */
const tall: DragArea = {
	pane: { top: 100, bottom: 700, left: 0, right: 800 },
	table: { top: -2000, bottom: 3000, left: -300, right: 900 },
	box: { left: 50, right: 750 },
	rows: null,
	strip: null,
	rtl: false,
};

test('a drag across cells looks for the cell under the pointer within the part of the table on the screen', () => {
	assert.deepEqual(lookAt(tall, 400, 400), { x: 400, y: 400 });
	// Past the pane's bottom and the box's sides, the nearest cell in the pointer's column or row.
	assert.deepEqual(lookAt(tall, 400, 900), { x: 400, y: 699 });
	assert.deepEqual(lookAt(tall, 10, 400), { x: 51, y: 400 });
	assert.deepEqual(lookAt(tall, 790, 400), { x: 749, y: 400 });
	// A short table: below it, its last row; above it, its header.
	const short = { ...tall, table: { top: 300, bottom: 400, left: 100, right: 300 } };
	assert.deepEqual(lookAt(short, 200, 600), { x: 200, y: 399 });
	assert.deepEqual(lookAt(short, 500, 120), { x: 299, y: 301 });
	// Above the pinned rows, in the band left for their grips, the pinned header.
	const pinned = { ...tall, rows: { top: 116, bottom: 180 } };
	assert.deepEqual(lookAt(pinned, 400, 105), { x: 400, y: 117 });
});

test('what pins is the pinned rows and the strip, on the strip\'s side', () => {
	const pinned = { ...tall, rows: { top: 116, bottom: 180 }, strip: 200 };
	assert.ok(overPinned(pinned, 400, 150));
	assert.ok(!overPinned(pinned, 400, 180));
	assert.ok(overPinned(pinned, 150, 400));
	assert.ok(!overPinned(pinned, 250, 400));
	assert.ok(overPinned({ ...pinned, rows: null, rtl: true, strip: 600 }, 650, 400));
	assert.ok(!overPinned({ ...pinned, rows: null, rtl: true, strip: 600 }, 550, 400));
});

test('a drag across cells scrolls the note near the pane\'s bottom, or just under the pinned rows, faster the deeper', () => {
	assert.deepEqual(zoneScroll(tall, 400, 400, 16, 2), { dx: 0, dy: 0 });
	assert.equal(zoneScroll(tall, 400, 700, 16, 2).dy, 32);
	assert.equal(zoneScroll(tall, 400, 700 - 16, 16, 2).dy, 16);
	// Past the edge, no faster than at it.
	assert.equal(zoneScroll(tall, 400, 900, 16, 2).dy, 32);
	assert.equal(zoneScroll(tall, 400, 20, 16, 2).dy, -32);
	// With rows pinned, the zone is just under them, and a pointer on them scrolls nothing.
	const pinned = { ...tall, rows: { top: 116, bottom: 180 } };
	assert.equal(zoneScroll(pinned, 400, 180, 16, 2).dy, -32);
	assert.equal(zoneScroll(pinned, 400, 196, 16, 2).dy, -16);
	assert.equal(zoneScroll(pinned, 400, 150, 16, 2).dy, 0);
	assert.equal(zoneScroll(pinned, 400, 20, 16, 2).dy, 0);
});

test('the note scrolls only while there are rows of the table beyond the pane that way', () => {
	const ending = { ...tall, table: { ...tall.table, bottom: 650 } };
	assert.equal(zoneScroll(ending, 400, 700, 16, 2).dy, 0);
	const starting = { ...tall, table: { ...tall.table, top: 150 } };
	assert.equal(zoneScroll(starting, 400, 100, 16, 2).dy, 0);
	assert.equal(zoneScroll(starting, 400, 700, 16, 2).dy, 32);
});

test('a drag across cells moves the table sideways near its box\'s sides, or just beside the frozen columns', () => {
	assert.equal(zoneScroll(tall, 750, 400, 16, 2).dx, 32);
	assert.equal(zoneScroll(tall, 50, 400, 16, 2).dx, -32);
	assert.equal(zoneScroll(tall, 5, 400, 16, 2).dx, -32);
	const frozen = { ...tall, strip: 200 };
	assert.equal(zoneScroll(frozen, 200, 400, 16, 2).dx, -32);
	assert.equal(zoneScroll(frozen, 150, 400, 16, 2).dx, 0);
	assert.equal(zoneScroll({ ...tall, rtl: true, strip: 600 }, 600, 400, 16, 2).dx, 32);
	assert.equal(zoneScroll({ ...tall, rtl: true, strip: 600 }, 650, 400, 16, 2).dx, 0);
});

test('with the setting on, a click selects a cell, and a double-click, or a click on the cell already selected, opens it', () => {
	const click = { selects: true, count: 1, open: false, selectedAlone: false };
	assert.equal(clickOpens(click), false);
	assert.equal(clickOpens({ ...click, count: 2 }), true);
	assert.equal(clickOpens({ ...click, selectedAlone: true }), true);
	// A click in the open cell's own space keeps it open.
	assert.equal(clickOpens({ ...click, open: true }), true);
	// The setting off: every click opens, as in Obsidian.
	assert.equal(clickOpens({ ...click, selects: false }), true);
});
