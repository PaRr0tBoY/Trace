# 10 — T6 — Station UI: route filter, pinned grid, staleness (中转站 UI)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (stories 9, 10, 14–19, 40).

## What to build

The files view grows the full station interface: a route filter (全部 / 剪贴板) next to the existing tabs; pinned entries render as a compact badge grid (roughly four per row) that expands to normal size on interaction; entries whose original file has disappeared are marked "文件已消失" with a one-click cleanup action; a stale entry revives automatically when its file returns; in-transit entries display their state. All new copy is i18n'd.

## Acceptance criteria

- [ ] Route filter narrows the station to all or clipboard-route entries; per-entry route badges shown
- [ ] Pinned entries render as a compact grid and expand to normal size; pin / unpin keeps working
- [ ] Missing-file entries show "文件已消失"; one-click cleanup removes stale entries; entries revive automatically when the file returns
- [ ] In-transit entries display their state
- [ ] New copy is i18n'd across the catalog

## Blocked by

- #5 — T2: Station spine: files leave the clipboard stack (中转站脊柱)
- #6 — T3: Drag-out with copy/move semantics (拖出复制/移动) — in-transit state display

