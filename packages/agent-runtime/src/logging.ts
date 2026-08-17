/**
 * Structured logging.
 *
 * One JSON object per line, because the only consumer that matters is a log
 * drain doing field queries after a trial went wrong. Levels above `warn` go to
 * stderr so a container platform separates them without a parser.
 *
 * `bigint` is serialised as a decimal string rather than being allowed to throw
 * inside `JSON.stringify`. Chain amounts are the most common thing to log here,
 * and a logger that can crash the request it is describing is worse than
 * useless.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly base: LogFields;
  /** Injectable so tests can capture lines without touching process streams. */
  readonly write?: (level: LogLevel, line: string) => void;
}

function defaultWrite(level: LogLevel, line: string): void {
  const stream = LEVEL_RANK[level] >= LEVEL_RANK.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? defaultWrite;
  const threshold = LEVEL_RANK[options.level];

  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < threshold) return;
    const record = { ts: new Date().toISOString(), level, event, ...options.base, ...fields };
    write(level, JSON.stringify(record, replacer));
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (fields) =>
      createLogger({
        level: options.level,
        base: { ...options.base, ...fields },
        ...(options.write === undefined ? {} : { write: options.write }),
      }),
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
