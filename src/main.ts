#!/usr/bin/env node
/**
 * Entry point: `ventilairsec2mqtt [options.json] [--state state.json] [--no-timestamps]`,
 * `--version`, `--help`.
 *
 * Options file: first argument, else `VENTILAIRSEC2MQTT_OPTIONS`, else `/data/options.json`.
 * State file: `--state`, else `VENTILAIRSEC2MQTT_STATE`, else `/data/state.json`.
 * Log lines carry a timestamp, except with `--no-timestamps` or when stdout is the systemd
 * journal (which then also gets each line's priority).
 * Exits with 1 on a configuration error, 0 after a clean shutdown (SIGTERM / SIGINT).
 */
import { readAppInfo, startApp, type RunningApp } from './bridge/app.ts';
import { parseCommandLine, USAGE, type CommandLine } from './bridge/cli.ts';
import { ConfigError, loadOptions } from './bridge/config.ts';
import {
  createConsoleLogger,
  errorMessage,
  formatLogLine,
  isJournalStream,
  type LogFormat,
} from './bridge/log.ts';
import { BrokerConfigError } from './bridge/supervisor.ts';

async function main(): Promise<void> {
  let format: LogFormat = isJournalStream(process.env) ? 'journal' : 'timestamp';
  const fatal = (message: string): never => {
    process.stderr.write(`${formatLogLine(format, 'error', message)}\n`);
    process.exit(1);
  };

  let command: CommandLine;
  try {
    command = parseCommandLine(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof ConfigError) return fatal(error.message);
    throw error;
  }
  if (command.action === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command.action === 'version') {
    process.stdout.write(`${readAppInfo().version}\n`);
    return;
  }
  if (command.noTimestamps && format === 'timestamp') format = 'plain';

  let loaded: Awaited<ReturnType<typeof loadOptions>>;
  try {
    loaded = await loadOptions(command.optionsPath);
  } catch (error) {
    if (error instanceof ConfigError) return fatal(error.message);
    throw error;
  }
  const { options, warnings } = loaded;
  const logger = createConsoleLogger(options.logLevel, undefined, undefined, format);
  for (const warning of warnings) logger.warn(warning);

  let app: RunningApp;
  try {
    app = await startApp({ options, stateFile: command.statePath, logger });
  } catch (error) {
    if (error instanceof BrokerConfigError) return fatal(error.message);
    throw error;
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, stopping`);
    const force = setTimeout(() => {
      logger.error('Shutdown timed out');
      process.exit(1);
    }, 10_000);
    force.unref();
    app
      .stop()
      .then(() => {
        logger.info('Stopped');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error(`Shutdown failed: ${errorMessage(error)}`);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${new Date().toISOString()} ERROR ${errorMessage(error)}\n`);
  process.exit(1);
});
