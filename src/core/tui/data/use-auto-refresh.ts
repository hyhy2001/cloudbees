/**
 * useAutoRefresh — opt-in background polling for a resource (legacy P13).
 *
 *   useResource() ─► refetch  ◄── useAutoRefresh (timer)
 *
 * Legacy had no live status: a running job kept showing "running" until you
 * pressed F5. This hook periodically calls `refetch` so build status updates on
 * its own — but it is OFF by default and toggled by a keypress, per the design
 * decision (opt-in, not always-on).
 *
 * Backoff policy (pure, unit-tested via `nextInterval`):
 *  - disabled or tab not active        → no timer (Infinity)
 *  - after N consecutive errors        → exponential backoff, capped
 *  - otherwise                         → the base interval
 *
 * The pure core is `nextInterval()`; `useAutoRefresh()` is the React timer
 * wrapper that calls refetch and tracks consecutive errors.
 */

import { useEffect, useRef, useState, useCallback } from "react";

export interface AutoRefreshPolicy {
  /** Base poll interval in ms when healthy. */
  baseMs: number;
  /** Multiplier applied per consecutive error. */
  backoffFactor?: number;
  /** Maximum interval in ms (cap for backoff). */
  maxMs?: number;
}

/**
 * Pure scheduling decision: given enabled/active state and the consecutive
 * error count, return the delay (ms) until the next refetch, or Infinity to
 * mean "do not schedule". Deterministic and React-free.
 */
export function nextInterval(
  enabled: boolean,
  active: boolean,
  consecutiveErrors: number,
  policy: AutoRefreshPolicy,
): number {
  if (!enabled || !active) return Infinity;
  const { baseMs, backoffFactor = 2, maxMs = 60_000 } = policy;
  if (consecutiveErrors <= 0) return baseMs;
  const scaled = baseMs * backoffFactor ** consecutiveErrors;
  return Math.min(scaled, maxMs);
}

export interface UseAutoRefreshOptions {
  /** Whether polling is on (the screen toggles this with a key). Default false. */
  enabled: boolean;
  /** Only poll while the owning tab is active. Default true. */
  active?: boolean;
  /** The (superseding) refetch to call each tick — typically useResource().refetch. */
  refetch: () => Promise<unknown>;
  /** Scheduling policy. */
  policy: AutoRefreshPolicy;
}

export interface AutoRefreshState {
  /** Consecutive failed refetches (drives backoff; resets to 0 on success). */
  consecutiveErrors: number;
}

export function useAutoRefresh({
  enabled,
  active = true,
  refetch,
  policy,
}: UseAutoRefreshOptions): AutoRefreshState {
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errRef = useRef(0);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    errRef.current = consecutiveErrors;
  }, [consecutiveErrors]);

  useEffect(() => {
    let cancelled = false;

    const schedule = () => {
      const delay = nextInterval(enabled, active, errRef.current, policy);
      if (!isFinite(delay)) return; // disabled / inactive — leave it off
      timerRef.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          await refetchRef.current();
          if (cancelled) return;
          errRef.current = 0;
          setConsecutiveErrors(0);
        } catch {
          if (cancelled) return;
          errRef.current += 1;
          setConsecutiveErrors(errRef.current);
        }
        if (!cancelled) schedule();
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      clear();
    };
    // policy is an object literal from the caller; depend on its fields, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, policy.baseMs, policy.backoffFactor, policy.maxMs, clear]);

  return { consecutiveErrors };
}
