/**
 * Packaging consistency: the Home Assistant app's config.yaml and translations against the
 * program's options, versions, the CHANGELOG copy, the standalone files. Reads the repository
 * files from the working directory (the npm scripts run from the repository root).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OPTION_KEYS, parseOptions } from '../src/bridge/config.ts';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type Yaml = string | boolean | Yaml[] | { [key: string]: Yaml };

/**
 * Parses the YAML subset of the app files: nested maps (2-space indent), lists of scalars,
 * quoted or plain scalars, `>-` folded blocks, comments.
 */
function parseYaml(text: string): Record<string, Yaml> {
  const lines = text
    .split('\n')
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'));
  let index = 0;
  const scalar = (value: string): string | boolean => {
    if (value === 'true' || value === 'false') return value === 'true';
    const quoted = /^(['"])(.*)\1$/.exec(value);
    return quoted === null ? value : (quoted[2] ?? '');
  };
  const block = (indent: number): Yaml => {
    if (lines[index]?.text.startsWith('- ')) {
      const list: Yaml[] = [];
      while (lines[index]?.indent === indent && lines[index]?.text.startsWith('- ')) {
        list.push(scalar(lines[index]!.text.slice(2).trim()));
        index += 1;
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (index < lines.length && lines[index]!.indent === indent) {
      const line = lines[index]!;
      const match = /^([^:]+):(?:\s+(.*))?$/.exec(line.text);
      assert.ok(match, `unsupported YAML line "${line.text}"`);
      const key = match[1]!;
      const value = match[2];
      index += 1;
      if (value === '>-') {
        const parts: string[] = [];
        while (index < lines.length && lines[index]!.indent > indent) {
          parts.push(lines[index]!.text);
          index += 1;
        }
        map[key] = parts.join(' ');
      } else if (value === undefined) {
        const next = lines[index];
        map[key] = next !== undefined && next.indent >= indent ? block(next.indent) : '';
      } else {
        map[key] = scalar(value);
      }
    }
    return map;
  };
  return block(0) as Record<string, Yaml>;
}

const config = parseYaml(read('ventilairsec2mqtt/config.yaml'));
const options = config.options as Record<string, string | boolean>;
const schema = config.schema as Record<string, string>;
const packageJson = JSON.parse(read('package.json')) as { version: string; homepage: string };

describe('Home Assistant app files', () => {
  it('declare the app as documented', () => {
    assert.equal(config.slug, 'ventilairsec2mqtt');
    assert.equal(config.version, packageJson.version);
    assert.equal(config.url, packageJson.homepage);
    assert.deepEqual(config.arch, ['aarch64', 'amd64']);
    assert.equal(config.image, 'ghcr.io/ceddelam/ventilairsec2mqtt');
    assert.equal(config.init, false);
    assert.deepEqual(config.services, ['mqtt:want']);
    assert.equal(config.uart, true);
    for (const key of ['ports', 'ingress', 'host_network', 'full_access', 'privileged']) {
      assert.equal(config[key], undefined, key);
    }
    const repository = parseYaml(read('repository.yaml'));
    assert.equal(repository.url, packageJson.homepage);
  });

  it('have a schema with exactly the program options', () => {
    assert.deepEqual(Object.keys(schema).sort(), [...OPTION_KEYS].sort());
    for (const key of Object.keys(options)) assert.ok(key in schema, key);
  });

  it('have defaults the program accepts, equal to its own defaults', () => {
    const fromApp = parseOptions(options);
    assert.deepEqual(fromApp.warnings, []);
    assert.equal(fromApp.options.vmiId, undefined, 'empty vmi_id: scan mode');
    const defaults = parseOptions({ serial_port: options.serial_port }).options;
    assert.deepEqual(fromApp.options, defaults);
  });

  it('validate IDs and topics like the program', () => {
    const regex = (key: string): RegExp => {
      const match = /^match\((.*)\)\??$/.exec(schema[key] ?? '');
      assert.ok(match, key);
      return new RegExp(match[1]!);
    };
    assert.ok(regex('vmi_id').test(''));
    assert.ok(regex('vmi_id').test('0400aa01'));
    assert.ok(!regex('vmi_id').test('0400AA0'));
    assert.ok(regex('assistant_id').test('0400AA02'));
    assert.ok(!regex('assistant_id').test(''));
    assert.ok(regex('force_base_id').test('FFAA0000'));
    assert.ok(!regex('force_base_id').test('0400AA00'));
    for (const key of ['topic_prefix', 'discovery_prefix']) {
      assert.ok(regex(key).test('home/vmi'), key);
      assert.ok(!regex(key).test('home/#'), key);
      assert.ok(!regex(key).test('/home'), key);
    }
    assert.equal(schema.log_level, 'list(debug|info|warning|error)');
  });

  it('name and describe every option in English', () => {
    const translations = parseYaml(read('ventilairsec2mqtt/translations/en.yaml'));
    const entries = translations.configuration as Record<string, Record<string, string>>;
    assert.deepEqual(Object.keys(entries).sort(), Object.keys(schema).sort());
    for (const [key, entry] of Object.entries(entries)) {
      assert.ok((entry.name ?? '') !== '', `${key} name`);
      assert.ok((entry.description ?? '') !== '', `${key} description`);
    }
  });

  it('keep the CHANGELOG copy in sync with the root one (npm run changelog:sync)', () => {
    assert.equal(read('ventilairsec2mqtt/CHANGELOG.md'), read('CHANGELOG.md'));
  });

  it('ship the presentation files and a pinned base image', () => {
    for (const file of ['README.md', 'DOCS.md', 'icon.png', 'logo.png']) {
      assert.ok(existsSync(join(ROOT, 'ventilairsec2mqtt', file)), file);
    }
    const dockerfile = read('ventilairsec2mqtt/Dockerfile');
    assert.match(dockerfile, /^FROM ghcr\.io\/home-assistant\/base:\d+\.\d+-\d{4}\.\d+\.\d+$/m);
    assert.match(dockerfile, /io\.hass\.type="app"/);
    // The AppArmor draft stays out of the app folder until tested on a real Supervisor.
    assert.ok(!existsSync(join(ROOT, 'ventilairsec2mqtt/apparmor.txt')));
  });
});

describe('standalone service files', () => {
  it('agree on paths and versions', () => {
    const unit = read('packaging/standalone/ventilairsec2mqtt.service');
    const install = read('packaging/standalone/install.sh');
    assert.match(
      unit,
      /^ExecStart=\/usr\/bin\/node \/opt\/ventilairsec2mqtt\/current\/dist\/main\.js \/etc\/ventilairsec2mqtt\/options\.json$/m,
    );
    assert.match(
      unit,
      /^Environment=VENTILAIRSEC2MQTT_STATE=\/var\/lib\/ventilairsec2mqtt\/state\.json$/m,
    );
    assert.match(install, /\/opt\/ventilairsec2mqtt/);
    const example = JSON.parse(read('packaging/standalone/options.example.json')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      Object.keys(example).filter((key) => !OPTION_KEYS.includes(key)),
      [],
    );
    assert.equal(parseOptions(example).options.vmiId, undefined);
  });
});
