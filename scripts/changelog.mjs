#!/usr/bin/env node
/**
 * The root CHANGELOG.md is the single source; the Home Assistant app shows a copy,
 * `ventilairsec2mqtt/CHANGELOG.md` (a symbolic link would break on some clones and in the
 * Supervisor's build of a local app).
 *
 * `npm run changelog:sync` writes the copy; `node scripts/changelog.mjs --check` exits with 1 when
 * it differs (also checked by `npm test`, test/packaging.test.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
const copy = fileURLToPath(new URL('../ventilairsec2mqtt/CHANGELOG.md', import.meta.url));
const text = readFileSync(source, 'utf8');
let current = '';
try {
  current = readFileSync(copy, 'utf8');
} catch {
  current = '';
}

if (process.argv.includes('--check')) {
  if (current !== text) {
    console.error(
      'ventilairsec2mqtt/CHANGELOG.md differs from CHANGELOG.md: run npm run changelog:sync',
    );
    process.exit(1);
  }
  console.log('ventilairsec2mqtt/CHANGELOG.md is in sync');
} else if (current !== text) {
  writeFileSync(copy, text);
  console.log('ventilairsec2mqtt/CHANGELOG.md updated');
}
