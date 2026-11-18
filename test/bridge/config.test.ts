/**
 * Options loading and validation, broker resolution (external or Supervisor), command line.
 */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseArguments, parseCommandLine, USAGE } from '../../src/bridge/cli.ts';
import { ConfigError, loadOptions, parseOptions } from '../../src/bridge/config.ts';
import {
  BrokerConfigError,
  resolveBroker,
  SUPERVISOR_MQTT_URL,
  type FetchLike,
} from '../../src/bridge/supervisor.ts';
import { tempDir } from '../helpers/fake-bridge.ts';

const MINIMAL = { serial_port: '/dev/ttyUSB0', vmi_id: '0400aa01' };

function problems(raw: unknown): readonly string[] {
  try {
    parseOptions(raw);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected a ConfigError');
}

describe('parseOptions', () => {
  it('applies the defaults', () => {
    const { options, warnings } = parseOptions(MINIMAL);
    assert.deepEqual(warnings, []);
    assert.deepEqual(options, {
      serialPort: '/dev/ttyUSB0',
      fallbackPort: undefined,
      vmiId: '0400AA01',
      assistantId: undefined,
      senderId: undefined,
      forceBaseId: undefined,
      syncClock: true,
      acceptPairing: true,
      topicPrefix: 'ventilairsec2mqtt',
      discoveryPrefix: 'homeassistant',
      logLevel: 'info',
      mqtt: undefined,
    });
  });

  it('trims strings, upper-cases IDs and treats empty strings as unset', () => {
    const { options } = parseOptions({
      serial_port: '  socket://127.0.0.1:3333 ',
      fallback_port: ' ',
      vmi_id: ' 0400aa01 ',
      assistant_id: '0400aa02',
      sender_id: '',
      force_base_id: ' ffaa0000',
      sync_clock: false,
      accept_pairing: false,
      topic_prefix: ' vmi/house ',
      discovery_prefix: 'ha',
      log_level: 'debug',
      mqtt_host: ' localhost ',
      mqtt_port: 1884,
      mqtt_user: ' user ',
      mqtt_password: ' secret ',
      mqtt_tls: true,
    });
    assert.equal(options.serialPort, 'socket://127.0.0.1:3333');
    assert.equal(options.fallbackPort, undefined);
    assert.equal(options.assistantId, '0400AA02');
    assert.equal(options.senderId, undefined);
    assert.equal(options.forceBaseId, 'FFAA0000');
    assert.equal(options.syncClock, false);
    assert.equal(options.acceptPairing, false);
    assert.equal(options.topicPrefix, 'vmi/house');
    assert.equal(options.discoveryPrefix, 'ha');
    assert.equal(options.logLevel, 'debug');
    assert.deepEqual(options.mqtt, {
      host: 'localhost',
      port: 1884,
      username: 'user',
      password: 'secret',
      tls: true,
    });
  });

  it('defaults the port to 1883, or 8883 with TLS', () => {
    assert.equal(parseOptions({ ...MINIMAL, mqtt_host: 'localhost' }).options.mqtt?.port, 1883);
    assert.equal(
      parseOptions({ ...MINIMAL, mqtt_host: 'localhost', mqtt_tls: true }).options.mqtt?.port,
      8883,
    );
    assert.equal(
      parseOptions({ ...MINIMAL, mqtt_host: 'localhost', mqtt_port: ' 1885 ' }).options.mqtt?.port,
      1885,
    );
  });

  it('reports unknown keys as warnings', () => {
    assert.deepEqual(parseOptions({ ...MINIMAL, colour: 'blue' }).warnings, [
      'Unknown option "colour" ignored',
    ]);
  });

  it('requires serial_port', () => {
    assert.deepEqual(problems({}), ['serial_port: required']);
  });

  it('accepts an empty vmi_id (scan mode)', () => {
    assert.equal(parseOptions({ serial_port: '/dev/ttyUSB0' }).options.vmiId, undefined);
    assert.equal(
      parseOptions({ serial_port: '/dev/ttyUSB0', vmi_id: ' ' }).options.vmiId,
      undefined,
    );
  });

  it('rejects a non-object', () => {
    assert.deepEqual(problems([1]), ['the options file must hold a JSON object']);
  });

  it('lists every invalid value', () => {
    const list = problems({
      serial_port: 'socket://host',
      vmi_id: '0400AA0',
      assistant_id: 'FFFFFFFF',
      sender_id: 42,
      force_base_id: 'FFAA0001',
      sync_clock: 'yes',
      topic_prefix: 'a/+/b',
      discovery_prefix: '/homeassistant',
      log_level: 'verbose',
      mqtt_host: 'localhost',
      mqtt_port: 70000,
      mqtt_password: 'secret',
    });
    assert.deepEqual(list, [
      'serial_port: Invalid socket URL "socket://host" (expected socket://host:port)',
      'vmi_id: "0400AA0" is not an EnOcean ID (8 hexadecimal digits)',
      'assistant_id: FFFFFFFF is not a device ID',
      'sender_id: expected a string, got 42',
      'force_base_id: Base ID FFAA0001 is not a multiple of 0x80',
      'log_level: expected one of debug, info, warning, error, got "verbose"',
      'mqtt_port: expected an integer in 1–65535, got 70000',
      'mqtt_password: set without mqtt_user',
      'sync_clock: expected true or false, got "yes"',
      'topic_prefix: "a/+/b" must be MQTT topic levels made of letters, digits, "_" or "-" ' +
        'separated by "/" (no wildcard, no leading or trailing "/")',
      'discovery_prefix: "/homeassistant" must be MQTT topic levels made of letters, digits, "_" ' +
        'or "-" separated by "/" (no wildcard, no leading or trailing "/")',
    ]);
  });

  it('checks the Base ID range and the IDs against the unit ID', () => {
    assert.deepEqual(problems({ ...MINIMAL, force_base_id: 'FF000000' }), [
      'force_base_id: Base ID FF000000 out of range FF800000–FFFFFF80',
    ]);
    assert.deepEqual(problems({ ...MINIMAL, assistant_id: '0400AA01', sender_id: '0400aa01' }), [
      'assistant_id: must differ from vmi_id',
      'sender_id: must differ from vmi_id',
    ]);
  });
});

describe('loadOptions', () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('reads a file', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const path = join(dir, 'options.json');
    await writeFile(path, JSON.stringify(MINIMAL));
    assert.equal((await loadOptions(path)).options.vmiId, '0400AA01');
  });

  it('fails clearly on a missing file or invalid JSON', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await assert.rejects(loadOptions(join(dir, 'missing.json')), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /cannot read the options file .*missing\.json/);
      return true;
    });
    const path = join(dir, 'broken.json');
    await writeFile(path, '{ "vmi_id": ');
    await assert.rejects(loadOptions(path), /broken\.json is not valid JSON/);
  });
});

describe('resolveBroker', () => {
  const external = parseOptions({ ...MINIMAL, mqtt_host: 'localhost', mqtt_user: 'u' }).options;
  const supervised = parseOptions(MINIMAL).options;

  function fakeFetch(status: number, body: unknown, calls: unknown[] = []): FetchLike {
    return (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    };
  }

  it('uses the external broker when mqtt_host is set', async () => {
    assert.deepEqual(await resolveBroker(external, { env: {} }), {
      source: 'options',
      host: 'localhost',
      port: 1883,
      username: 'u',
      password: undefined,
      tls: false,
    });
  });

  it('asks the Supervisor otherwise', async () => {
    const calls: unknown[] = [];
    const broker = await resolveBroker(supervised, {
      env: { SUPERVISOR_TOKEN: 'token' },
      fetch: fakeFetch(
        200,
        {
          result: 'ok',
          data: {
            host: 'core-mosquitto',
            port: 1883,
            ssl: false,
            protocol: '3.1.1',
            username: 'addons',
            password: 'pw',
          },
        },
        calls,
      ),
    });
    assert.deepEqual(calls, [{ url: SUPERVISOR_MQTT_URL, auth: 'Bearer token' }]);
    assert.deepEqual(broker, {
      source: 'supervisor',
      host: 'core-mosquitto',
      port: 1883,
      username: 'addons',
      password: 'pw',
      tls: false,
    });
  });

  it('fails clearly without a token', async () => {
    await assert.rejects(resolveBroker(supervised, { env: {} }), (error: unknown) => {
      assert.ok(error instanceof BrokerConfigError);
      assert.match(error.message, /SUPERVISOR_TOKEN is not set/);
      return true;
    });
  });

  it('fails clearly without an MQTT service', async () => {
    await assert.rejects(
      resolveBroker(supervised, {
        env: { SUPERVISOR_TOKEN: 'token' },
        fetch: fakeFetch(400, { result: 'error', message: 'No service' }),
      }),
      /No MQTT service from the Supervisor \(HTTP 400: No service\)/,
    );
  });

  it('fails clearly when the Supervisor is unreachable or answers nonsense', async () => {
    await assert.rejects(
      resolveBroker(supervised, {
        env: { SUPERVISOR_TOKEN: 'token' },
        fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND supervisor')),
      }),
      /Cannot reach the Supervisor .*ENOTFOUND/,
    );
    await assert.rejects(
      resolveBroker(supervised, {
        env: { SUPERVISOR_TOKEN: 'token' },
        fetch: fakeFetch(200, { result: 'ok', data: {} }),
      }),
      /Invalid MQTT service data/,
    );
  });
});

describe('parseArguments', () => {
  it('takes the options path from the argument, the environment or the default', () => {
    assert.deepEqual(parseArguments(['opts.json', '--state', 's.json'], {}), {
      optionsPath: 'opts.json',
      statePath: 's.json',
    });
    assert.deepEqual(
      parseArguments([], {
        VENTILAIRSEC2MQTT_OPTIONS: 'env-opts.json',
        VENTILAIRSEC2MQTT_STATE: 'env-state.json',
      }),
      { optionsPath: 'env-opts.json', statePath: 'env-state.json' },
    );
    assert.deepEqual(parseArguments(['--state=x.json'], {}), {
      optionsPath: '/data/options.json',
      statePath: 'x.json',
    });
    assert.deepEqual(parseArguments([], {}), {
      optionsPath: '/data/options.json',
      statePath: '/data/state.json',
    });
  });

  it('rejects unknown arguments', () => {
    assert.throws(() => parseArguments(['--verbose'], {}), /unknown argument --verbose/);
    assert.throws(() => parseArguments(['a.json', 'b.json'], {}), /unexpected argument b\.json/);
  });
});

describe('parseCommandLine', () => {
  it('recognises --help and --version anywhere', () => {
    assert.deepEqual(parseCommandLine(['--help'], {}), { action: 'help' });
    assert.deepEqual(parseCommandLine(['opts.json', '-h'], {}), { action: 'help' });
    assert.deepEqual(parseCommandLine(['--version'], {}), { action: 'version' });
    assert.deepEqual(parseCommandLine(['--bogus', '--version'], {}), { action: 'version' });
    assert.throws(() => parseArguments(['--version'], {}), /--version takes no paths/);
  });

  it('reads --no-timestamps', () => {
    assert.deepEqual(parseCommandLine(['/etc/x.json', '--no-timestamps'], {}), {
      action: 'run',
      optionsPath: '/etc/x.json',
      statePath: '/data/state.json',
      noTimestamps: true,
    });
    assert.equal(parseCommandLine([], {}).action, 'run');
  });

  it('documents every argument in the usage text', () => {
    for (const word of ['--state', '--no-timestamps', '--version', '--help', 'scan mode']) {
      assert.ok(USAGE.includes(word), word);
    }
  });
});
