/**
 * Drag-out staging decisions (ADR-0007 M-a) — pure module, zero Electron
 * imports, vitest-tested.
 *
 * Two seams:
 *
 * 1. planDragOut — whether a drag-out stages the entry's files into the
 *    station staging area (move mode) or passes the original paths through
 *    (copy mode), and when the drag must be skipped entirely (missing
 *    files). The OS file operations themselves (rename / copy+delete) live
 *    in the main-process layer (drag.ts); this module only decides.
 *
 * 2. decideDragEnd — the drag-end success heuristic (T4a verdict, layered):
 *    - primary: the system drag-end event (EVENT_SYSTEM_DRAGDROPEND, 0x10)
 *      was seen → success iff the cursor sits over an Explorer/desktop
 *      window (class or exe), else cancel;
 *    - fallback: no 0x10 but the DragWindow class window disappeared →
 *      the drag ended without a drop signal (Esc / release on empty space)
 *      → cancel, the held file stays staged in the station;
 *    - watchdog: no end signal within the timeout → force-ended as cancel
 *      so a stalled session can never wedge. N = 30s initial per T4a,
 *      to be calibrated against real drag data.
 *
 * Both directions are safe by construction (ADR-0007 §5): cancel keeps the
 * file in the station; a wrong success only ever sends the staged copy to
 * the Recycle Bin, never permanently deletes anything.
 */
import type { MoveMode } from '../../shared/types'

/**
 * Window classes treated as Explorer / desktop drop targets (T4a verdict).
 * GetClassNameW is case-sensitive; these are the exact class names.
 */
export const EXPLORER_WINDOW_CLASSES = [
  'CabinetWClass', // Explorer folder windows
  'XamlExplorerHostIslandWindow', // Win11 22H2+ Explorer host (real-drag data 2026-08-14)
  'SysListView32', // file list views (Explorer, desktop list view)
  'Progman', // desktop root
  'WorkerW', // desktop wallpaper host (modern Windows)
  'Shelldll_DefView' // shell desktop view
] as const

/** Explorer's process image name (drop-target exe check, case-insensitive). */
export const EXPLORER_PROCESS = 'explorer.exe'

/**
 * Stall watchdog: a drag in flight longer than this without an end signal is
 * force-ended (cancel). Initial value 30s per the T4a verdict; calibrate
 * against real drag data once the manual sessions are collected.
 */
export const DEFAULT_DRAG_TIMEOUT_MS = 30_000

export type DragOutPlan =
  /** Drag the original paths; entry and source untouched (copy semantics / non-files). */
  | { action: 'pass-through' }
  /** Move semantics: stage these paths (in-transit re-drag = already staged, drag as-is). */
  | { action: 'stage'; paths: string[] }
  /** At least one path is missing: never drag (spec story 20). */
  | { action: 'skip' }

export interface PlanDragOutInput {
  moveMode: MoveMode
  /** ItemData kind ('files' is the only stageable kind; text/images ride the temp-copy path). */
  kind: string
  /** The paths this drag would source (whole entry, or the dragged member subset). */
  paths: string[]
  exists: (p: string) => boolean
}

export function planDragOut(input: PlanDragOutInput): DragOutPlan {
  if (input.kind !== 'files') return { action: 'pass-through' }
  if (input.moveMode === 'copy') return { action: 'pass-through' }
  if (input.paths.length === 0) return { action: 'skip' }
  // Move takes the files away at drag start: every path must be present, a
  // missing file would silently drop it from the entry. The subset drag is
  // rejected the same way — no partial takeovers.
  for (const p of input.paths) {
    if (!input.exists(p)) return { action: 'skip' }
  }
  // In-transit re-drag: the paths are already inside the staging area;
  // 'stage' with the same list is a no-op restage — the caller drags them
  // as-is and still expects the drag-end completion flow.
  return { action: 'stage', paths: input.paths }
}

export type DragEndVerdict = 'success' | 'cancel'

export interface DragEndInput {
  /** EVENT_SYSTEM_DRAGDROPEND (0x10) was seen. */
  dragEndSeen: boolean
  /** WindowFromPoint class under the cursor at drag end (undefined = unreadable). */
  cursorClass?: string
  /** Process exe of the window under the cursor at drag end. */
  cursorExe?: string
  /** The DragWindow class window was seen during the drag and is gone now, without 0x10. */
  dragWindowGone?: boolean
  /** Milliseconds since the drag started. */
  elapsedMs: number
  /** Timeout override (tests); defaults to DEFAULT_DRAG_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * True when the window under the cursor looks like an Explorer/desktop drop
 * target: an exact explorer window class, or the process is explorer.exe.
 * A class read that failed (undefined) can never confirm a drop target.
 */
export function isExplorerTarget(cursorClass?: string, cursorExe?: string): boolean {
  if (cursorClass) {
    const cls = cursorClass.trim()
    if ((EXPLORER_WINDOW_CLASSES as readonly string[]).includes(cls)) return true
  }
  if (cursorExe) {
    const exe = cursorExe.trim().toLowerCase()
    if (exe === EXPLORER_PROCESS) return true
  }
  return false
}

export function decideDragEnd(input: DragEndInput): DragEndVerdict {
  if (input.dragEndSeen) {
    return isExplorerTarget(input.cursorClass, input.cursorExe) ? 'success' : 'cancel'
  }
  if (input.dragWindowGone) return 'cancel'
  const timeout = input.timeoutMs ?? DEFAULT_DRAG_TIMEOUT_MS
  if (input.elapsedMs >= timeout) return 'cancel'
  // No end evidence at all: never claim success without a drop target.
  return 'cancel'
}

/**
 * Case-insensitive check whether `p` lives under `dir` (Windows paths are
 * case-insensitive; separators may be mixed). Used by the self-drop guard
 * and the "already staged" detection.
 */
export function isPathUnder(dir: string, p: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
  const d = norm(dir)
  const path = norm(p)
  return path === d || path.startsWith(d + '\\')
}
