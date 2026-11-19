/**
 * For timing runs only: the time the plugin's own table spends in its own code, by part, while `on`. `tree` is the
 * part of `field` spent getting the syntax tree, which runs Obsidian's parser for the change when the field asks
 * first: that work is the parser's, which it does whether the plugin asks or not.
 */
export const profile = { on: false, field: 0, tree: 0, editor: 0, draw: 0, measure: 0, mount: 0 };

type Part = 'field' | 'tree' | 'editor' | 'draw' | 'measure' | 'mount';

/** Runs `work`, adding its time to `part` while profiling is on. */
export function timed<T>(part: Part, work: () => T): T {
	if (!profile.on) return work();
	const start = performance.now();
	try {
		return work();
	} finally {
		profile[part] += performance.now() - start;
	}
}
