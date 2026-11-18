#!/usr/bin/env node
/**
 * `npm run test:node20`: runs the unit tests on Node 20, the oldest supported version (the one
 * Debian packages for ARMv6 boards). Compiles on the host (`test:compiled` build), then runs the
 * JavaScript tests in a `node:20-alpine` container with the repository mounted.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = process.env.NODE20_IMAGE ?? 'node:20-alpine';

const exec = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

exec(process.execPath, ['scripts/test-compiled.mjs', '--build-only']);
exec('docker', [
  'run',
  '--rm',
  '-v',
  `${root}:/work`,
  '-w',
  '/work',
  image,
  'node',
  'scripts/test-compiled.mjs',
  '--no-build',
]);
