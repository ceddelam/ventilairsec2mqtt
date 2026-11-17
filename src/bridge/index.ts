/**
 * ventilairsec2mqtt MQTT bridge (phase 2): options, broker resolution, state file, device
 * models, Home Assistant discovery, orders and the composition used by `main.ts`.
 *
 * @packageDocumentation
 */

export { startApp, readAppInfo, type RunningApp, type StartAppOptions } from './app.ts';
export { AssistantModel, batteryPercent } from './assistant-model.ts';
export {
  Bridge,
  type BridgeLink,
  type BridgeOptions,
  type BridgeSettings,
  type MqttPublisher,
} from './bridge.ts';
export { parseArguments } from './cli.ts';
export {
  InvalidOrderError,
  ORDER_KEYS,
  parseJsonOrder,
  parseKeyOrder,
  parseOrderEntries,
  type DurationSwitch,
  type OrderKey,
  type ParsedOrder,
} from './commands.ts';
export {
  ConfigError,
  DEFAULT_OPTIONS_PATH,
  DEFAULT_STATE_PATH,
  loadOptions,
  parseOptions,
  type ExternalBroker,
  type Options,
  type ParsedOptions,
} from './config.ts';
export {
  assistantDiscovery,
  bridgeDiscovery,
  discoveryTopic,
  ID_PREFIX,
  topics,
  uniqueId,
  unitDiscovery,
  type AppInfo,
  type DiscoveryContext,
  type DiscoveryMessage,
  type RemovedComponent,
  type UnitCard,
} from './discovery.ts';
export {
  ASSISTANT_ENTITIES,
  BRIDGE_ENTITIES,
  UNIT_ENTITIES,
  type EntityDef,
  type Feature,
  type Platform,
} from './entities.ts';
export { entityName, type EntityKey } from './names.ts';
export { createConsoleLogger, LOG_LEVELS, type LogLevel, type LogSink } from './log.ts';
export {
  BOOST_DURATION,
  DEFAULT_STATE,
  HOLIDAY_DURATION,
  StateStore,
  type PersistentState,
  type StateStoreLike,
} from './state-store.ts';
export {
  BrokerConfigError,
  resolveBroker,
  SUPERVISOR_MQTT_URL,
  type BrokerSettings,
  type FetchLike,
  type ResolveBrokerOptions,
} from './supervisor.ts';
export { filterDaysLeft, UnitModel, type JsonObject, type JsonValue } from './unit-model.ts';
export {
  AvailabilityTracker,
  IncidentTracker,
  THIRTY_MINUTES,
  type Availability,
} from './watchdog.ts';
