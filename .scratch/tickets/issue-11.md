# 11 — T8 — Contract: remove files variant from clipboard stack (收缩)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (ADR-0006 decision 1: files leave the clipboard domain).

## What to build

After every caller has migrated, the clipboard stack stops knowing about files at all: the files variant is removed from the stack domain — storage and signature/dedup, the add-files IPC channel across the four-file contract, preload and renderer store methods, and the shelf drag-out staging for files. The task-layer file resource snapshot is untouched: linking file paths to tasks keeps working. Typecheck and the full test suite are green at the end.

## Acceptance criteria

- [ ] No code path can create a file entry in the clipboard stack — captures, drag-in and IPC all route to the station
- [ ] The files variant and its handling are deleted from the stack domain; no dead code, aliases or fallbacks remain
- [ ] Task resources that reference file paths still work (link, drag, unlink)
- [ ] typecheck and the full vitest suite are green

## Blocked by

- #5 — T2: Station spine: files leave the clipboard stack (中转站脊柱)
- #6 — T3: Drag-out with copy/move semantics (拖出复制/移动)
- #8 — T5: Save-zone rework (保存区改造)

