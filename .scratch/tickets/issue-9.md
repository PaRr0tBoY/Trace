# 9 — T7 — Non-file content drag-in (非文件内容拖入)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (stories 5–6; drag-in decision).

## What to build

Dragging non-file content onto the panel saves it into the station as a file entry: selected text becomes a .txt entry, image content (e.g. an image from a web page) becomes an image file entry, both routed through the same station entry path. This needs a new preload receive capability for non-file drag content.

## Acceptance criteria

- [ ] Dragging selected text onto the panel creates a station .txt entry
- [ ] Dragging image content onto the panel creates a station image-file entry
- [ ] Both behave like any other station entry: expand, drag out, link to a task, split where applicable

## Blocked by

- #5 — T2: Station spine: files leave the clipboard stack (中转站脊柱)

