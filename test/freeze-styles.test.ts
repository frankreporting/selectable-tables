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

test('styles.css paints every frozen cell, odd and even, whatever the count of frozen columns', () => {
	const rule = (selectors: string) => styles.split('}').find((block) => block.includes(selectors));
	const odd = rule('.selectable-tables-frozen-row > :is(th, td),\n') ?? '';
	const even = rule('.selectable-tables-frozen-row > :is(th, td):nth-child(even),\n') ?? '';
	assert.ok(odd.includes('background-color: var(--selectable-tables-page') && odd.includes('background-image: var(--selectable-tables-odd-cell'));
	assert.ok(even.includes('background-image: var(--selectable-tables-even-cell'));
	for (let count = 1; count <= MAX_FROZEN_COLUMNS; count++) {
		assert.ok(odd.includes(`frozen-columns-${count} :is(th, td):nth-child(-n + ${count}),`) || odd.includes(`frozen-columns-${count} :is(th, td):nth-child(-n + ${count}) {`), `odd ${count}`);
		// A single frozen column is odd.
		if (count > 1) assert.ok(even.includes(`frozen-columns-${count} :is(th, td):nth-child(-n + ${count}):nth-child(even)`), `even ${count}`);
	}
});

test('styles.css changes a frozen table\'s borders only when freeze.ts finds the theme collapses them', () => {
	const borders = styles.match(/border-(collapse|block-start-width|inline-start-width): [^;]+;/g) ?? [];
	assert.ok(borders.length >= 4);
	for (const block of styles.split('}').filter((rules) => /border-(collapse|block-start-width|inline-start-width):/.test(rules))) {
		assert.ok(block.includes('.selectable-tables-own-borders'), block);
	}
});
