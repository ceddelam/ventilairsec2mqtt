#!/usr/bin/env node
/**
 * `npm run test:compiled`: compiles src/ and test/ to `.test-build/` (git-ignored) and runs the
 * unit tests on the JavaScript output, for Node versions without TypeScript type stripping
 * (Node 20). `--no-build` runs an existing build (used by `npm run test:node20`, which builds on
 * the host with `--build-only` and runs the tests in a node:20 container).
 *
 * The build gets a copy of package.json (ES module type, version read by the app) and a link to
 * fixtures/, so paths relative to the sources resolve as in the repository.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '.test-build');

const exec = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!process.argv.includes('--no-build')) {
  rmSync(out, { recursive: true, force: true });
  exec(process.execPath, [
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    'tsconfig.test.json',
  ]);
  copyFileSync(join(root, 'package.json'), join(out, 'package.json'));
  symlinkSync('../fixtures', join(out, 'fixtures'));
  if (process.argv.includes('--build-only')) process.exit(0);
}

const tests = readdirSync(join(out, 'test'), { recursive: true })
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => join(out, 'test', file));
console.log(`Node ${process.version}: ${tests.length} test files from ${out}`);
exec(process.execPath, ['--test', ...tests]);
