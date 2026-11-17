/**
 * Unit error codes (protocol.md § 5.10).
 */

const ERROR_LABELS: ReadonlyMap<number, string> = new Map([
  [0x01, 'Heater failure'],
  [0x02, 'Too cold to heat'],
  [0x10, 'Motor failure'],
  [0x20, 'Filter to replace'],
  [0x30, 'Air quality sensor failure'],
  [0x31, 'Air quality sensor no. 1 failure'],
  [0x32, 'Air quality sensor no. 2 failure'],
  [0x33, 'Air quality sensor no. 3 failure'],
  [0x34, 'Air quality sensor no. 4 failure'],
  [0x35, 'Air quality sensor no. 5 failure'],
  [0x36, 'Air quality sensor no. 6 failure'],
  [0x37, 'Air quality sensor no. 7 failure'],
  [0x38, 'Air quality sensor no. 8 failure'],
  [0x39, 'Air quality sensor no. 9 failure'],
  [0x3a, 'Several air quality sensors failed'],
  [0x3b, 'Air quality sensor pairing problem'],
  [0x40, 'Unknown Assistant problem'],
  [0x41, 'Assistant temperature error'],
  [0x42, 'Communication lost with the Assistant'],
  [0x43, 'Assistant batteries low'],
  [0x44, 'Several Assistant failures'],
  [0x51, 'Heater outlet probe failure'],
  [0x52, 'Unit intake probe failure'],
  [0x53, "Hydro'R outlet probe failure"],
  [0x55, 'Bypass outlet probe failure'],
  [0x56, 'Bypass outdoor air probe failure'],
  [0x57, 'Bypass attic probe failure'],
  [0x5f, 'Several probes failed'],
  [0x61, 'Bypass error'],
  [0x65, 'Firmware download error'],
  [0x70, 'Multiple errors'],
  [0x81, 'Bypass communication problem'],
  [0x82, 'Bypass communication problem'],
  [0x83, 'Bypass flap stuck'],
]);

/** An active error reported by the unit. */
export interface UnitError {
  readonly code: number;
  /** English label, or `Unknown error 0xNN` when the code is not in the table. */
  readonly label: string;
}

/** True when an error code byte means "no error" (`00` or `FF`). */
export function isNoError(code: number): boolean {
  return code === 0x00 || code === 0xff;
}

/** English label of an error code, or `undefined` for "no error". */
export function errorLabel(code: number): string | undefined {
  if (isNoError(code)) return undefined;
  return (
    ERROR_LABELS.get(code) ?? `Unknown error 0x${code.toString(16).toUpperCase().padStart(2, '0')}`
  );
}
