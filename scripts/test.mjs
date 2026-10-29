// Bundles each test/*.test.ts with esbuild, then runs the bundles with Node's built-in test runner.
import esbuild from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const outdir = '.test-build';
rmSync(outdir, { recursive: true, force: true });

const tests = readdirSync('test').filter((name) => name.endsWith('.test.ts'));
await esbuild.build({
	entryPoints: tests.map((name) => `test/${name}`),
	outdir,
	outExtension: { '.js': '.mjs' },
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	sourcemap: 'inline',
	// CodeMirror resolves from node_modules, as Obsidian provides it at run time. Nothing tested may
	// import 'obsidian' as a value: the package holds only type definitions.
	external: ['@codemirror/*', '@lezer/*', 'obsidian'],
	logLevel: 'warning',
});

const files = tests.map((name) => `${outdir}/${name.replace(/\.ts$/, '.mjs')}`);
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
