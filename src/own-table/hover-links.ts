import type { EditorView } from '@codemirror/view';
import { type App, editorInfoField } from 'obsidian';

/**
 * Hovering a link in the plugin's table (BMT-143). The note's editor hands every `mouseover` on an `a.internal-link` in its
 * content to Reading view's link handling (`registerDomEvents` on the content, with `Dv`), which tells Page preview the link
 * is Reading view's, whose previews need no key held. Obsidian's own table draws its cells' links there too, so they act as
 * Reading view's. A link in the note's text is the editor's, and its preview needs Cmd, or what Page preview's *Editing
 * view* switch says. This listener, on each block, keeps a hover on one of the table's links from reaching Reading view's
 * handling, and tells Page preview the link is the editor's, as the note's text does. Pinned rows and frozen columns are
 * inside the block, so it hears their links too. Page preview off in Core plugins hears nothing, so nothing shows.
 *
 * An open cell's editor and an embedded note answer for their own links, as before.
 */
export function hoverLinksAsEditor(dom: HTMLElement, app: App, viewOf: () => EditorView | null): void {
	dom.addEventListener('mouseover', (event) => {
		const link = (event.target as Element).closest('a.internal-link');
		if (!link?.instanceOf(HTMLElement) || !dom.contains(link)) return;
		const owner = link.parentElement?.closest('.cm-editor, .markdown-preview-view');
		if (owner && dom.contains(owner)) return;
		event.stopPropagation();
		// Once, as the pointer comes onto the link, as the editor tells of its own.
		const from = event.relatedTarget as Node | null;
		if (from && link.contains(from)) return;
		const info = viewOf()?.state.field(editorInfoField, false);
		const linktext = link.getAttribute('data-href') ?? link.getAttribute('href');
		if (!info || !linktext) return;
		app.workspace.trigger('hover-link', { event, source: 'editor', hoverParent: info, targetEl: link, linktext, sourcePath: info.file?.path ?? '' });
	});
}
