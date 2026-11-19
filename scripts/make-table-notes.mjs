// Writes the test vault's two notes for the plugin's own table, as STA-20 and STA-57's spikes wrote theirs, so their
// timing figures compare: "Table 50 by 8", which git keeps, and "Table 2000 by 12", about 860 KB, which git
// ignores and `npm run test-vault` writes when it's missing. Invented text only. The first column counts the rows.
//   node scripts/make-table-notes.mjs [vault folder]          both notes
//   node scripts/make-table-notes.mjs --if-missing [folder]   only the large one, and only when it isn't there
import { existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const vault = args.find((arg) => !arg.startsWith('--')) ?? 'test-vault/Selectable Tables Test';
const words = ['river', 'lantern', 'meadow', 'copper', 'harbor', 'thistle', 'orchard', 'pebble', 'willow', 'canvas'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const long = (n) => [0, 3, 7].map((k) => cap(words[(n + k) % words.length])).join('');
const sentence = (n) => {
	const picked = Array.from({ length: 8 }, (_, i) => words[(n * 7 + i * 3) % words.length]);
	return `Line ${n}: the ${picked.slice(0, 4).join(' ')} and the ${picked.slice(4).join(' ')}.`;
};
// A long unbroken word keeps each column wide, so the table scrolls sideways. Markdown in every cell.
function cell(row, col) {
	const w = long(row * 3 + col);
	switch (col % 6) {
		case 0: return `**${w}**`;
		case 1: return `[[Table 50 by 8]] ${w}`;
		case 2: return `\`${w}\``;
		case 3: return `#tag-${words[(row + col) % words.length]} ${w}`;
		case 4: return `[${w}](https://example.com/${words[row % words.length]})`;
		default: return `==${w}==`;
	}
}
// Padded the way Obsidian's table editor pads a table, so a click in a cell leaves the note as it is.
function table(rows, cols) {
	const data = [Array.from({ length: cols }, (_, c) => (c === 0 ? 'Name' : `Column ${c} ${long(c)}`))];
	for (let r = 1; r < rows; r++) data.push(Array.from({ length: cols }, (_, c) => (c === 0 ? `Row ${r}` : cell(r, c))));
	const widths = data[0].map((_, c) => Math.max(3, ...data.map((row) => row[c].length)));
	const line = (cells) => `| ${cells.map((v, c) => v.padEnd(widths[c])).join(' | ')} |`;
	return [line(data[0]), line(widths.map((w) => '-'.repeat(w))), ...data.slice(1).map(line)];
}
const note = (name, rows, cols, first) => {
	let n = first;
	const text = (count) => Array.from({ length: count }, () => sentence(n++));
	writeFileSync(`${vault}/${name}.md`, [`# ${name}`, '', ...text(40), '', ...table(rows, cols), '', ...text(40)].join('\n') + '\n');
};

const big = `${vault}/Table 2000 by 12.md`;
if (!args.includes('--if-missing') || !existsSync(big)) note('Table 2000 by 12', 2000, 12, 81);
if (!args.includes('--if-missing')) note('Table 50 by 8', 50, 8, 1);
