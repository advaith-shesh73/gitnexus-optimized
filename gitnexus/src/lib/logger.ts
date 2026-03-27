/**
 * Minimal structured logger for GitNexus.
 *
 * In MCP mode (GITNEXUS_MCP_MODE=1), emits JSON-lines to stderr so output
 * doesn't corrupt the JSON-RPC stdout stream. In CLI mode, emits
 * human-readable messages to stderr.
 *
 * Log level is controlled by GITNEXUS_LOG_LEVEL (debug|info|warn|error).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel = (): number => {
  const envLevel = process.env.GITNEXUS_LOG_LEVEL as LogLevel | undefined;
  return LOG_LEVELS[envLevel ?? 'info'] ?? LOG_LEVELS.info;
};

export function log(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LOG_LEVELS[level] < minLevel()) return;

  if (process.env.GITNEXUS_MCP_MODE) {
    process.stderr.write(
      JSON.stringify({ level, message, ...fields, ts: Date.now() }) + '\n',
    );
  } else {
    const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : '';
    const prefix = tag ? `  ${tag}: ` : '  ';
    process.stderr.write(`${prefix}${message}\n`);
  }
}
