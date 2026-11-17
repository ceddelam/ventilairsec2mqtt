/**
 * ventilairsec2mqtt protocol core: ESP3 / ERP1 framing, chained messages, Ventilairsec MSC
 * D1-079 decoding, orders, pairing, transports and supervised stick connection.
 *
 * @packageDocumentation
 */

export {
  BROADCAST_ID,
  fromHex,
  idToBytes,
  idToNumber,
  isEnOceanId,
  normalizeId,
  numberToId,
  readId,
  toHex,
  type EnOceanId,
} from './hex.ts';
export { noopLogger, type Logger } from './logger.ts';
export { systemTimers, type TimerHandle, type Timers } from './timers.ts';

export { crc8 } from './esp3/crc8.ts';
export {
  Esp3Decoder,
  encodePacket,
  PacketType,
  SYNC_BYTE,
  type DiscardReason,
  type Esp3DecoderOptions,
  type Esp3DecoderStats,
  type Esp3Packet,
  type PacketTypeValue,
} from './esp3/packet.ts';
export {
  BASE_ID_MAX,
  BASE_ID_MIN,
  buildReadIdBase,
  buildReset,
  buildWriteIdBase,
  CommonCommand,
  EventCode,
  eventCodeName,
  parseBaseIdResponse,
  parseEvent,
  parseResponse,
  ReturnCode,
  returnCodeName,
  validateBaseId,
  type BaseIdInfo,
  type Esp3Event,
  type Esp3Response,
} from './esp3/commands.ts';

export {
  buildErp1Packet,
  erp1Data,
  parseErp1,
  parseErp1Packet,
  Rorg,
  type Erp1Telegram,
  type TransmitTelegram,
} from './erp1.ts';
export {
  ChainReassembler,
  splitSeqIdx,
  type ChainDropReason,
  type ChainReassemblerOptions,
} from './chain.ts';

export { readBits, readFlag, readSigned, toSigned } from './msc/bits.ts';
export {
  mscHeaderBytes,
  parseMscHeader,
  VENTILAIRSEC_MANUFACTURER,
  type MscHeader,
} from './msc/envelope.ts';
export {
  AssistantCommand,
  decodeAssistant,
  type AssistantFrame,
  type AssistantMeasurement,
  type AssistantOtherFrame,
} from './msc/assistant.ts';
export {
  decodeFunctionByte,
  FunctionBit,
  updateFunctionByte,
  type BypassSource,
  type FunctionChange,
  type FunctionFlags,
} from './msc/function-byte.ts';
export {
  BYPASS_POSITIONS,
  decodeUnitStatus,
  HYDROR_DISABLED,
  PREHEAT_DISABLED,
  PROBE_POSITIONS,
  ROOMS,
  SEASONS,
  SOLARR_DISABLED,
  SYSTEM_STATES,
  UNIT_MODES,
  type BypassPosition,
  type BypassSlot,
  type ProbePosition,
  type ProbeSlot,
  type Room,
  type Season,
  type SelfTest,
  type SensorProfile,
  type SystemState,
  type UnitComplement1,
  type UnitComplement2,
  type UnitConfiguration,
  type UnitCurrentData,
  type UnitMaintenance,
  type UnitMode,
  type UnitOptions,
  type UnitPairedSensor,
  type UnitProbes,
  type UnitStatusFrame,
  type UnitType,
  type UnitUnknownFrame,
} from './msc/unit.ts';
export { errorLabel, isNoError, type UnitError } from './msc/errors.ts';
export { classifyTelegram, type ClassifiedTelegram, type KnownIds } from './classify.ts';
export { MachineIdGuard, type MachineIdCheck } from './machine-id.ts';

export {
  buildClockTelegram,
  buildOrderTelegram,
  buildSettingsTelegram,
  encodeClock,
  encodeSettings,
  mergeSettings,
  OneShotCommand,
  ORDER_STATUS,
  OrderError,
  SETTING_RANGES,
  UNCHANGED,
  type OneShotCommandName,
  type SettingsOrder,
} from './orders.ts';
export {
  buildTeachInResponse,
  DEFAULT_PAIRING_MIN_INTERVAL_MS,
  DEFAULT_PAIRING_QUIET_PERIOD_MS,
  isTeachInQuery,
  parseUte,
  shouldAnswerTeachIn,
  UTE_RESPONSE_ACCEPTED,
  type PairingPolicyOptions,
  type PairingPolicyState,
  type UteQuery,
} from './pairing.ts';

export type { Transport, TransportEvents, TransportKind } from './transport/types.ts';
export { TcpTransport, type TcpTransportOptions } from './transport/tcp.ts';
export {
  defaultSerialPortFactory,
  ESP3_BAUD_RATE,
  SerialTransport,
  type SerialPortFactory,
  type SerialPortLike,
  type SerialPortOptions,
  type SerialTransportOptions,
} from './transport/serial.ts';
export {
  createTransport,
  parseConnectionUrl,
  type ConnectionTarget,
  type CreateTransportOptions,
} from './transport/url.ts';

export {
  Stick,
  StickClosedError,
  StickTimeoutError,
  type Incident,
  type IncidentReason,
  type SendResult,
  type StickEvents,
  type StickOptions,
} from './stick.ts';
export {
  StickConnection,
  type BackoffOptions,
  type ConnectedInfo,
  type ConnectFailedInfo,
  type ConnectionState,
  type DisconnectedInfo,
  type PortRole,
  type PortSwitchedInfo,
  type StickConnectionEvents,
  type StickConnectionOptions,
} from './connection.ts';
