/** The line class Obsidian's Markdown mode puts on every line of a table. Its Live Preview finds tables by it. */
export const OBSIDIAN_ROW = 'HyperMD-table-row';
/** The line class the copy of Obsidian's language puts there instead, so Obsidian finds no table. */
export const ROW_CLASS = 'selectable-tables-row';

/** The part of a CodeMirror 5 mode the copy changes: its token function. */
export interface TokenParser<State> {
	token(stream: unknown, state: State): string | null;
}

/** HyperMD keeps the table it's in, if any, on its state. */
function inTable(state: unknown): boolean {
	return !!(state as { hmdTable?: number } | null)?.hmdTable;
}

/**
 * Obsidian's Markdown mode with every table row bare: a row's first token carries only the plugin's line class,
 * and its other tokens nothing. So Obsidian's Live Preview finds no table to build, and no link or tag in a row
 * to look up, and its parser no longer reads every table to its end, since the row loses `line-parse-next`. The
 * mode runs as before, so its state, and every line outside a table, are as Obsidian has them.
 */
export function hidingRows<State, Parser extends TokenParser<State>>(parser: Parser): Parser {
	const token = (stream: unknown, state: State) => parser.token(stream, state);
	return {
		...parser,
		token(stream: unknown, state: State) {
			const style = token(stream, state);
			if (style?.includes(`line-${OBSIDIAN_ROW}`)) return `line-${ROW_CLASS}`;
			return inTable(state) ? null : style;
		},
	};
}
