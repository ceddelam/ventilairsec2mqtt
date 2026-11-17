/**
 * Command line: `ventilairsec2mqtt [options.json] [--state state.json]`.
 */
import { ConfigError, DEFAULT_OPTIONS_PATH, DEFAULT_STATE_PATH } from './config.ts';

/**
 * Paths from the command line and the environment. Options file: first argument, else
 * `VENTILAIRSEC2MQTT_OPTIONS`, else `/data/options.json`. State file: `--state`, else
 * `VENTILAIRSEC2MQTT_STATE`, else `/data/state.json`.
 */
export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { optionsPath: string; statePath: string } {
  let optionsPath: string | undefined;
  let statePath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--state') {
      statePath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--state=')) {
      statePath = arg.slice('--state='.length);
    } else if (arg.startsWith('--')) {
      throw new ConfigError([`unknown argument ${arg}`]);
    } else if (optionsPath === undefined) {
      optionsPath = arg;
    } else {
      throw new ConfigError([`unexpected argument ${arg}`]);
    }
  }
  const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim();
  return {
    optionsPath:
      nonEmpty(optionsPath) ?? nonEmpty(env.VENTILAIRSEC2MQTT_OPTIONS) ?? DEFAULT_OPTIONS_PATH,
    statePath: nonEmpty(statePath) ?? nonEmpty(env.VENTILAIRSEC2MQTT_STATE) ?? DEFAULT_STATE_PATH,
  };
}
