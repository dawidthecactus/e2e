/**
 * Where a rejection nobody in the process handled goes while `run_code` runs
 * code: the code is ordinary JavaScript in the server's process, so a promise
 * it makes and leaves rejects on the process, not on the call. Kept apart
 * from `run-code.ts` so a process entry can ask without loading the tool.
 */

import { classifyError } from '@e2e-dev/core/lib/internal/errors';

const running = new Set<(cause: unknown) => void>();
let ranBefore = false;

export const runCodeCalls = {
  /** Registers a running call, told of each such rejection until the returned function runs. */
  begin(tell: (cause: unknown) => void): () => void {
    running.add(tell);
    ranBefore = true;
    return () => void running.delete(tell);
  },
};

/**
 * Takes a rejection nobody handled while code runs here: a promise the code
 * made and left fails the calls that are running. False when none is, so the
 * caller asks who else may have made it.
 */
export function claimRunCodeRejection(cause: unknown): boolean {
  for (const tell of running) tell(cause);
  return running.size > 0;
}

/**
 * Takes a rejection that settled after the `run_code` call that most likely
 * made it ended, which is the operator's to read. False before the first
 * call, so the caller treats it as an uncaught error of its own.
 */
export function claimLateRunCodeRejection(cause: unknown, warn: (message: string) => void): boolean {
  if (!ranBefore) return false;
  warn(`a promise rejected after the run_code call that made it ended: ${classifyError(cause).message}`);
  return true;
}
