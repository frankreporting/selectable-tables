/** Which of a cell's drawn links Obsidian's link commands act on, and how its menu names them (links.ts). */

/** A link drawn in a cell, as the cell's element has it. */
export interface DrawnLink {
	/** Where it goes: a note's link text, or a web address. */
	href: string;
	/** A link to a note, opened in the vault; else a web address, opened in the browser. */
	internal: boolean;
	/** Inside an embed, such as a picture or an embedded note: not counted, as in Bases. */
	inEmbed: boolean;
}

/** The links a cell's link commands act on: every drawn link but those inside an embed, in the cell's order. */
export function pickLinks(drawn: readonly DrawnLink[]): DrawnLink[] {
	return drawn.filter((link) => !link.inEmbed && link.href !== '');
}

/** A link's title in the menu, its address cut to 100 characters, as in Bases. */
export function menuTitle(href: string): string {
	return href.length > 100 ? `${href.slice(0, 99).trim()}…` : href;
}
