/**
 * In-memory event bus for the task domain (L0 capture, attribution, suggestions).
 *
 * Collectors emit UsageEvents here; consumers either subscribe for real-time
 * delivery (attributor) or read the ring buffer in batches (suggestion engine).
 * The buffer is bounded, FIFO, and never persisted — restart clears it by design.
 *
 * Pure module: no Electron imports, directly unit-testable in vitest node env.
 */
import type { UsageEvent } from '../../shared/types'

/** Ring-buffer capacity for recent usage events. */
export const EVENT_LOG_LIMIT = 1000

export type EventListener = (event: UsageEvent) => void

const listeners = new Set<EventListener>()
const log: UsageEvent[] = []

/** Register a listener; returns an unsubscribe handle. */
export function subscribe(listener: EventListener): () => void {
  listeners.add(listener)
  return () => unsubscribe(listener)
}

export function unsubscribe(listener: EventListener): void {
  listeners.delete(listener)
}

/** Publish one event: ring-buffer first (so subscribers see it via recentEvents), then notify. */
export function emit(event: UsageEvent): void {
  log.push(event)
  if (log.length > EVENT_LOG_LIMIT) log.shift()
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[Events] subscriber threw:', err)
    }
  }
}

/** Newest events in chronological order, capped at `limit` (default: the full buffer). */
export function recentEvents(limit: number = EVENT_LOG_LIMIT): UsageEvent[] {
  return log.slice(Math.max(0, log.length - limit))
}
