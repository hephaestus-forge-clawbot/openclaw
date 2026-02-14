import type { CronServiceState } from "./state.js";

const storeLocks = new Map<string, Promise<void>>();

const resolveChain = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    () => undefined,
  );

export async function locked<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);

  // Keep the chain alive even when the operation fails.
  const keepAlive = resolveChain(next);
  state.op = keepAlive;
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}

/**
 * HEPHIE: Lightweight read-only lock that only waits for pending store writes,
 * NOT for long-running job executions tracked via `state.op`.
 *
 * This prevents management API calls (list, status) from blocking behind
 * multi-minute job executions during startup catch-up or normal operation.
 * Read operations only need store consistency (no concurrent writes), not
 * mutual exclusion with execution.
 */
export async function lockedRead<T>(state: CronServiceState, fn: () => Promise<T>): Promise<T> {
  const storePath = state.deps.storePath;
  const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
  // Only wait for store-level writes to complete, skip state.op (execution chain).
  const next = resolveChain(storeOp).then(fn);

  // Track the store lock so concurrent writes still serialize against us.
  const keepAlive = resolveChain(next);
  storeLocks.set(storePath, keepAlive);

  return (await next) as T;
}
