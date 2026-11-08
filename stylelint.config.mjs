// Obsidian's own CSS rules, which the community directory's scan applies to styles.css: its
// warnings, such as :has() and !important, are what the scan reports. The config builds on
// stylelint-config-standard, whose formatting rules the scan doesn't report, so the ones our
// CSS trips are off here. Any other finding fails `npm run lint`.
export default {
	extends: ['stylelint-config-obsidianmd'],
	rules: {
		// .cm-lineWrapping and .cm-cursorLayer are CodeMirror's classes, not ours.
		'selector-class-pattern': null,
		// Rules are ordered by what they style, not by specificity; reordering would change the cascade.
		'no-descending-specificity': null,
		// @property's initial-value keeps its unit, to match its <length> syntax.
		'length-zero-no-unit': null,
		// top, inset-inline-end, bottom, inset-inline-start read as the four sides of one box.
		'declaration-block-no-redundant-longhand-properties': null,
	},
};
