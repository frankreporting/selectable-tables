import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearance } from '../src/editor/cells';

const pinned = { rows: 2, columns: 1, height: 70, width: 116 };

test('a cell that passes under the frozen rows and columns has to clear both', () => {
	assert.deepEqual(clearance({ row: 20, column: 3 }, pinned), { block: 70, inline: 116 });
});

test('a cell of a frozen row stays with those rows, so only the columns can cover it', () => {
	assert.deepEqual(clearance({ row: 1, column: 3 }, pinned), { block: 0, inline: 116 });
});

test('a cell of a frozen column stays with that column, so only the rows can cover it', () => {
	assert.deepEqual(clearance({ row: 20, column: 0 }, pinned), { block: 70, inline: 0 });
});

test('a frozen corner cell has nothing to clear', () => {
	assert.deepEqual(clearance({ row: 0, column: 0 }, pinned), { block: 0, inline: 0 });
});

test('the first row and column past the frozen ones pass under them', () => {
	assert.deepEqual(clearance({ row: 2, column: 1 }, pinned), { block: 70, inline: 116 });
});

test('rows or columns too big to pin take no room', () => {
	assert.deepEqual(clearance({ row: 20, column: 3 }, { rows: 2, columns: 1, height: 0, width: 0 }), { block: 0, inline: 0 });
});
