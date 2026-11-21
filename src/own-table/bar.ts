import type { EditorView } from '@codemirror/view';
import type { BarPlace } from './sideways';

/**
 * A wide table's scrollbar, on a computer: the plugin's own, in the note's scroller, as wide as the table's box. Its
 * scroll is how far the table is moved sideways, and the table's blocks follow it by a transform, on the compositor
 * (styles.css), so no box between the table and the note scrolls sideways. On a Mac it's the system's own bar, which
 * follows System Settings › Show scroll bars, as the note's does; elsewhere Obsidian styles it as every scrollbar.
 * It sits in the scroller, not beside it, so scrolling up and down with the pointer over it scrolls the note.
 */

/** On the scrollbar. */
export const BAR_CLASS = 'selectable-tables-bar';
/** On the editor while its wide tables move by a scrollbar, not in a box that scrolls: styles.css has the boxes clip. */
export const BARS_CLASS = 'selectable-tables-bars';
/** On a block whose table follows its scrollbar. */
export const SLIDES_CLASS = 'selectable-tables-slides';
/** On a block: the name of its table's scrollbar's timeline, and how far the table moves at the bar's end. */
export const TIMELINE_VARIABLE = '--selectable-tables-x';
export const SLIDE_VARIABLE = '--selectable-tables-slide';

/** For timing runs, which compare against the box that scrolled the table before: tables scroll in their box again. */
let boxed = false;
export function useBoxes(on: boolean): void {
	boxed = on;
}

/** Whether the browser runs scroll-driven animations, read once. */
let scrollDriven: boolean | undefined;

/**
 * Whether an editor's wide tables move by a scrollbar. Phones and tablets keep a box, scrolled by a finger, which
 * sends no wheel events the plugin could pass on; so do browsers without scroll-driven animations, the check
 * `canFreeze` makes.
 */
export function usesBars(view: EditorView): boolean {
	scrollDriven ??= CSS.supports('animation-timeline', 'scroll()');
	return !boxed && scrollDriven && !view.dom.ownerDocument.body.classList.contains('is-mobile');
}

/** The timelines each scroller names for the tables in it, so a block can follow its table's bar from anywhere inside. */
const scopes = new WeakMap<HTMLElement, Set<string>>();

function rescope(scroller: HTMLElement, names: Set<string>): void {
	if (names.size) scroller.style.setProperty('timeline-scope', [...names].join(', '));
	else scroller.style.removeProperty('timeline-scope');
}

const px = (value: number) => `${Math.round(value * 64) / 64}px`;

/** One table's scrollbar, kept as long as the table is wide, wherever the table scrolls in the note. */
export class Bar {
	readonly dom: HTMLDivElement;
	private readonly fill: HTMLDivElement;
	private readonly scroller: HTMLElement;
	private written = '';

	constructor(
		view: EditorView,
		readonly name: string,
		onScroll: () => void,
	) {
		this.scroller = view.scrollDOM;
		this.dom = this.scroller.createDiv(BAR_CLASS);
		// Not a tab stop, which Chromium makes a scroller with nothing focusable in it, and not read: the keys and
		// screen readers reach the table itself.
		this.dom.tabIndex = -1;
		this.dom.setAttribute('aria-hidden', 'true');
		this.dom.style.setProperty('scroll-timeline', `${name} inline`);
		this.fill = this.dom.createDiv();
		this.dom.addEventListener('scroll', onScroll, { passive: true });
		const names = scopes.get(this.scroller) ?? new Set<string>();
		names.add(name);
		scopes.set(this.scroller, names);
		rescope(this.scroller, names);
	}

	/** How far the table is moved: 0 at its start, negative for a table that runs right to left. */
	get scroll(): number {
		return this.dom.scrollLeft;
	}

	set scroll(value: number) {
		if (Math.abs(this.dom.scrollLeft - value) > 0.01) this.dom.scrollLeft = value;
	}

	/**
	 * Puts the bar where `place` says, in the note's content, `left` from the scroller's edge and `width` wide, `height`
	 * tall, for a table that moves `slide` px, the way `dir` runs. Written only when something changed by a 64th of a
	 * pixel: each write sends the bar's animation to the compositor anew.
	 */
	place(place: BarPlace, left: number, width: number, height: number, slide: number, dir: string): void {
		const key = [place.top, place.from, place.to, place.rise, left, width, height, slide].map(px).join(' ') + dir;
		if (key === this.written) return;
		this.written = key;
		const style = this.dom.style;
		style.top = px(place.top);
		style.left = px(left);
		style.width = px(width);
		style.height = px(height);
		style.setProperty('--selectable-tables-bar-from', px(place.from));
		style.setProperty('--selectable-tables-bar-to', px(place.to));
		style.setProperty('--selectable-tables-bar-rise', px(place.rise));
		this.fill.style.width = px(width + slide);
		if ((this.dom.getAttribute('dir') ?? '') !== dir) this.dom.setAttr('dir', dir || null);
	}

	destroy(): void {
		this.dom.remove();
		const names = scopes.get(this.scroller);
		if (!names) return;
		names.delete(this.name);
		rescope(this.scroller, names);
	}
}
