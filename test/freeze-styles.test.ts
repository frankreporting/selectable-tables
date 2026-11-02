import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ANIMATION_REACH } from '../src/editor/freeze';
import { MAX_FROZEN_COLUMNS } from '../src/editor/freeze-mark';

const styles = readFileSync('styles.css', 'utf8');

test('styles.css runs the rows\' animation as far past the pane as the script allows for', () => {
	assert.ok(styles.includes(`view-timeline-inset: -${ANIMATION_REACH}px 0;`));
	assert.ok(styles.includes(`calc(var(--table-drag-handle-size) - var(--selectable-tables-pin-top) - ${ANIMATION_REACH}px) exit-crossing calc(100% - var(--selectable-tables-pin-top))`));
});

test('styles.css picks and places every column a table can freeze, and no more', () => {
	const picks = new Set(Array.from(styles.matchAll(/frozen-columns-(\d+) :is\(th, td\):nth-child\(-n \+ (\d+)\)/g), ([, count, last]) => {
		assert.equal(count, last);
		return Number(count);
	}));
	assert.deepEqual(Array.from(picks).sort((a, b) => a - b), Array.from({ length: MAX_FROZEN_COLUMNS }, (_, index) => index + 1));
	for (let column = 2; column <= MAX_FROZEN_COLUMNS; column++) {
		assert.ok(styles.includes(`:is(th, td):nth-child(${column}) {\n\tinset-inline-start: var(--selectable-tables-column-${column});`), `column ${column}`);
	}
	assert.ok(!styles.includes(`--selectable-tables-column-${MAX_FROZEN_COLUMNS + 1}`));
});
