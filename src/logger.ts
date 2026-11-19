import type { LogFormat, LogLevel } from '@iridium-group/config';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

export type LogWriter = (line: string) => void;

export function createLogger(
  level: LogLevel,
  format: LogFormat,
  write: LogWriter = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit = (at: Exclude<LogLevel, 'silent'>) => (message: string, fields?: object) => {
    if (ORDER[at] > ORDER[level]) return;
    if (format === 'json') {
      write(JSON.stringify({ time: new Date().toISOString(), level: at, message, ...fields }));
      return;
    }
    const extra = fields
      ? ' ' +
        Object.entries(fields)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
    write(`${at.toUpperCase().padEnd(5)} ${message}${extra}`);
  };
  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug') };
}
