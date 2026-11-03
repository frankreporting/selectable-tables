import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copiesWidth, Shape } from '../src/editor/width-copy';

// A cell's rendered text as Obsidian draws it, by the names of its nodes.
const node = (nodeName: string, ...childNodes: Shape[]): Shape => ({ nodeName, childNodes });
const text = node('#text');
const rendered = (...childNodes: Shape[]) => node('DIV', ...childNodes);

test('a cell with text gets a copy', () => {
	assert.equal(copiesWidth(rendered(text), false), true);
});

test('a cell with a link gets a copy', () => {
	assert.equal(copiesWidth(rendered(node('A', text)), false), true);
});

test('an empty cell, which Obsidian draws as a lone line break, gets none, so it grows as you type', () => {
	assert.equal(copiesWidth(rendered(node('BR')), false), false);
});

test('a cell with nothing drawn in it gets none', () => {
	assert.equal(copiesWidth(rendered(), false), false);
});

test('a line break between words is text, and gets a copy', () => {
	assert.equal(copiesWidth(rendered(text, node('BR'), text), false), true);
});

test('a picture gets a copy, drawn again from the cache', () => {
	assert.equal(copiesWidth(rendered(node('SPAN', node('IMG'))), false), true);
});

test('a frame, a video, a sound, an object or an embed gets none, since a copy would load it again', () => {
	for (const name of ['IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']) {
		assert.equal(copiesWidth(rendered(text, node('SPAN', node('DIV', node(name)))), false), false, name);
	}
});

test('a cell whose editor already holds a copy gets no second one', () => {
	assert.equal(copiesWidth(rendered(text), true), false);
});
