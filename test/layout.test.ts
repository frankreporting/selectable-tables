import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockInfo, BlockType } from '@codemirror/view';
import { partAt } from '../src/editor/layout';

/** A stand-in for CodeMirror's BlockInfo: only the fields partAt reads. */
const block = (from: number, to: number, type: BlockType | BlockInfo[]) => ({ from, to, type }) as unknown as BlockInfo;

test('a plain line block is its own part', () => {
	const line = block(0, 40, BlockType.WidgetRange);
	assert.equal(partAt(line, 10), line);
});

test('a table with an exclusive start comes with an empty text part, and the table wins', () => {
	// What CodeMirror reports for a table at a note's start, or right below the frontmatter.
	const text = block(0, 0, BlockType.Text);
	const table = block(0, 40, BlockType.WidgetRange);
	const line = block(0, 40, [text, table]);
	assert.equal(partAt(line, 0), table);
	assert.equal(partAt(line, 40), table);
});

test('a table with an exclusive end, at the note end, still wins at its last character', () => {
	const table = block(10, 50, BlockType.WidgetRange);
	const line = block(10, 50, [table, block(50, 50, BlockType.Text)]);
	assert.equal(partAt(line, 50), table);
});

test('zero-length widgets beside a text line leave the text part', () => {
	const text = block(5, 20, BlockType.Text);
	const line = block(5, 20, [block(5, 5, BlockType.WidgetBefore), text, block(20, 20, BlockType.WidgetAfter)]);
	assert.equal(partAt(line, 5), text);
	assert.equal(partAt(line, 20), text);
});
