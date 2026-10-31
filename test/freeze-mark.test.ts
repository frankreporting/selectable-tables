import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FROZEN_COLUMNS, readFreeze } from '../src/editor/freeze-mark';

const nothing = { rows: 0, columns: 0 };

test('a header row with no mark freezes nothing', () => {
	assert.deepEqual(readFreeze('| Name | Age |'), nothing);
});

test('the mark gives rows, then columns', () => {
	assert.deepEqual(readFreeze('| %%freeze 2 1%% Name | Age |'), { rows: 2, columns: 1 });
});

test('the mark is read from anywhere in the header row, so moving its column keeps it', () => {
	assert.deepEqual(readFreeze('| Name | Age %%freeze 1 2%% |'), { rows: 1, columns: 2 });
	assert.deepEqual(readFreeze('| Name | Age | %%freeze 1 2%% |'), { rows: 1, columns: 2 });
});

test('a mark of zeros freezes nothing', () => {
	assert.deepEqual(readFreeze('| %%freeze 0 0%% Name | Age |'), nothing);
});

test('either number can be zero', () => {
	assert.deepEqual(readFreeze('| %%freeze 3 0%% Name |'), { rows: 3, columns: 0 });
	assert.deepEqual(readFreeze('| %%freeze 0 3%% Name |'), { rows: 0, columns: 3 });
});

test('columns past the limit are clamped when read', () => {
	assert.deepEqual(readFreeze('| %%freeze 1 40%% Name |'), { rows: 1, columns: MAX_FROZEN_COLUMNS });
});

test('spaces inside the comment are allowed, as in any Obsidian comment', () => {
	assert.deepEqual(readFreeze('| %% freeze  2  1 %% Name |'), { rows: 2, columns: 1 });
});

test('the first of two marks wins', () => {
	assert.deepEqual(readFreeze('| %%freeze 1 1%% Name | %%freeze 4 4%% Age |'), { rows: 1, columns: 1 });
});

test('text that only looks like the mark freezes nothing', () => {
	for (const header of ['| freeze 2 1 | Age |', '| %%freeze 2%% Name |', '| %%freeze two one%% Name |', '| %%freezes 2 1%% Name |', '| %freeze 2 1% Name |', '| %%freeze 2 1 Name |']) {
		assert.deepEqual(readFreeze(header), nothing, header);
	}
});

test('a mark shown as code is text, not a comment, so a table can document the mark', () => {
	assert.deepEqual(readFreeze('| `%%freeze 2 1%%` | What it does |'), nothing);
	assert.deepEqual(readFreeze('| ``%%freeze 2 1%%`` | What it does |'), nothing);
	assert.deepEqual(readFreeze('| `%%freeze 2 1%%` | %%freeze 1 0%% Name |'), { rows: 1, columns: 0 });
});
