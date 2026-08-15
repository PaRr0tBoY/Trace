# 5 — T2 — Station spine: files leave the clipboard stack (中转站脊柱)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework.

## What to build

The Transfer Station goes live end to end: files stop living in the clipboard stack and live in the station. On first launch of the new version, existing file entries migrate into the station (route = 剪贴板) so nothing disappears silently. Dragging files from Explorer onto the panel adds them to the station — image files included, the drag-in re-staging path is gone — and pressing Ctrl+C on files in Explorer lands them in the station too, with the HDROP capture pipeline and source-app attribution unchanged. The station persists, broadcasts its state to the renderer, and exposes its operations over typed IPC. The files view becomes the station interface: it renders station entries with the existing all / extension / other tabs, batch entries expand into file members, the split button and existing member actions (copy to clipboard, reveal) keep working, and entries that arrived via clipboard copies carry a "剪贴板" route badge. Dragging station entries onto task rows or suggestion cards keeps linking them as task resources exactly as today. Folder drag-in is included.

## Acceptance criteria

- [ ] First launch after upgrade: every legacy file entry appears in the station with the clipboard route; no file disappears silently
- [ ] Dropping one or several files on the panel creates station entries (batches chunked at 10), image files referenced by their original path
- [ ] Ctrl+C on files in Explorer creates station entries with the clipboard route; text and image copies still go to the clipboard stack
- [ ] The files view renders station entries: tabs, member expansion, split, copy / reveal member actions unchanged
- [ ] Dragging a station entry onto a task row or suggestion card links it as a task resource, as today
- [ ] Station state survives restart and reaches the renderer over typed IPC

## Blocked by

- #3 — T1: Transfer Station domain module (文件中转站域模块)

