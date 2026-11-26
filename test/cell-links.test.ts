import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuTitle, pickLinks } from '../src/own-table/cell-links';

const link = (href: string, internal = true, inEmbed = false) => ({ href, internal, inEmbed });

test('a cell\'s links are every drawn link, in order, internal and web alike', () => {
	const drawn = [link('Watering schedule'), link('https://example.com', false), link('Cell moves')];
	assert.deepEqual(pickLinks(drawn), drawn);
});

test('a link inside an embed, such as a picture or an embedded note, isn\'t counted', () => {
	assert.deepEqual(pickLinks([link('sample image.png', true, true), link('Cell moves')]), [link('Cell moves')]);
	assert.deepEqual(pickLinks([link('sample image.png', true, true)]), []);
});

test('a link with no address isn\'t counted', () => {
	assert.deepEqual(pickLinks([link(''), link('Cell moves')]), [link('Cell moves')]);
});

test('the menu names a link by its address, cut to 100 characters as Bases cuts it', () => {
	assert.equal(menuTitle('Watering schedule'), 'Watering schedule');
	const long = `https://example.com/${'a'.repeat(120)}`;
	assert.equal(menuTitle(long), `${long.slice(0, 99)}…`);
	assert.equal(menuTitle('x'.repeat(100)), 'x'.repeat(100));
});
