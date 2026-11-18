#!/usr/bin/env node
/**
 * `npm run app:local`: assembles a self-contained Home Assistant local app in
 * `.local-app/ventilairsec2mqtt/` (git-ignored): the app folder without the `image:` key (so the
 * Supervisor builds it from the Dockerfile instead of pulling the published image), plus the
 * build inputs the Dockerfile copies (package*.json, tsconfig*.json, src/) at the same relative
 * paths as in the repository. Copy that folder into the `local_apps` share of Home Assistant.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = join(root, 'ventilairsec2mqtt');
const out = join(root, '.local-app', 'ventilairsec2mqtt');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(app, out, { recursive: true });
for (const entry of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'src',
  '.dockerignore',
]) {
  cpSync(join(root, entry), join(out, entry), { recursive: true });
}

const configPath = join(out, 'config.yaml');
const config = readFileSync(configPath, 'utf8');
if (!/^image: .*\n/m.test(config)) throw new Error('config.yaml has no image: line');
writeFileSync(
  configPath,
  config.replace(
    /^image: .*\n/m,
    '# Local app: no image, the Supervisor builds it from the Dockerfile.\n',
  ),
);

console.log(`Local app ready in ${out}
Copy this folder into the local_apps share of Home Assistant (Samba or SSH app), e.g.
  scp -r ${out} root@<home-assistant>:/local_apps/
then in Home Assistant: Settings > Apps > App store > ⋮ > Check for updates, and install
"ventilairsec2mqtt" from the Local apps section (the first start builds the image).`);
