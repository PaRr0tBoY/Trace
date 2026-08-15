# 4 — T4a — Drag-detection prototype on Win10/11 (拖拽检测原型)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (implementation decision: drag-session state machine; further notes on detection).

## What to build

A working prototype that detects native OS drag sessions on Windows 10/11, to decide the detection mechanism before the drag-session state machine and the staged-move drag-end heuristic commit to it. Prototype a SetWinEventHook (koffi, user32) listening for EVENT_SYSTEM_DRAGDROPSTART / EVENT_SYSTEM_DRAGDROPEND plus a source-window-class heuristic (Explorer / desktop classes) that classifies a drag as a file drag; evaluate the DragWindow polling fallback if the hook proves unreliable. Record the verdict and the measured behavior as an addendum to ADR-0007.

## Acceptance criteria

- [ ] Prototype runs on a real Win10/11 machine: file drags from Explorer and the desktop emit start/end events reliably, and the class heuristic classifies file vs non-file drags correctly in the common cases
- [ ] Non-file drags (text selection, moving a window) do not false-positive as file drags
- [ ] A documented verdict — hook or DragWindow polling, with measured evidence — is written into ADR-0007
- [ ] The verdict is unambiguous enough that the drag-end success heuristic and the drag-start expansion can build on it directly

## Blocked by

- None — can start immediately

