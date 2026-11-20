/**
 * A table's column widths and row heights, worked out from its text with the theme's fonts and sizes, so a table
 * can be laid out before its rows are drawn, and its columns hold their widths as rows come and go. The fonts and
 * sizes are read once per editor (metrics.ts); text is measured by `Measure`, a canvas in Obsidian.
 */

import { hasMark } from '../editor/freeze-mark';

/** The width of some text in a CSS font. */
export type Measure = (font: string, text: string) => number;

export interface Metrics {
	fonts: { body: string; head: string; code: string; tag: string; bold: string };
	/** Room a styled span takes beside its text: code's, a tag's and a highlight's padding and borders, a link's icon. */
	extra: { code: number; tag: number; link: number; mark: number };
	/** Room a cell takes beside its text, by where its column sits: its padding, and half its side borders. */
	side: { first: number; middle: number; last: number; only: number };
	/** Padding above and below a cell's text. */
	padY: number;
	/** A border's width. */
	border: number;
	/** The table's own borders, at its start and end, which a theme may draw beside its cells'. */
	tableBorder: number;
	/** Joined, the halves of the table's outer borders that lie outside its columns. */
	outer: number;
	/** Drawn by its cells, the room the first column's borders take beyond what they take joined: half of each. */
	firstExtra: number;
	lineHeight: number;
	headLineHeight: number;
	/** The narrowest a column can be. */
	minColumn: number;
	/** The width a table takes before it scrolls sideways. */
	available: number;
	/** The table's box's padding above and below. */
	pad: number;
	/** The table's box's padding above alone. */
	padTop: number;
	/** The theme collapses the table's borders. */
	collapsed: boolean;
	/** The space a theme that keeps borders apart puts between cells, and around them. */
	spacing: number;
	/** The theme keeps every space in a cell (`break-spaces`), so spaces take room and lines break only after them. */
	keepSpaces: boolean;
	/** The theme makes every table as wide as the room it has, as Typewriter and Baseline do. */
	stretch: boolean;
	/** Obsidian runs in WebKit, on an iPhone or iPad, which shares a table's room by its own rule. */
	webkit: boolean;
}

/** A cell's text as it will show: its words, with their widths. */
export interface Words {
	/** Each word's width then the width of the spaces after it, line by line; NaN ends a line. */
	runs: number[];
	/** Its spaces take room at a line's end, so a word that isn't last on its line needs its spaces' room too. */
	keep: boolean;
	/** It holds something that takes room only once loaded, such as a picture. */
	embed: boolean;
	/** Its widest word, and its widest line kept on one line. */
	min: number;
	max: number;
}

/** Markdown that changes how a cell's text measures: code, embeds, links, bold, highlights, strikethrough, tags. */
const STYLED = /(`+)(.+?)\1|!\[\[([^\]]+)\]\]|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]*)\]\(([^)]*)\)|\*\*(.+?)\*\*|__(.+?)__|==(.+?)==|~~(.+?)~~|(^|\s)(#[^\s#]+)/g;
/** HTML that draws something with a size of its own. */
const PLAYER = /<(audio|video|img|iframe)\b/i;

/**
 * Measures a cell's Markdown, a header cell's in the header's font. A word runs on across styled spans until a
 * space: `**bold**,` is one word. Where the theme keeps every space (`break-spaces`, as the default theme does), each
 * space takes room and a line breaks only after its spaces, so a word not last on its line takes its spaces with it,
 * which is what sets a column's narrowest width there. A header cell holding a freeze mark drops its spaces
 * (styles.css), as a theme with `normal` does for every cell: a run of spaces is one, and none ends a line.
 */
export function measureCell(text: string, metrics: Metrics, header: boolean, measure: Measure): Words {
	const base = header ? metrics.fonts.head : metrics.fonts.body;
	const keep = metrics.keepSpaces && !(header && hasMark(text));
	const runs: number[] = [];
	let embed = PLAYER.test(text);
	let min = 0;
	let max = 0;
	// A comment draws nothing: the freeze mark is one. An escaped pipe shows as a pipe.
	const shown = text.replace(/%%.*?%%/g, '').replace(/\\\|/g, '|');
	for (const line of shown.split(/<br\s*\/?>/i)) {
		const words: number[] = [];
		const gaps: number[] = [];
		/** The word being built, or -1 before the line's first word. */
		let word = -1;
		/** The room the spaces since the word being built take, waiting for the next word. */
		let gap = 0;
		let spaced = false;
		/** Adds text in one font, with room at its start and end, such as a styled span's padding. */
		const add = (part: string, font: string, start = 0, end = 0) => {
			let lead = start;
			for (const token of part.split(/( +)/)) {
				if (!token) continue;
				if (token.startsWith(' ')) {
					if (word < 0) continue;
					const space = measure(font, ' ');
					gap += keep ? space * token.length : spaced ? 0 : space;
					spaced = true;
					continue;
				}
				if (spaced) {
					words.push(word);
					gaps.push(gap);
					word = 0;
					gap = 0;
					spaced = false;
				}
				word = Math.max(0, word) + lead + measure(font, token);
				lead = 0;
			}
			if (word >= 0 && !spaced) word += lead + end;
		};
		STYLED.lastIndex = 0;
		let at = 0;
		for (let match = STYLED.exec(line); match; match = STYLED.exec(line)) {
			const before = line.slice(at, match.index) + (match[12] ?? '');
			if (before) add(before.replace(/[*_]/g, ''), base);
			const half = (extra: number) => [extra / 2, extra / 2] as const;
			if (match[2] !== undefined) add(match[2], metrics.fonts.code, ...half(metrics.extra.code));
			else if (match[3] !== undefined) embed = true;
			else if (match[4] !== undefined) add(match[5] ?? match[4], base);
			else if (match[6] !== undefined) add(match[6], base, 0, /^[a-z][a-z0-9+.-]*:/i.test(match[7] ?? '') ? metrics.extra.link : 0);
			else if (match[8] !== undefined || match[9] !== undefined) add(match[8] ?? match[9] ?? '', header ? base : metrics.fonts.bold);
			else if (match[10] !== undefined) add(match[10], base, ...half(metrics.extra.mark));
			else if (match[11] !== undefined) add(match[11], base);
			else if (match[13] !== undefined) add(match[13], metrics.fonts.tag, ...half(metrics.extra.tag));
			at = match.index + match[0].length;
		}
		if (at < line.length) add(line.slice(at).replace(/[*_]/g, ''), base);
		if (word >= 0) {
			words.push(word);
			gaps.push(gap);
		}
		let width = 0;
		words.forEach((w, i) => {
			const last = i === words.length - 1;
			width += w + (last ? 0 : gaps[i]!);
			min = Math.max(min, w + (keep && !last ? gaps[i]! : 0));
			runs.push(w, gaps[i]!);
		});
		max = Math.max(max, width);
		runs.push(NaN);
	}
	if (embed) {
		min = Math.max(min, EMBED_WIDTH);
		max = Math.max(max, EMBED_WIDTH);
	}
	return { runs, keep, embed, min, max };
}

/** Room taken by something that loads later, until it does. */
const EMBED_WIDTH = 40;
/** Lines added for something that loads later. */
const EMBED_LINES = 2;

/** How many lines a cell's text takes at a width, wrapping at spaces. */
export function linesAt(words: Words, width: number): number {
	let lines = 0;
	let used = 0;
	let wrapped = 1;
	let space = 0;
	const { runs, keep } = words;
	for (let i = 0; i < runs.length; i += 2) {
		const w = runs[i]!;
		if (Number.isNaN(w)) {
			lines += wrapped;
			used = 0;
			wrapped = 1;
			i--;
			continue;
		}
		// Where spaces take room, a word that isn't last on its line breaks only after its spaces.
		const need = w + (keep && !Number.isNaN(runs[i + 2]!) ? runs[i + 1]! : 0);
		if (used && used + space + need > width + 0.5) {
			wrapped++;
			used = w;
		} else used += (used ? space : 0) + w;
		space = runs[i + 1]!;
	}
	return Math.max(1, lines) + (words.embed ? EMBED_LINES : 0);
}

/** The room a column's cells take beside their text. */
export function sideOf(column: number, columns: number, metrics: Metrics): number {
	const { side } = metrics;
	if (columns === 1) return side.only;
	if (column === 0) return side.first;
	return column === columns - 1 ? side.last : side.middle;
}

/**
 * Column widths for a table, much as a browser lays out a table on its own: every column as wide as its longest
 * line when that fits, as narrow as its widest word when even that doesn't, and in between the room shared out by
 * how much more each column wants. To a 64th of a pixel, as a browser lays out a table: whole pixels moved
 * the lines after each column, by up to a pixel a column.
 */
export function fitColumns(mins: readonly number[], maxs: readonly number[], metrics: Metrics): number[] {
	const count = mins.length;
	const least = mins.map((min, c) => Math.max(metrics.minColumn, min + sideOf(c, count, metrics)));
	const most = maxs.map((max, c) => Math.max(least[c]!, max + sideOf(c, count, metrics)));
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	const sumLeast = sum(least);
	const sumMost = sum(most);
	// Joined, a table's outer borders lie half outside its columns; apart, its own borders and the space between cells do.
	const room = metrics.available - (metrics.collapsed ? metrics.outer : metrics.tableBorder + metrics.spacing * (count + 1));
	let widths: number[];
	// A table the theme stretches shares the room left over by how much each column wants, as a browser does.
	if (sumMost <= room) widths = metrics.stretch ? most.map((w) => w + ((room - sumMost) * w) / Math.max(1, sumMost)) : most;
	else if (sumLeast >= room) widths = least;
	else if (metrics.webkit) widths = shareAsWebKit(least, most, room);
	else widths = least.map((w, c) => w + ((room - sumLeast) * (most[c]! - w)) / Math.max(1, sumMost - sumLeast));
	return widths.map((w) => Math.ceil(w * 64) / 64);
}

/**
 * WebKit's share of a table's room, between its columns' narrowest and widest (AutoTableLayout): column by column,
 * each its part of the room left by how wide it wants to be, but no narrower than it can be; then what that gave
 * beyond the room is taken back from the last columns first, by how far each is above its narrowest.
 */
function shareAsWebKit(least: readonly number[], most: readonly number[], room: number): number[] {
	const widths = [...least];
	let left = room;
	let wanted = most.reduce((total, value) => total + value, 0);
	most.forEach((want, c) => {
		const width = Math.max(least[c]!, wanted > 0 ? (left * want) / wanted : 0);
		left -= width;
		wanted -= want;
		widths[c] = width;
	});
	let beyond = widths.reduce((total, width, c) => total + width - least[c]!, 0);
	for (let c = widths.length - 1; c >= 0 && left < 0; c--) {
		const above = widths[c]! - least[c]!;
		if (above <= 0 || beyond <= 0) continue;
		const back = (left * above) / beyond;
		widths[c]! += back;
		left -= back;
		beyond -= above;
	}
	return widths;
}

/** A row's height, from its cells at the columns' widths. */
export function rowHeight(cells: readonly Words[], widths: readonly number[], metrics: Metrics, header: boolean): number {
	const lineHeight = header ? metrics.headLineHeight : metrics.lineHeight;
	let lines = 1;
	cells.forEach((words, c) => {
		lines = Math.max(lines, linesAt(words, (widths[c] ?? 0) - sideOf(c, widths.length, metrics)));
	});
	return lines * lineHeight + metrics.padY + metrics.border;
}
