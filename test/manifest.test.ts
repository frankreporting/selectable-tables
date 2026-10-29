import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface Manifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	isDesktopOnly: boolean;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson('manifest.json') as Manifest;
const pkg = readJson('package.json') as { version: string };
const versions = readJson('versions.json') as Record<string, string>;
const semver = /^\d+\.\d+\.\d+$/;

test('the plugin id never changes once released', () => {
	assert.equal(manifest.id, 'selectable-tables');
});

test('versions agree across manifest.json, package.json and versions.json', () => {
	assert.match(manifest.version, semver);
	assert.match(manifest.minAppVersion, semver);
	assert.equal(pkg.version, manifest.version);
	assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test('the description follows the community plugin rules', () => {
	assert.ok(manifest.description.endsWith('.'));
	assert.ok(manifest.description.length <= 250);
	assert.doesNotMatch(manifest.description, /obsidian|this plugin/i);
});
