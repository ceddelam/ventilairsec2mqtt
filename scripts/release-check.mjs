#!/usr/bin/env node
/**
 * `node scripts/release-check.mjs <tag> [--notes <file>]`: checks that a release tag (`v1.2.3`)
 * matches the version in package.json and in the app's config.yaml, and that CHANGELOG.md has a
 * `## [1.2.3]` section. With `--notes`, writes that section to the file (GitHub release notes).
 * Exits non-zero with every problem listed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const tag = args[0];
const notesIndex = args.indexOf('--notes');
const notesFile = notesIndex === -1 ? undefined : args[notesIndex + 1];

const problems = [];
const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? '');
if (!match) {
  console.error(
    `Usage: release-check.mjs v<major>.<minor>.<patch> [--notes <file>] (got "${tag ?? ''}")`,
  );
  process.exit(2);
}
const version = match[1];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) problems.push(`package.json version is ${pkg.version}`);

const config = readFileSync(join(root, 'ventilairsec2mqtt', 'config.yaml'), 'utf8');
const configVersion = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(config)?.[1];
if (configVersion !== version)
  problems.push(`ventilairsec2mqtt/config.yaml version is ${configVersion}`);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\].*$`, 'm');
const start = changelog.search(heading);
let notes = '';
if (start === -1) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section`);
} else {
  const body = changelog.slice(start).split('\n').slice(1);
  const end = body.findIndex((line) => /^## \[/.test(line));
  notes = (end === -1 ? body : body.slice(0, end)).join('\n').trim();
  if (notes === '') problems.push(`CHANGELOG.md section ${version} is empty`);
}

if (problems.length > 0) {
  console.error(`Release ${tag} is not consistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
if (notesFile !== undefined) writeFileSync(notesFile, `${notes}\n`);
console.log(`Release ${tag}: version ${version} consistent`);
