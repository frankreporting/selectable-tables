// Writes the test vault's "Frozen tables": invented tables wide enough to scroll sideways and tall enough
// to pass the pane, with a heading over each. Long unbroken words keep the columns wide.
import { writeFileSync } from 'node:fs';

const words = ['fern', 'moss', 'thistle', 'willow', 'orchard', 'pebble', 'meadow', 'clover', 'bramble', 'sorrel'];
const cap = (word) => word[0].toUpperCase() + word.slice(1);
const long = (n) => [0, 3, 7].map((k) => cap(words[(n + k) % words.length])).join('');
const sentence = (n) => {
	const picked = Array.from({ length: 8 }, (_, i) => words[(n * 7 + i * 3) % words.length]);
	return `Line ${n}: the ${picked.slice(0, 4).join(' ')} and the ${picked.slice(4).join(' ')}.`;
};

/** Markdown in some cells, as in real tables. */
function cell(row, column) {
	const text = long(row * 3 + column);
	switch (column % 4) {
		case 1: return `**${text}**`;
		case 2: return `\`${text}\``;
		case 3: return `[[Watering schedule]] ${text}`;
		default: return text;
	}
}

/** Padded the way Obsidian's table editor pads a table, so Enter opens its cells. */
function table(name, names, mark, seed) {
	const rows = [names.map((column, index) => (index === 0 && mark ? `${mark} ${column}` : column))];
	for (let row = 1; row < 40; row++) rows.push(names.map((_, column) => (column === 0 ? `${name} ${row}` : cell(row + seed, column))));
	const widths = names.map((_, column) => Math.max(3, ...rows.map((row) => row[column].length)));
	const line = (cells) => `| ${cells.map((text, column) => text.padEnd(widths[column])).join(' | ')} |`;
	return [line(rows[0]), line(widths.map((width) => '-'.repeat(width))), ...rows.slice(1).map(line)];
}

const columns = ['Name', 'Bed', 'Sown', 'Water', 'Light', 'Soil', 'Harvest', 'Notes'];
let n = 1;
const text = (count) => Array.from({ length: count }, () => sentence(n++));
const lines = [
	'# Frozen tables',
	'',
	'Invented tables for frozen rows and columns.',
	'',
	...text(24),
	'',
	'## Plants',
	'',
	...table('Plant', columns, '%%freeze 2 1%%', 0),
	'',
	...text(14),
	'',
	'## Tools',
	'',
	...table('Tool', columns, '%%freeze 1 2%%', 40),
	'',
	...text(14),
	'',
	'## Sheds',
	'',
	...table('Shed', columns, '', 80),
	'',
	...text(30),
	'',
];
writeFileSync('test-vault/Selectable Tables Test/Frozen tables.md', lines.join('\n'));
