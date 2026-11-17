/**
 * Telegram classification: tells unit status frames from unit → Assistant frames, Assistant
 * frames and teach-in queries (protocol.md § 3–5, § 7).
 */
import { Rorg, type Erp1Telegram } from './erp1.ts';
import { normalizeId, type EnOceanId } from './hex.ts';
import { decodeAssistant, type AssistantFrame } from './msc/assistant.ts';
import { parseMscHeader, VENTILAIRSEC_MANUFACTURER } from './msc/envelope.ts';
import { decodeUnitStatus, type UnitStatusFrame } from './msc/unit.ts';
import { isTeachInQuery, parseUte, type UteQuery } from './pairing.ts';

/** IDs the classifier needs. */
export interface KnownIds {
  /** The ventilation unit. */
  readonly unitId: EnOceanId;
  /**
   * The Assistant, when known. Without it, any Ventilairsec frame addressed to the unit by
   * another sender is taken as an Assistant frame, and unit frames are recognised as
   * unit → Assistant frames only through `receiverIds`.
   */
  readonly assistantId?: EnOceanId | undefined;
  /**
   * The IDs the unit addresses its status to (our sender ID). When given, unit frames addressed
   * to any other ID are classified `unit_to_other` instead of being decoded as status.
   */
  readonly receiverIds?: readonly EnOceanId[] | undefined;
}

/** Result of {@link classifyTelegram}, discriminated by `kind`. */
export type ClassifiedTelegram =
  | {
      /** A unit status frame (§ 5.1–5.8), decoded. */
      readonly kind: 'unit_status';
      readonly telegram: Erp1Telegram;
      readonly status: UnitStatusFrame;
    }
  | {
      /** Unit → Assistant frame (§ 5.9): meaning unknown, must not be decoded as status. */
      readonly kind: 'unit_to_assistant';
      readonly telegram: Erp1Telegram;
      readonly command: number;
      /** Payload bytes after the 2-byte MSC header. */
      readonly data: Uint8Array;
    }
  | {
      /** Unit frame addressed to an ID that is neither ours nor the Assistant's. */
      readonly kind: 'unit_to_other';
      readonly telegram: Erp1Telegram;
      readonly command: number;
      readonly data: Uint8Array;
    }
  | {
      /** Assistant frame (§ 4), decoded. */
      readonly kind: 'assistant';
      readonly telegram: Erp1Telegram;
      readonly frame: AssistantFrame;
    }
  | {
      /** UTE teach-in query from the unit expecting a response (§ 7). */
      readonly kind: 'teach_in_query';
      readonly telegram: Erp1Telegram;
      readonly query: UteQuery;
    }
  | {
      /** Anything else (other devices, other profiles, broken frames). */
      readonly kind: 'ignored';
      readonly telegram: Erp1Telegram;
      readonly reason: string;
    };

/**
 * Classifies a complete (already reassembled) telegram.
 *
 * Rules, in order:
 * 1. RORG `D4` from the unit expecting a response → `teach_in_query`.
 * 2. Only RORG `D1` with manufacturer `079` go further.
 * 3. From the unit: addressed to the Assistant → `unit_to_assistant`; addressed to an ID outside
 *    `receiverIds` (when given) → `unit_to_other`; otherwise → `unit_status`.
 * 4. From the Assistant (or, when its ID is unknown, from anyone to the unit) → `assistant`.
 */
export function classifyTelegram(telegram: Erp1Telegram, ids: KnownIds): ClassifiedTelegram {
  const unitId = normalizeId(ids.unitId);
  const assistantId = ids.assistantId === undefined ? undefined : normalizeId(ids.assistantId);
  const receivers = ids.receiverIds?.map((id) => normalizeId(id));
  const ignored = (reason: string): ClassifiedTelegram => ({ kind: 'ignored', telegram, reason });

  if (telegram.rorg === Rorg.UTE) {
    if (telegram.senderId !== unitId) return ignored('teach-in from another device');
    const query = parseUte(telegram);
    if (query === undefined || !isTeachInQuery(telegram)) {
      return ignored('UTE telegram not expecting a response');
    }
    return { kind: 'teach_in_query', telegram, query };
  }
  if (telegram.rorg !== Rorg.MSC) return ignored(`RORG ${telegram.rorg.toString(16)}`);
  const header = parseMscHeader(telegram.payload);
  if (header === undefined) return ignored('MSC payload too short');
  if (header.manufacturer !== VENTILAIRSEC_MANUFACTURER) return ignored('other manufacturer');

  if (telegram.senderId === unitId) {
    const destination = telegram.destinationId;
    const data = telegram.payload.slice(2);
    if (assistantId !== undefined && destination === assistantId) {
      return { kind: 'unit_to_assistant', telegram, command: header.command, data };
    }
    if (
      receivers !== undefined &&
      (destination === undefined || !receivers.includes(destination))
    ) {
      return { kind: 'unit_to_other', telegram, command: header.command, data };
    }
    const status = decodeUnitStatus(telegram.payload);
    if (status === undefined) return ignored('MSC payload too short');
    return { kind: 'unit_status', telegram, status };
  }

  const fromAssistant =
    assistantId === undefined
      ? telegram.destinationId === unitId
      : telegram.senderId === assistantId;
  if (fromAssistant) {
    const frame = decodeAssistant(telegram.payload);
    if (frame === undefined) return ignored('MSC payload too short');
    return { kind: 'assistant', telegram, frame };
  }
  return ignored('unknown sender');
}
