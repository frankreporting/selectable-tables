import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasMark, markText, MAX_FROZEN_COLUMNS, readFreeze, withFreeze, withoutMark } from '../src/editor/freeze-mark';

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

const freeze = (rows: number, columns: number) => ({ rows, columns });

test('the mark the commands write reads back as the same freeze', () => {
	assert.equal(markText(freeze(2, 1)), '%%freeze 2 1%%');
	assert.deepEqual(readFreeze(`| ${markText(freeze(3, 4))} Name |`), freeze(3, 4));
});

test('a header row knows it holds a mark, even one that freezes nothing, and not one shown as code', () => {
	assert.ok(hasMark('| %%freeze 0 0%% Name |'));
	assert.ok(hasMark('| Name | %%freeze 1 1%% |'));
	assert.ok(!hasMark('| Name | Age |'));
	assert.ok(!hasMark('| `%%freeze 1 1%%` | Age |'));
});

test('a new mark goes at the start of the first cell\'s text', () => {
	assert.equal(withFreeze('| Name | Age |', freeze(2, 1)), '| %%freeze 2 1%% Name | Age |');
	assert.equal(withFreeze('|Name|Age|', freeze(2, 1)), '| %%freeze 2 1%% Name|Age|');
	assert.equal(withFreeze('  | Name | Age |', freeze(1, 0)), '  | %%freeze 1 0%% Name | Age |');
});

test('in an empty first cell, the mark keeps a space before it', () => {
	assert.equal(withFreeze('|      | Age |', freeze(1, 1)), '| %%freeze 1 1%%     | Age |');
	assert.equal(withFreeze('|| Age |', freeze(1, 1)), '| %%freeze 1 1%% | Age |');
});

test('a row with no leading pipe takes the mark after the first cell\'s text: a line starting with %% is a comment', () => {
	assert.equal(withFreeze('Name | Age', freeze(2, 1)), 'Name %%freeze 2 1%% | Age');
	assert.equal(withFreeze('a \\| b | Age', freeze(2, 1)), 'a \\| b %%freeze 2 1%% | Age');
});

test('an escaped pipe stays inside the first cell', () => {
	assert.equal(withFreeze('| a \\| b | Age |', freeze(1, 1)), '| %%freeze 1 1%% a \\| b | Age |');
});

test('a mark already there is written over where it is, so a moved column keeps it', () => {
	assert.equal(withFreeze('| %%freeze 2 1%% Name | Age |', freeze(3, 1)), '| %%freeze 3 1%% Name | Age |');
	assert.equal(withFreeze('| Name | Age %%freeze 2 1%% |', freeze(3, 1)), '| Name | Age %%freeze 3 1%% |');
});

test('only the mark\'s own text is written over, so the text around it stays as it was', () => {
	assert.equal(withFreeze('| Name | %% freeze  2  1 %%Age |', freeze(1, 1)), '| Name | %%freeze 1 1%%Age |');
	assert.equal(withFreeze('| Na%%freeze 2 1%%me |', freeze(3, 1)), '| Na%%freeze 3 1%%me |');
});

test('a second mark goes, so the one written is the one that counts', () => {
	assert.equal(withFreeze('| %%freeze 1 1%% Name | %%freeze 4 4%% Age |', freeze(2, 2)), '| %%freeze 2 2%% Name | Age |');
});

test('freezing nothing takes every mark out, with its space', () => {
	assert.equal(withFreeze('| %%freeze 2 1%% Name | Age |', freeze(0, 0)), '| Name | Age |');
	assert.equal(withFreeze('| Name %%freeze 2 1%% | Age |', freeze(0, 0)), '| Name | Age |');
	assert.equal(withFreeze('| Name %%freeze 2 1%%| Age |', freeze(0, 0)), '| Name| Age |');
	assert.equal(withFreeze('| %%freeze 2 1%% | Age |', freeze(0, 0)), '| | Age |');
	assert.equal(withFreeze('| %%freeze 1 1%% Name | %%freeze 4 4%% Age |', freeze(0, 0)), '| Name | Age |');
	assert.equal(withFreeze('| Name | Age |', freeze(0, 0)), '| Name | Age |');
});

test('a mark shown as code is left as it is', () => {
	assert.equal(withFreeze('| `%%freeze 2 1%%` | Age |', freeze(1, 0)), '| %%freeze 1 0%% `%%freeze 2 1%%` | Age |');
	assert.equal(withFreeze('| `%%freeze 2 1%%` | Age |', freeze(0, 0)), '| `%%freeze 2 1%%` | Age |');
});

test('a cell copied without its mark keeps the rest of its text', () => {
	assert.equal(withoutMark('%%freeze 2 1%% Name'), 'Name');
	assert.equal(withoutMark('Na %%freeze 2 1%% me'), 'Na me');
	assert.equal(withoutMark('%%freeze 2 1%%'), '');
	assert.equal(withoutMark('`%%freeze 2 1%%` shows the mark'), '`%%freeze 2 1%%` shows the mark');
	assert.equal(withoutMark('Name'), 'Name');
});
