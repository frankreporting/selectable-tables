import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layers, opacity } from '../src/editor/theme-paint';

test('reads how opaque a computed color is, in the forms browsers give', () => {
	assert.equal(opacity('rgba(0, 0, 0, 0)'), 0);
	assert.equal(opacity('transparent'), 0);
	assert.equal(opacity('rgb(248, 248, 248)'), 1);
	assert.equal(opacity('rgba(120, 120, 255, 0.12)'), 0.12);
	assert.equal(opacity('rgb(120 120 255 / 40%)'), 0.4);
	assert.equal(opacity('oklch(0.97 0.01 250)'), 1);
	assert.equal(opacity('oklch(0.6 0.1 250 / 0.08)'), 0.08);
	assert.equal(opacity('color(srgb 0.5 0.5 0.5 / 0.25)'), 0.25);
	assert.equal(opacity('color(display-p3 1 0 0)'), 1);
	assert.equal(opacity('lab(50 10 10 / none)'), 0);
});

test('a color it can\'t read counts as see-through, so whatever is under it is still laid under', () => {
	assert.ok(Number.isNaN(opacity('color-mix(in srgb, currentcolor 10%, transparent)')));
	assert.ok(Number.isNaN(opacity('rgb(from red r g b / alpha)')));
	assert.ok(!(opacity('color-mix(in srgb, currentcolor 10%, transparent)') >= 1));
});

test('lays colors over each other as one-color gradients, top first', () => {
	assert.equal(layers([]), 'none');
	assert.equal(layers(['rgba(255, 255, 255, 0.5)', 'rgb(236, 238, 230)']), 'linear-gradient(rgba(255, 255, 255, 0.5) 0 0), linear-gradient(rgb(236, 238, 230) 0 0)');
});
