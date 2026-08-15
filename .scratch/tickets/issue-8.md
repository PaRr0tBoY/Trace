# 8 — T5 — Save-zone rework (保存区改造)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (stories 30–33; save-zone routing decision).

## What to build

The drag overlay's save zone moves to the bottom of the overlay, flex-grows to fill the remaining height (with a minimum height), and gets a dashed border that reads as "drop here". Its label is contextual: external content says "存入文件中转站"; an internal clipboard member says "拖到此处留在剪贴板" and does nothing on drop; an internal station file likewise says it stays in the station and does nothing. The save zone stops being a split surface — batch-member split remains only on the card button. The routing decisions (external → station entry; internal → labelled no-op) live in the shared drop-action module.

## Acceptance criteria

- [ ] Save zone renders at the bottom of the overlay, fills the remaining height (min height respected), dashed border
- [ ] Dropping external content on the save zone adds a station entry (composes with the content-conversion rules)
- [ ] Dropping an internal clipboard member or station file on the save zone is a no-op with the contextual label shown
- [ ] Split is no longer reachable from the save zone; the card's split button still works
- [ ] New copy is i18n'd across the catalog

## Blocked by

- #5 — T2: Station spine: files leave the clipboard stack (中转站脊柱)

