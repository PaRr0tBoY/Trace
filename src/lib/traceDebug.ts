/**
 * Dev-only debugging surface for driving the panel from the CDP console
 * (window.__traceDebug) without moving the real OS cursor.
 *
 * Attached in src/main.tsx; the whole module is inert in production builds.
 */
import { edge } from './edge'
import { useStore } from '../store/appStore'
import type { View } from '../../shared/types'

export interface TraceDebugState {
  open: boolean
  debugHoldOpen: boolean
  view: View
  settingsOpen: boolean
  pointerEvents: string
  itemCount: number
  selectedTaskId: string | null
}

export interface TraceDebugApi {
  /** Expand the panel and hold it open against hover auto-close. */
  open: () => Promise<void>
  /** Release the hold and collapse the panel. */
  close: () => Promise<void>
  /** Switch the top-level view ('clipboard' | 'files' | 'tasks'). */
  setView: (view: View) => void
  /** Snapshot of the current UI state for assertions. */
  state: () => TraceDebugState
  /** Read diagnostics recorded by window.__diag (drag instrumentation). */
  diag: () => unknown[]
}

declare global {
  interface Window {
    __traceDebug?: TraceDebugApi
    __diag?: string[]
  }
}

function snapshot(): TraceDebugState {
  const s = useStore.getState()
  const blade = document.querySelector('.blade')
  return {
    open: s.open,
    debugHoldOpen: s.debugHoldOpen,
    view: s.view,
    settingsOpen: s.settingsOpen,
    pointerEvents: blade ? getComputedStyle(blade).pointerEvents : 'no-blade',
    itemCount: document.querySelectorAll('.item-main').length,
    selectedTaskId: s.selectedTaskId
  }
}

export function attachTraceDebug(): void {
  if (!import.meta.env.DEV) return
  window.__traceDebug = {
    async open() {
      await edge.setInteractive(true)
      useStore.getState().setDebugHoldOpen(true)
      useStore.getState().setOpen(true)
    },
    async close() {
      useStore.getState().setDebugHoldOpen(false)
      useStore.getState().setOpen(false)
    },
    setView(view) {
      useStore.getState().setView(view)
    },
    state: snapshot,
    diag: () => window.__diag ?? []
  }
}
