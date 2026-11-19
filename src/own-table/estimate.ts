/**
 * A table's column widths and row heights, worked out from its text with the theme's fonts and sizes, so a table
 * can be laid out before its rows are drawn, and its columns hold their widths as rows come and go. The fonts and
 * sizes are read once per editor (metrics.ts); text is measured by `Measure`, a canvas in Obsidian.
 */

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
	lineHeight: number;
	headLineHeight: number;
	/** The narrowest a column can be. */
	minColumn: number;
	/** The width a table takes before it scrolls sideways. */
	available: number;
	/** The table's box's padding above and below. */
	pad: number;
}

/** A cell's text as it will show: its words, with their widths. */
export interface Words {
	/** Each word's width then the width of a space after it, line by line; NaN ends a line. */
	runs: number[];
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

/** Measures a cell's Markdown, a header cell's in the header's font. */
export function measureCell(text: string, metrics: Metrics, header: boolean, measure: Measure): Words {
	const base = header ? metrics.fonts.head : metrics.fonts.body;
	const runs: number[] = [];
	let embed = PLAYER.test(text);
	let min = 0;
	let max = 0;
	// A comment draws nothing: the freeze mark is one. An escaped pipe shows as a pipe.
	const shown = text.replace(/%%.*?%%/g, '').replace(/\\\|/g, '|');
	for (const line of shown.split(/<br\s*\/?>/i)) {
		let width = 0;
		let words = 0;
		const push = (part: string, font: string, extra: number) => {
			const space = measure(font, ' ');
			const parts = part.split(/ +/).filter(Boolean);
			parts.forEach((word, i) => {
				const w = measure(font, word) + (i === 0 ? extra / 2 : 0) + (i === parts.length - 1 ? extra / 2 : 0);
				if (words) width += runs[runs.length - 1]!;
				runs.push(w, space);
				width += w;
				words++;
				min = Math.max(min, w);
			});
		};
		STYLED.lastIndex = 0;
		let at = 0;
		for (let match = STYLED.exec(line); match; match = STYLED.exec(line)) {
			const before = line.slice(at, match.index) + (match[12] ?? '');
			if (before) push(before.replace(/[*_]/g, ''), base, 0);
			if (match[2] !== undefined) push(match[2], metrics.fonts.code, metrics.extra.code);
			else if (match[3] !== undefined) embed = true;
			else if (match[4] !== undefined) push(match[5] ?? match[4], base, 0);
			else if (match[6] !== undefined) push(match[6], base, /^[a-z][a-z0-9+.-]*:/i.test(match[7] ?? '') ? metrics.extra.link : 0);
			else if (match[8] !== undefined || match[9] !== undefined) push(match[8] ?? match[9] ?? '', header ? base : metrics.fonts.bold, 0);
			else if (match[10] !== undefined) push(match[10], base, metrics.extra.mark);
			else if (match[11] !== undefined) push(match[11], base, 0);
			else if (match[13] !== undefined) push(match[13], metrics.fonts.tag, metrics.extra.tag);
			at = match.index + match[0].length;
		}
		if (at < line.length) push(line.slice(at).replace(/[*_]/g, ''), base, 0);
		max = Math.max(max, width);
		runs.push(NaN);
	}
	if (embed) {
		min = Math.max(min, EMBED_WIDTH);
		max = Math.max(max, EMBED_WIDTH);
	}
	return { runs, embed, min, max };
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
	const { runs } = words;
	for (let i = 0; i < runs.length; i += 2) {
		const w = runs[i]!;
		if (Number.isNaN(w)) {
			lines += wrapped;
			used = 0;
			wrapped = 1;
			i--;
			continue;
		}
		if (used && used + space + w > width + 0.5) {
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
 * how much more each column wants. Whole pixels, so they don't move between renders.
 */
export function fitColumns(mins: readonly number[], maxs: readonly number[], metrics: Metrics): number[] {
	const count = mins.length;
	const least = mins.map((min, c) => Math.max(metrics.minColumn, min + sideOf(c, count, metrics)));
	const most = maxs.map((max, c) => Math.max(least[c]!, max + sideOf(c, count, metrics)));
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	const sumLeast = sum(least);
	const sumMost = sum(most);
	const room = metrics.available - metrics.border;
	let widths: number[];
	if (sumMost <= room) widths = most;
	else if (sumLeast >= room) widths = least;
	else widths = least.map((w, c) => w + ((room - sumLeast) * (most[c]! - w)) / Math.max(1, sumMost - sumLeast));
	return widths.map((w) => Math.ceil(w));
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
