/** Obsidian's DOM helpers, which it puts on every window it opens, typed by the global ones it declares. */
export interface DomHelpers {
	createEl: typeof createEl;
	createDiv: typeof createDiv;
	createSpan: typeof createSpan;
}

/**
 * The DOM helpers of the window a node or a document belongs to, so an element is made in that window's document, a
 * pop-out's included, or the main window's for a document with no window. Obsidian's own `win` would give the main window
 * for any document itself, since a document has no owner. obsidian.d.ts doesn't declare the helpers on a window, so
 * they're typed here.
 */
export function domOf(node: Node): DomHelpers {
	const doc = node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : node.ownerDocument;
	return (doc?.defaultView ?? activeWindow) as unknown as DomHelpers;
}

/**
 * An empty `div` made in `doc`, a document of the plugin's own with no window, as the table renders in: made in its
 * body, then taken out, so it belongs to that document without being in it.
 */
export function looseDiv(doc: Document): HTMLDivElement {
	const div = doc.body.createDiv();
	div.detach();
	return div;
}
