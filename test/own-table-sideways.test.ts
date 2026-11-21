import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barAt, barPlace, clampSlide, GESTURE_GAP, maxSlide, revealDelta, Swipes, wheelStep, type WheelLike } from '../src/own-table/sideways';

const wheel = (deltaX: number, deltaY: number, more: Partial<WheelLike> = {}): WheelLike => ({ deltaX, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, ...more });

test('a wheel step is read in pixels, Shift with a mouse wheel goes sideways, and Ctrl or a pinch zooms', () => {
	assert.deepEqual(wheelStep(wheel(12, -3), 800), { dx: 12, dy: -3 });
	// Windows and Linux send Shift with the wheel up or down; a Mac already sends it sideways.
	assert.deepEqual(wheelStep(wheel(0, 40, { shiftKey: true }), 800), { dx: 40, dy: 0 });
	assert.deepEqual(wheelStep(wheel(40, 0, { shiftKey: true }), 800), { dx: 40, dy: 0 });
	assert.equal(wheelStep(wheel(0, 5, { ctrlKey: true }), 800), null);
	assert.deepEqual(wheelStep(wheel(1, 2, { deltaMode: 1 }), 800), { dx: 16, dy: 32 });
	assert.deepEqual(wheelStep(wheel(1, 0, { deltaMode: 2 }), 800), { dx: 800, dy: 0 });
});

test('a swipe keeps the direction it started with, over the table it started on', () => {
	const swipes = new Swipes();
	const table = {};
	// Mostly sideways over a wide table: held sideways, though it turns up or down later, and through its momentum.
	assert.deepEqual(swipes.next(0, { dx: 8, dy: 3 }, table, true), { hold: 'sideways', table });
	assert.deepEqual(swipes.next(16, { dx: 1, dy: 9 }, table, true), { hold: 'sideways', table });
	assert.deepEqual(swipes.next(32, { dx: 2, dy: 0 }, null, true), { hold: 'sideways', table });
	// A pause starts a new one: mostly vertical, so the note's, and its sideways part is left alone.
	const later = 32 + GESTURE_GAP + 1;
	assert.deepEqual(swipes.next(later, { dx: 2, dy: 9 }, table, true), { hold: 'note', table });
	assert.deepEqual(swipes.next(later + 16, { dx: 30, dy: 1 }, table, false), { hold: 'note', table });
	// The browser lets the first event of its next swipe be cancelled: a new swipe, with no pause.
	assert.deepEqual(swipes.next(later + 32, { dx: 30, dy: 1 }, table, true), { hold: 'sideways', table });
});

test('a swipe over no wide table is the note’s, and a step with no movement decides nothing', () => {
	const swipes = new Swipes();
	assert.deepEqual(swipes.next(0, { dx: 20, dy: 0 }, null, true), { hold: 'note', table: null });
	const fresh = new Swipes();
	assert.equal(fresh.next(0, { dx: 0, dy: 0 }, {}, true), null);
	assert.equal(fresh.next(10, { dx: 3, dy: 0 }, {}, false)?.hold, 'sideways');
	// An even step goes to the note, as the browser scrolls up and down first.
	assert.equal(new Swipes().next(0, { dx: 4, dy: -4 }, {}, true)?.hold, 'note');
});

test('a table moves as far as its width and the box’s padding pass the room inside the box', () => {
	assert.equal(maxSlide(1000, 16, 16, 700), 332);
	assert.equal(maxSlide(600, 16, 16, 700), 0);
	assert.equal(maxSlide(668, 16, 16, 700), 0);
	// Rounded to whole pixels, as the browser rounds a box's scroll range.
	assert.equal(maxSlide(668.4, 16, 16, 700), 0);
	assert.equal(maxSlide(668.6, 16, 16, 700), 1);
	assert.equal(maxSlide(982.83, 16, 16, 732), 283);
	assert.equal(clampSlide(400, 332, false), 332);
	assert.equal(clampSlide(-5, 332, false), 0);
	// Right to left, the scroll runs from 0 at the table's right edge down to -max at its left.
	assert.equal(clampSlide(-400, 332, true), -332);
	assert.equal(clampSlide(5, 332, true), 0);
});

test('bringing a span into view sideways moves the table just enough, as scrollIntoView with nearest', () => {
	const box = { left: 100, right: 500 };
	// In view: no move.
	assert.equal(revealDelta(box, { left: 150, right: 300 }, 0, false), 0);
	// Left of the box: its left edge to the box's.
	assert.equal(revealDelta(box, { left: 40, right: 120 }, 0, false), -60);
	// Right of it: its right edge to the box's.
	assert.equal(revealDelta(box, { left: 450, right: 560 }, 0, false), 60);
	// Wider than the box: its start to the box's start.
	assert.equal(revealDelta(box, { left: 50, right: 700 }, 0, false), -50);
	assert.equal(revealDelta(box, { left: 120, right: 700 }, 0, false), 20);
	// Room kept clear at the start, for a frozen column: in view only right of it.
	assert.equal(revealDelta(box, { left: 150, right: 300 }, 80, false), -30);
	assert.equal(revealDelta(box, { left: 200, right: 300 }, 80, false), 0);
	// Right to left, the start is the box's right edge, and the room kept clear is there.
	assert.equal(revealDelta(box, { left: 50, right: 900 }, 0, true), 400);
	assert.equal(revealDelta(box, { left: 380, right: 460 }, 80, true), 40);
});

test('at the table’s end, the move is cut to what the table has left', () => {
	const max = 332;
	const at = 300;
	// A span past the end asks for more than the table has.
	const delta = revealDelta({ left: 100, right: 500 }, { left: 520, right: 600 }, 0, false);
	assert.equal(clampSlide(at + delta, max, false), max);
	assert.equal(clampSlide(at - 400, max, false), 0);
});

test('the scrollbar sits under the header, rides the pane’s bottom while the table crosses it, then stays under the last row', () => {
	// The header ends at 1000 in the note's content and the last row at 3000; a 16 px bar, a 700 px pane, 24 px hidden.
	const place = barPlace(1000, 3000, 16, 700, 24);
	assert.equal(place.top, 3000);
	assert.equal(place.rise, -2000);
	// Before the header reaches the pane's bottom, under the header: below the pane.
	assert.equal(barAt(place, 0), 1000);
	assert.equal(barAt(place, place.from - 50), 1000);
	// While the table crosses the pane's bottom: at the pane's bottom, above the inset, at every scroll offset.
	for (const scroll of [place.from, place.from + 1, 1500, 2000, place.to]) assert.equal(barAt(place, scroll), scroll + 700 - 24 - 16);
	// Then under the last row, which scrolls with the note.
	assert.equal(barAt(place, place.to + 300), 3000);
	assert.equal(place.from, 1000 + 16 + 24 - 700);
	assert.equal(place.to, 3000 + 16 + 24 - 700);
	// A table with no body rows: the bar sits under the header and doesn't move.
	const flat = barPlace(1000, 1000, 16, 700, 0);
	assert.equal(flat.rise, 0);
	assert.equal(barAt(flat, 0), 1000);
	assert.equal(barAt(flat, 5000), 1000);
});
