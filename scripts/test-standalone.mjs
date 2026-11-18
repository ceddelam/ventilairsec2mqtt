#!/usr/bin/env node
/**
 * `npm run test:standalone`: tests the standalone release with Docker only.
 *
 * 1. Lints the shell scripts with shellcheck (local binary, else the koalaman/shellcheck-alpine
 *    image).
 * 2. Builds the release archive (`npm run pack`; `--no-pack` reuses release/), plus two copies
 *    with versions 0.1.1-test and 0.1.2-test for the update tests.
 * 3. Runs test/packaging/standalone-install.sh in a debian:trixie-slim container with Debian's
 *    nodejs: install, layout, permissions, update, rollback, uninstall, the program on Node 20.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const debian = process.env.DEBIAN_IMAGE ?? 'debian:trixie-slim';
const shellcheckImage = 'koalaman/shellcheck-alpine:stable';
const scripts = ['packaging/standalone/install.sh', 'test/packaging/standalone-install.sh'];

const exec = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  // Throws (rather than exiting) so that the temporary folder is removed.
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
};
const quiet = (command, args) =>
  spawnSync(command, args, { cwd: root, stdio: 'ignore' }).status === 0;

console.log('== shellcheck');
if (quiet('shellcheck', ['--version'])) {
  exec('shellcheck', scripts);
} else {
  if (!quiet('docker', ['image', 'inspect', shellcheckImage]))
    exec('docker', ['pull', '-q', shellcheckImage]);
  exec('docker', [
    'run',
    '--rm',
    '-v',
    `${root}:/mnt:ro`,
    '-w',
    '/mnt',
    shellcheckImage,
    'shellcheck',
    ...scripts,
  ]);
}

if (!process.argv.includes('--no-pack')) {
  console.log('== npm run pack');
  exec(process.execPath, ['scripts/pack.mjs']);
}

const work = join(root, '.test-tmp', `standalone-${randomBytes(3).toString('hex')}`);
const archives = join(work, 'archives');
mkdirSync(archives, { recursive: true });
try {
  const release = `${name}-${version}`;
  cpSync(join(root, 'release', `${release}.tar.gz`), join(archives, `${release}.tar.gz`));
  for (const testVersion of ['0.1.1-test', '0.1.2-test']) {
    const extract = join(work, `extract-${testVersion}`);
    mkdirSync(extract);
    exec('tar', ['-xzf', join(archives, `${release}.tar.gz`), '-C', extract]);
    const folder = `${name}-${testVersion}`;
    renameSync(join(extract, release), join(extract, folder));
    const packagePath = join(extract, folder, 'package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    writeFileSync(
      packagePath,
      `${JSON.stringify({ ...packageJson, version: testVersion }, null, 2)}\n`,
    );
    const archive = join(archives, `${folder}.tar.gz`);
    exec('tar', ['-czf', archive, '-C', extract, folder]);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${digest}  ${folder}.tar.gz\n`);
  }

  if (!quiet('docker', ['image', 'inspect', debian])) exec('docker', ['pull', '-q', debian]);
  console.log(`== install tests in ${debian}`);
  exec('docker', [
    'run',
    '--rm',
    '-v',
    `${archives}:/archives:ro`,
    '-v',
    `${join(root, 'test/packaging/standalone-install.sh')}:/test.sh:ro`,
    debian,
    'bash',
    '/test.sh',
  ]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
