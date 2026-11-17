/**
 * Values kept by the app across restarts (mqtt-interface.md § 8): boost and holiday durations
 * and the learned Assistant ID, in a small JSON file written atomically (temp file + rename).
 */
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { normalizeId, type EnOceanId } from '../hex.ts';
import { noopLogger, type Logger } from '../logger.ts';
import { errorMessage } from './log.ts';

/** Range and default of the boost duration (minutes). */
export const BOOST_DURATION = { min: 5, max: 200, default: 30 } as const;
/** Range and default of the holiday duration (days). */
export const HOLIDAY_DURATION = { min: 1, max: 254, default: 7 } as const;

/** The persisted values. */
export interface PersistentState {
  /** Minutes, 5–200. */
  readonly boostDuration: number;
  /** Days, 1–254. */
  readonly holidayDuration: number;
  /** Assistant ID learned from the radio (not the configured one). */
  readonly learnedAssistantId: EnOceanId | undefined;
}

/** Defaults used for a missing or corrupt file. */
export const DEFAULT_STATE: PersistentState = {
  boostDuration: BOOST_DURATION.default,
  holidayDuration: HOLIDAY_DURATION.default,
  learnedAssistantId: undefined,
};

/** What the bridge needs from a state store. */
export interface StateStoreLike {
  readonly state: PersistentState;
  update(patch: Partial<PersistentState>): Promise<void>;
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Converts the file content into a state; invalid fields fall back to their defaults and are
 * reported in `problems`.
 */
export function parseState(raw: unknown): { state: PersistentState; problems: string[] } {
  const problems: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { state: DEFAULT_STATE, problems: ['not a JSON object'] };
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const pick = (key: string, min: number, max: number, fallback: number): number => {
    if (record[key] === undefined) return fallback;
    const value = integerIn(record[key], min, max);
    if (value === undefined) problems.push(`invalid ${key} ${JSON.stringify(record[key])}`);
    return value ?? fallback;
  };
  let learnedAssistantId: EnOceanId | undefined;
  const id = record.assistant_id;
  if (typeof id === 'string') {
    try {
      learnedAssistantId = normalizeId(id);
    } catch {
      problems.push(`invalid assistant_id ${JSON.stringify(id)}`);
    }
  } else if (id !== undefined && id !== null) {
    problems.push(`invalid assistant_id ${JSON.stringify(id)}`);
  }
  return {
    state: {
      boostDuration: pick(
        'boost_duration',
        BOOST_DURATION.min,
        BOOST_DURATION.max,
        BOOST_DURATION.default,
      ),
      holidayDuration: pick(
        'holiday_duration',
        HOLIDAY_DURATION.min,
        HOLIDAY_DURATION.max,
        HOLIDAY_DURATION.default,
      ),
      learnedAssistantId,
    },
    problems,
  };
}

/** Serialises a state as the file content. */
export function serializeState(state: PersistentState): string {
  const content: Record<string, unknown> = {
    boost_duration: state.boostDuration,
    holiday_duration: state.holidayDuration,
  };
  if (state.learnedAssistantId !== undefined) content.assistant_id = state.learnedAssistantId;
  return `${JSON.stringify(content, null, 2)}\n`;
}

/**
 * JSON file store. {@link load} tolerates a missing or corrupt file (defaults, logged);
 * {@link update} writes a temporary file then renames it over the real one, one write at a time.
 */
export class StateStore implements StateStoreLike {
  readonly path: string;
  readonly #logger: Logger;
  #state: PersistentState = DEFAULT_STATE;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string, logger: Logger = noopLogger) {
    this.path = path;
    this.#logger = logger;
  }

  get state(): PersistentState {
    return this.#state;
  }

  /** Loads the file; keeps the defaults when it is missing or unreadable. */
  async load(): Promise<PersistentState> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#logger.warn(`Cannot read ${this.path}, using defaults: ${errorMessage(error)}`);
      }
      this.#state = DEFAULT_STATE;
      return this.#state;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.#logger.warn(`${this.path} is corrupt, using defaults: ${errorMessage(error)}`);
      this.#state = DEFAULT_STATE;
      return this.#state;
    }
    const { state, problems } = parseState(raw);
    for (const problem of problems) this.#logger.warn(`${this.path}: ${problem}, using default`);
    this.#state = state;
    return state;
  }

  /** Applies `patch` and writes the file. Write errors are logged, not thrown. */
  update(patch: Partial<PersistentState>): Promise<void> {
    this.#state = { ...this.#state, ...patch };
    const content = serializeState(this.#state);
    this.#writing = this.#writing.then(() => this.#write(content));
    return this.#writing;
  }

  async #write(content: string): Promise<void> {
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.path);
    } catch (error) {
      this.#logger.error(`Cannot write ${this.path}: ${errorMessage(error)}`);
      await unlink(temp).catch(() => undefined);
    }
  }
}
