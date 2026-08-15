# 6 — T3 — Drag-out with copy/move semantics (拖出复制/移动)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (implementation decision: drag-out; ADR-0007 reference model with staged move).

## What to build

Dragging files out of the station honors a new setting: copy or move, defaulting to move. Copy behaves exactly as today — drag the original paths, the destination receives a copy, entry and source untouched. Move is staged: at drag start the originals rename into the station's staging directory (same-volume atomic; cross-volume copy+delete fallback), the entry is marked in-transit, and the OS drag sources the staged paths. On drag end a heuristic — the system drag-end event plus the cursor over Explorer/desktop — decides success: on success the staged copies go to the Recycle Bin (FOF_ALLOWUNDO) and the entry is removed; otherwise the entry stays in-transit, re-draggable to complete the move, and deleting it sends the held file to the Recycle Bin. Entries whose files are missing are skipped for drag-out. The staging directory is excluded from startup cleanup and from the self-drop guard. Folders move through the same path. Cross-volume large-file latency is handled explicitly (async or degraded).

## Acceptance criteria

- [ ] New moveMode setting (copy | move, default move): typed, clamped, UI toggle in the behaviour tab, i18n across the catalog
- [ ] Copy mode: destination receives a copy; station entry and source file untouched
- [ ] Move mode: drop on Explorer/desktop completes the move — file at destination, gone from its original folder, entry removed, staging dir empty
- [ ] Cancelled move-drag (Esc / release on empty space): file stays safe in the station, entry in-transit and re-draggable; deleting the entry sends the held file to the Recycle Bin
- [ ] Cross-volume move works via the copy+delete fallback
- [ ] No action in this feature permanently deletes a file — the worst case is a Recycle Bin copy
- [ ] In-transit entries survive automatic cleanup; missing-file entries are never dragged out

## Blocked by

- #3 — T1: Transfer Station domain module (文件中转站域模块)
- #4 — T4a: Drag-detection prototype on Win10/11 (拖拽检测原型) — the drag-end success heuristic uses its hook verdict

