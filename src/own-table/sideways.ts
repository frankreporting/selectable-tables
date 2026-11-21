/**
 * The sums for moving a wide table sideways on a computer, where no box scrolls it: a scrollbar of the plugin's own
 * holds how far the table is moved, and the table follows it by a transform (styles.css). A box that scrolled the
 * table sideways would stop its rows sticking to the note (STA-75). Phones and tablets keep a box, scrolled by a
 * finger, which sends no wheel events to pass on.
 */

/** How far a wheel event moves, in pixels, sideways and up or down. */
export interface WheelStep {
	dx: number;
	dy: number;
}

/** The parts of a wheel event the plugin reads. */
export interface WheelLike {
	deltaX: number;
	deltaY: number;
	deltaMode: number;
	shiftKey: boolean;
	ctrlKey: boolean;
}

/** A line of a wheel that moves by lines, and a page of one that moves by pages, in pixels. */
const LINE = 16;

/**
 * How far a wheel event moves the table and the note, or null for a zoom: Ctrl with the wheel, and a pinch on a
 * trackpad, which arrives as one, zoom as Obsidian has them. Shift with a mouse wheel moves sideways, as it scrolls
 * a box: on a Mac the system already sends it sideways, and elsewhere it comes up or down, with Shift held.
 */
export function wheelStep(event: WheelLike, page: number): WheelStep | null {
	if (event.ctrlKey) return null;
	const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? page : 1;
	let dx = event.deltaX * unit;
	let dy = event.deltaY * unit;
	if (event.shiftKey && !dx) {
		dx = dy;
		dy = 0;
	}
	return { dx, dy };
}

/**
 * The longest pause inside one swipe, in ms. A trackpad sends an event a frame, and its momentum carries on with no
 * pause worth the name; a mouse wheel's clicks come further apart, each a swipe of its own.
 */
export const GESTURE_GAP = 80;

/** What a swipe does over a table, decided by its first step, as the browser keeps a swipe to the box it began in. */
export type Hold = 'sideways' | 'note';

/**
 * Keeps each swipe to its direction, as Obsidian's table does in its box: a mostly sideways swipe over a wide table
 * moves only the table, and anything else only the note. The browser keeps a swipe to the box it began in, and
 * drops the part it can't scroll there: so a sideways swipe doesn't move the note up or down, and a vertical
 * scroll doesn't move the table sideways. With no box, the plugin does the same: it takes the sideways part of a
 * sideways swipe, and stops the browser scrolling the note for it.
 */
export class Swipes {
	private last = -Infinity;
	private hold: Hold | null = null;
	private target: unknown = null;

	/**
	 * The hold for a wheel event at `time`, over `table` (null for none, or a table no wider than its box). A new swipe
	 * starts after a pause, or when the browser starts one, which it marks by letting its first event be cancelled:
	 * after that, the events of a swipe it scrolls can't be. A swipe the plugin holds sideways keeps every event
	 * cancellable, so only a pause ends it. A step with no movement decides nothing.
	 */
	next(time: number, step: WheelStep, table: unknown, cancelable: boolean): { hold: Hold; table: unknown } | null {
		const fresh = time - this.last > GESTURE_GAP || (cancelable && this.hold === 'note');
		this.last = time;
		if (fresh || this.hold === null) {
			if (!step.dx && !step.dy) {
				this.hold = null;
				return null;
			}
			this.hold = table && Math.abs(step.dx) > Math.abs(step.dy) ? 'sideways' : 'note';
			this.target = table;
		}
		return { hold: this.hold, table: this.target };
	}
}

/**
 * How far a table can move sideways in its box: its width and the box's padding, less the room inside the box, in
 * whole pixels, as Obsidian's box rounds its scroll range. A table moved by whole pixels also keeps its lines sharp.
 */
export function maxSlide(tableWidth: number, padStart: number, padEnd: number, boxWidth: number): number {
	return Math.max(0, Math.round(padStart + tableWidth + padEnd - boxWidth));
}

/** A scroll offset kept within its range: 0 to `max`, or `-max` to 0 for a table that runs right to left. */
export function clampSlide(scroll: number, max: number, rtl: boolean): number {
	return rtl ? Math.min(0, Math.max(-max, scroll)) : Math.max(0, Math.min(max, scroll));
}

/** Left and right, on the screen. */
export interface Across {
	left: number;
	right: number;
}

/**
 * How far to move a table so `span` shows inside `box`, as `scrollIntoView` does with `nearest`: not at all for a span
 * in view, to its nearer edge for one that's out, and to its start for one wider than the room. `clear` is room at
 * the box's start that hides what passes under it, a frozen column say: the left in a table that runs left to right,
 * the right in one that runs right to left. Positive moves the table's content leftward, as a scroll offset grows.
 */
export function revealDelta(box: Across, span: Across, clear: number, rtl: boolean): number {
	const lo = rtl ? box.left : box.left + clear;
	const hi = rtl ? box.right - clear : box.right;
	if (span.right - span.left > hi - lo) return rtl ? span.right - hi : span.left - lo;
	if (span.left < lo) return span.left - lo;
	if (span.right > hi) return span.right - hi;
	return 0;
}

/** The scrollbar's place, in the note's scrolling content, and the range over which it follows the note's scroll. */
export interface BarPlace {
	/** Where the bar's top sits at the table's end: under its last row. */
	top: number;
	/** The note's scroll offsets between which the bar rides at the pane's bottom. */
	from: number;
	to: number;
	/** How far above `top` the bar sits before `from`: under the header. Never positive. */
	rise: number;
}

/**
 * Where the scrollbar goes: under the table's last row (`end`, in the note's content), carried up to the pane's bottom
 * while the table crosses it (`pane` tall, `inset` of it hidden, by the status bar say), and no higher than under the
 * header (`start`), so it shows only once the table's first rows are in the pane. In between, it moves up with the
 * note's scroll, one for one, which the browser does on the compositor from these sums alone.
 */
export function barPlace(start: number, end: number, height: number, pane: number, inset: number): BarPlace {
	const top = Math.max(start, end);
	const lift = height + inset - pane;
	return { top, from: start + lift, to: top + lift, rise: Math.min(0, start - top) };
}

/** Where the bar sits, in the note's content, at the note's scroll offset `scroll`, as the browser draws it. */
export function barAt(place: BarPlace, scroll: number): number {
	if (scroll <= place.from) return place.top + place.rise;
	if (scroll >= place.to) return place.top;
	return place.top + place.rise + (scroll - place.from);
}
