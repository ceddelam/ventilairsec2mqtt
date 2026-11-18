/**
 * Command line: `ventilairsec2mqtt [options.json] [--state state.json] [--no-timestamps]`,
 * `ventilairsec2mqtt --version`, `ventilairsec2mqtt --help`.
 */
import { ConfigError, DEFAULT_OPTIONS_PATH, DEFAULT_STATE_PATH } from './config.ts';

/** What the command line asks for. */
export type CommandLine =
  | { readonly action: 'help' }
  | { readonly action: 'version' }
  | {
      readonly action: 'run';
      readonly optionsPath: string;
      readonly statePath: string;
      /** `--no-timestamps`: log lines without the timestamp prefix. */
      readonly noTimestamps: boolean;
    };

/** Text printed by `--help`. */
export const USAGE = `Usage: ventilairsec2mqtt [options.json] [--state state.json] [--no-timestamps]
       ventilairsec2mqtt --version | --help

Bridge between Ventilairsec ventilation units (EnOcean MSC D1-079) and MQTT.

Arguments:
  options.json      options file (default: $VENTILAIRSEC2MQTT_OPTIONS, else ${DEFAULT_OPTIONS_PATH})

Options:
  --state <file>    state file (default: $VENTILAIRSEC2MQTT_STATE, else ${DEFAULT_STATE_PATH})
  --no-timestamps   log lines without a timestamp (automatic under the systemd journal)
  --version         print the version and exit
  -h, --help        print this help and exit

With an empty vmi_id the program runs in scan mode: it only logs the Ventilairsec devices it
hears, to help find the IDs.`;

/**
 * Parses the command line. `--help` and `--version` win over everything else. Options file:
 * first argument, else `VENTILAIRSEC2MQTT_OPTIONS`, else `/data/options.json`. State file:
 * `--state`, else `VENTILAIRSEC2MQTT_STATE`, else `/data/state.json`.
 */
export function parseCommandLine(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CommandLine {
  if (argv.includes('--help') || argv.includes('-h')) return { action: 'help' };
  if (argv.includes('--version')) return { action: 'version' };
  let optionsPath: string | undefined;
  let statePath: string | undefined;
  let noTimestamps = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--state') {
      statePath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--state=')) {
      statePath = arg.slice('--state='.length);
    } else if (arg === '--no-timestamps') {
      noTimestamps = true;
    } else if (arg.startsWith('-')) {
      throw new ConfigError([`unknown argument ${arg} (see --help)`]);
    } else if (optionsPath === undefined) {
      optionsPath = arg;
    } else {
      throw new ConfigError([`unexpected argument ${arg} (see --help)`]);
    }
  }
  const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim();
  return {
    action: 'run',
    optionsPath:
      nonEmpty(optionsPath) ?? nonEmpty(env.VENTILAIRSEC2MQTT_OPTIONS) ?? DEFAULT_OPTIONS_PATH,
    statePath: nonEmpty(statePath) ?? nonEmpty(env.VENTILAIRSEC2MQTT_STATE) ?? DEFAULT_STATE_PATH,
    noTimestamps,
  };
}

/**
 * Paths from the command line and the environment (see {@link parseCommandLine}). Throws a
 * `ConfigError` on `--help` / `--version`, which carry no paths.
 */
export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { optionsPath: string; statePath: string } {
  const command = parseCommandLine(argv, env);
  if (command.action !== 'run') throw new ConfigError([`--${command.action} takes no paths`]);
  return { optionsPath: command.optionsPath, statePath: command.statePath };
}
