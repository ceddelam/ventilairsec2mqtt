#!/usr/bin/env node
/**
 * `npm run pack`: builds the standalone release archive
 * `release/ventilairsec2mqtt-<version>.tar.gz` (git-ignored) and its `.sha256` file.
 *
 * The archive holds one folder, `ventilairsec2mqtt-<version>/`: the compiled program (`dist/`),
 * the production dependencies (`node_modules/`, with every prebuilt serialport binding, so the
 * target needs neither npm nor a compiler), `package.json`, `package-lock.json`, `LICENSE`,
 * `README.md`, the systemd unit, `install.sh` and `options.example.json`. It is the same for every
 * platform. Reproducible: sorted entries, root owner, fixed dates (SOURCE_DATE_EPOCH, else the
 * last commit's date).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const base = `${name}-${version}`;
const releaseDir = join(root, 'release');
const staging = join(releaseDir, '.staging');
const stage = join(staging, base);
const archive = join(releaseDir, `${base}.tar.gz`);

const exec = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
  return result;
};

/** Deletes files matching `test` and then empty folders under `dir`. */
const prune = (dir, test) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      prune(path, test);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
    } else if (test(entry.name)) {
      rmSync(path);
    }
  }
};
const typesOrMaps = (file) => /\.(d\.ts|d\.mts|d\.cts|map)$/.test(file);

rmSync(staging, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Compiled program, straight into the staging folder (no stale files from an older dist/).
exec(process.execPath, [
  join(root, 'node_modules/typescript/bin/tsc'),
  '-p',
  'tsconfig.build.json',
  '--outDir',
  join(stage, 'dist'),
  '--declaration',
  'false',
  '--sourceMap',
  'false',
]);

// Production dependencies from the lockfile. serialport's install script only looks for a
// prebuilt binding; the bindings for every platform ship in the package.
for (const file of ['package.json', 'package-lock.json'])
  cpSync(join(root, file), join(stage, file));
exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
prune(join(stage, 'node_modules'), typesOrMaps);
rmSync(join(stage, 'node_modules/@serialport/bindings-cpp/src'), { recursive: true, force: true });

for (const [from, to] of [
  ['LICENSE', 'LICENSE'],
  ['README.md', 'README.md'],
  ['packaging/standalone/ventilairsec2mqtt.service', 'ventilairsec2mqtt.service'],
  ['packaging/standalone/install.sh', 'install.sh'],
  ['packaging/standalone/options.example.json', 'options.example.json'],
]) {
  cpSync(join(root, from), join(stage, to));
}

const git = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' });
const epoch =
  process.env.SOURCE_DATE_EPOCH ??
  (git.status === 0 && git.stdout.trim() !== ''
    ? git.stdout.trim()
    : `${Math.floor(Date.now() / 1000)}`);

rmSync(archive, { force: true });
const tar = join(releaseDir, `${base}.tar`);
exec('tar', [
  '--sort=name',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--mode=u+rw,go+r,go-w',
  `--mtime=@${epoch}`,
  '-cf',
  tar,
  '-C',
  staging,
  base,
]);
exec('gzip', ['-9', '-n', '-f', tar]);
rmSync(staging, { recursive: true, force: true });

const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${base}.tar.gz\n`);
const size = statSync(archive).size;
console.log(`${archive}: ${(size / 1e6).toFixed(2)} MB, sha256 ${digest}`);
