import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnExtents, edgeScroll, landing, targetEdge } from '../src/own-table/drag-sums';

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
