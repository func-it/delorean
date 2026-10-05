/**
 * One JSON object per line on stdout (`time`, `level`, `msg`, then the fields):
 * what a log collector reads without a parser of its own.
 */
export type Level = 'INFO' | 'WARN' | 'ERROR';

export interface Logger {
  log(level: Level, msg: string, attributes?: Record<string, unknown>): void;
}

export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  return {
    log(level, msg, attributes = {}) {
      write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...attributes }) + '\n');
    },
  };
}

/** Says nothing: tests that do not read the log. */
export const silentLogger: Logger = { log: () => undefined };
