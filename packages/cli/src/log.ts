/** Where the CLI writes: `out` = results (stdout), the rest = progress and diagnostics (stderr). `debug` only when OVERTONE_DEBUG is set (not "", "0" or "false"). */
export interface Logger {
  out(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Is OVERTONE_DEBUG set to a true-ish value? */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OVERTONE_DEBUG ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

export const consoleLogger: Logger = {
  out: (msg) => process.stdout.write(`${msg}\n`),
  info: (msg) => process.stderr.write(`${msg}\n`),
  warn: (msg) => process.stderr.write(`warning: ${msg}\n`),
  error: (msg) => process.stderr.write(`error: ${msg}\n`),
  debug: (msg) => { if (debugEnabled()) process.stderr.write(`debug: ${msg}\n`); },
};

/** A logger that records lines for tests: "out: …", "info: …", "warn: …", "error: …" and, with `debug`, "debug: …". */
export function memoryLogger(opts: { debug?: boolean } = {}): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (msg) => lines.push(`out: ${msg}`),
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
    debug: (msg) => { if (opts.debug) lines.push(`debug: ${msg}`); },
  };
}
