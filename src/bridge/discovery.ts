/**
 * Home Assistant device-based MQTT discovery (mqtt-interface.md § 7): one retained message per
 * device on `<discovery_prefix>/device/<prefix>_<id>/config` with `dev`, `o` and `cmps`.
 */
import type { EnOceanId } from '../hex.ts';
import type { UnitType } from '../msc/unit.ts';
import {
  ASSISTANT_ENTITIES,
  BRIDGE_ENTITIES,
  hasCommand,
  UNIT_ENTITIES,
  type EntityDef,
  type Feature,
  type Platform,
} from './entities.ts';
import { entityName } from './names.ts';

/** Fixed prefix of identifiers and unique IDs (never collides with another integration). */
export const ID_PREFIX = 'ventilairsec2mqtt';

/** Application facts for the `o` (origin) block. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly supportUrl: string | undefined;
}

/** Topics and naming shared by every discovery payload. */
export interface DiscoveryContext {
  readonly topicPrefix: string;
  readonly discoveryPrefix: string;
  readonly app: AppInfo;
  readonly vmiId: EnOceanId;
}

/** Device card facts of the unit, from `CMD 3` and `CMD 4`. */
export interface UnitCard {
  readonly unitType: UnitType | undefined;
  readonly firmwareVersion: string | undefined;
  readonly hardwareVersion: string | undefined;
  readonly machineId: EnOceanId | undefined;
}

/** A component that was published before and must now be removed. */
export interface RemovedComponent {
  readonly key: string;
  readonly platform: Platform;
}

/** A discovery payload and its topic. */
export interface DiscoveryMessage {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  /** Component key → platform, as published. */
  readonly components: ReadonlyMap<string, Platform>;
}

const UNIT_TYPE_NAMES: Readonly<Record<UnitType, string>> = {
  purevent: 'Purevent',
  urban: 'Urban',
  erp: 'ERP',
};

/** Topic levels used by the app. */
export function topics(ctx: Pick<DiscoveryContext, 'topicPrefix'>, vmiId: EnOceanId) {
  const p = ctx.topicPrefix;
  return {
    bridgeAvailability: `${p}/bridge/state`,
    bridgeState: `${p}/bridge`,
    device: (id: EnOceanId) => `${p}/${id}`,
    availability: (id: EnOceanId) => `${p}/${id}/availability`,
    set: `${p}/${vmiId}/set`,
    setKey: (key: string) => `${p}/${vmiId}/set/${key}`,
  };
}

/** Discovery topic of a device; `id` is the EnOcean ID, or `bridge_<vmi_id>` for the bridge. */
export function discoveryTopic(
  ctx: Pick<DiscoveryContext, 'topicPrefix' | 'discoveryPrefix'>,
  id: string,
): string {
  return `${ctx.discoveryPrefix}/device/${ctx.topicPrefix.replaceAll('/', '_')}_${id}/config`;
}

/** `unique_id` of an entity. */
export function uniqueId(id: string, key: string): string {
  return `${ID_PREFIX}_${id}_${key}`;
}

/** Value template reading one key of the device JSON state. */
export function valueTemplate(def: EntityDef): string {
  const key = def.source ?? def.key;
  switch (def.value ?? 'value') {
    case 'flag':
      return `{% set v = value_json.get('${key}') %}{{ 'None' if v is none else ('ON' if v else 'OFF') }}`;
    case 'setpoint':
      return (
        `{% if '${key}' not in value_json %}None{% elif value_json['${key}'] is none %}off` +
        `{% else %}{{ value_json['${key}'] }}{% endif %}`
      );
    case 'count':
      return `{% set v = value_json.get('${key}') %}{{ 'None' if v is none else v | length }}`;
    case 'value':
      return `{{ value_json.get('${key}') }}`;
  }
}

/** Attributes template, or `undefined` when the entity has no attributes. */
export function attributesTemplate(def: EntityDef): string | undefined {
  if (def.attributesFrom !== undefined) {
    return `{{ (value_json.get('${def.attributesFrom}') or {}) | tojson }}`;
  }
  if (def.attributes === undefined) return undefined;
  const entries = Object.entries(def.attributes).map(
    ([name, key]) => `'${name}': value_json.get('${key}')`,
  );
  return `{{ {${entries.join(', ')}} | tojson }}`;
}

function component(
  def: EntityDef,
  id: string,
  stateTopic: string,
  commandTopic: (key: string) => string,
  entityIdPrefix: string,
): Record<string, unknown> {
  const c: Record<string, unknown> = {
    p: def.platform,
    name: entityName(def.key),
    unique_id: uniqueId(id, def.key),
    // Fixed English entity IDs, independent of the names (Home Assistant adds `_2` on collision).
    default_entity_id: `${def.platform}.${entityIdPrefix}_${def.key}`,
  };
  if (def.category !== undefined) c.entity_category = def.category;
  if (def.deviceClass !== undefined) c.device_class = def.deviceClass;
  if (def.unit !== undefined) c.unit_of_measurement = def.unit;
  if (def.stateClass !== undefined) c.state_class = def.stateClass;
  if (def.precision !== undefined) c.suggested_display_precision = def.precision;
  if (def.options !== undefined) c.options = def.options;
  if (def.min !== undefined) c.min = def.min;
  if (def.max !== undefined) c.max = def.max;
  if (def.step !== undefined) c.step = def.step;
  if (def.icon !== undefined) c.icon = def.icon;
  if (def.platform !== 'button') c.value_template = valueTemplate(def);
  const attributes = attributesTemplate(def);
  if (attributes !== undefined) {
    c.json_attributes_topic = stateTopic;
    c.json_attributes_template = attributes;
  }
  if (hasCommand(def.platform)) c.command_topic = commandTopic(def.key);
  return c;
}

function origin(app: AppInfo): Record<string, unknown> {
  const o: Record<string, unknown> = { name: app.name, sw_version: app.version };
  if (app.supportUrl !== undefined) o.support_url = app.supportUrl;
  return o;
}

function message(
  ctx: DiscoveryContext,
  id: string,
  entityIdPrefix: string,
  device: Record<string, unknown>,
  stateTopic: string,
  availabilityTopics: readonly string[],
  entities: readonly EntityDef[],
  removed: readonly RemovedComponent[],
): DiscoveryMessage {
  const t = topics(ctx, ctx.vmiId);
  const cmps: Record<string, unknown> = {};
  const components = new Map<string, Platform>();
  for (const def of entities) {
    cmps[def.key] = component(def, id, stateTopic, t.setKey, entityIdPrefix);
    components.set(def.key, def.platform);
  }
  for (const gone of removed) {
    if (!components.has(gone.key)) cmps[gone.key] = { p: gone.platform };
  }
  return {
    topic: discoveryTopic(ctx, id),
    payload: {
      dev: device,
      o: origin(ctx.app),
      state_topic: stateTopic,
      availability: availabilityTopics.map((topic) => ({ topic })),
      availability_mode: 'all',
      qos: 1,
      cmps,
    },
    components,
  };
}

function bridgeIdentifier(ctx: DiscoveryContext): string {
  return `${ID_PREFIX}_bridge_${ctx.vmiId}`;
}

/** Unit entities present for the given optional equipment. */
export function unitEntities(features: ReadonlySet<Feature>): EntityDef[] {
  return UNIT_ENTITIES.filter((def) => def.requires === undefined || features.has(def.requires));
}

/**
 * Discovery of the ventilation unit. `removed` lists components published before that are no
 * longer present: they are sent with their platform only, which removes them in Home Assistant.
 */
export function unitDiscovery(
  ctx: DiscoveryContext,
  card: UnitCard,
  features: ReadonlySet<Feature>,
  removed: readonly RemovedComponent[] = [],
): DiscoveryMessage {
  const t = topics(ctx, ctx.vmiId);
  const typeName = card.unitType === undefined ? undefined : UNIT_TYPE_NAMES[card.unitType];
  const device: Record<string, unknown> = {
    identifiers: [`${ID_PREFIX}_${ctx.vmiId}`],
    name: typeName === undefined ? 'Ventilairsec' : `Ventilairsec ${typeName}`,
    manufacturer: 'Ventilairsec',
  };
  if (typeName !== undefined) device.model = typeName;
  if (card.firmwareVersion !== undefined) device.sw_version = card.firmwareVersion;
  if (card.hardwareVersion !== undefined) device.hw_version = card.hardwareVersion;
  if (card.machineId !== undefined) device.serial_number = card.machineId;
  device.via_device = bridgeIdentifier(ctx);
  return message(
    ctx,
    ctx.vmiId,
    'ventilairsec',
    device,
    t.device(ctx.vmiId),
    [t.bridgeAvailability, t.availability(ctx.vmiId)],
    unitEntities(features),
    removed,
  );
}

/** Discovery of the Assistant. */
export function assistantDiscovery(
  ctx: DiscoveryContext,
  assistantId: EnOceanId,
): DiscoveryMessage {
  const t = topics(ctx, ctx.vmiId);
  return message(
    ctx,
    assistantId,
    'ventilairsec_assistant',
    {
      identifiers: [`${ID_PREFIX}_${assistantId}`],
      name: 'Ventilairsec Assistant',
      manufacturer: 'Ventilairsec',
      model: 'Assistant',
      via_device: bridgeIdentifier(ctx),
    },
    t.device(assistantId),
    [t.bridgeAvailability, t.availability(assistantId)],
    ASSISTANT_ENTITIES,
    [],
  );
}

/** Discovery of the bridge itself. */
export function bridgeDiscovery(ctx: DiscoveryContext): DiscoveryMessage {
  const t = topics(ctx, ctx.vmiId);
  return message(
    ctx,
    `bridge_${ctx.vmiId}`,
    ID_PREFIX,
    {
      identifiers: [bridgeIdentifier(ctx)],
      name: ctx.app.name,
      manufacturer: ctx.app.name,
      model: 'EnOcean MQTT bridge',
      sw_version: ctx.app.version,
    },
    t.bridgeState,
    [t.bridgeAvailability],
    BRIDGE_ENTITIES,
    [],
  );
}
