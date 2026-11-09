import { TransientError } from "./errors.js";

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (error: TransientError, attempt: number, waitMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Espera exponencial com jitter; respeita Retry-After quando o servidor manda. */
export function backoffMs(attempt: number, o: Pick<RetryOptions, "baseMs" | "maxMs" | "random">, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, o.maxMs);
  const exp = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + (o.random ?? Math.random)() / 2));
}

/** Repete só TransientError. Qualquer outro erro sobe na hora. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof TransientError) || attempt >= o.attempts) throw error;
      const wait = backoffMs(attempt, o, error.retryAfterMs);
      o.onRetry?.(error, attempt, wait);
      await (o.sleep ?? sleep)(wait);
    }
  }
}

/** Garante um intervalo mínimo entre ações no sistema alvo. */
export function createThrottle(minIntervalMs: number, now: () => number = Date.now, wait = sleep) {
  let last = -Infinity;
  return async () => {
    const delta = now() - last;
    if (delta < minIntervalMs) await wait(minIntervalMs - delta);
    last = now();
  };
}
