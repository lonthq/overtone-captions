// Cleanup on SIGINT and SIGTERM. Node exits on these without running `finally` blocks, which would leave temp
// folders, half-written files and child processes (headless Chrome, ffmpeg) behind.

/** Shell exit codes for a stop by signal (128 + signal number). */
const SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;
export type StopSignal = keyof typeof SIGNALS;

const cleanups = new Set<() => void>();
let listening = false;

/**
 * Runs `cleanup` on SIGINT or SIGTERM, then exits. `cleanup` must be synchronous (kill a child, `rmSync` a path).
 * Returns a function that unregisters it; call that once the resource is gone.
 */
export function onInterrupt(cleanup: () => void): () => void {
  if (!listening) {
    listening = true;
    for (const signal of Object.keys(SIGNALS) as StopSignal[]) process.once(signal, () => stopForSignal(signal));
  }
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/** Runs every cleanup newest first (a child before the folder it writes into), then exits. */
export function stopForSignal(signal: StopSignal, exit: (code: number) => void = (code) => process.exit(code)): void {
  const pending = [...cleanups].reverse();
  cleanups.clear();
  for (const cleanup of pending) {
    try {
      cleanup();
    } catch {
      // best effort: keep going
    }
  }
  exit(SIGNALS[signal]);
}
