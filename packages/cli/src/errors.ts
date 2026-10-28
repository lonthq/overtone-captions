/** An error from input or environment (bad flag, missing key, missing ffmpeg): printed without a stack trace. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * A broken invariant inside Overtone: a bug to report, never the user's input. Printed with its stack trace and without
 * the advice to run again.
 */
export class InternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalError';
  }
}

/** The Node error code of a failed fs call ("ENOENT", "EACCES", …), if any. */
export function fsCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
