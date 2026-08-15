# 3 — T1 — Transfer Station domain module (文件中转站域模块)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework.

## What to build

The complete domain logic of the Transfer Station as a pure, Electron-free, vitest-tested module (mirroring the repo's item-store / settings patterns). It owns the entry model — `paths`, route (拖入 drag-in / 剪贴板 clipboard), pinned, in-transit, capturedAt — and all lifecycle operations: enter (with batch chunking at 10), remove, pin / unpin, member split / merge, and revive. It enforces the retention policy (reuse autoDeleteHours; pinned entries exempt; in-transit entries immune) and staleness detection with a cached stat that revives an entry when its file returns. It also provides the first-launch migration transform that maps legacy clipboard-stack file entries into station entries with route = 剪贴板 (legacy image items stay in the stack) and the DTO shape the renderer consumes.

## Acceptance criteria

- [ ] Lifecycle: enter / remove / pin / unpin / member split-merge transition entry state exactly as specified; a batch of more than 10 paths chunks into multiple entries
- [ ] Retention: pruning obeys autoDeleteHours (0 = never); pinned and in-transit entries are never auto-pruned
- [ ] Staleness: missing files are reported stale via a cached stat; a path that returns flips the entry back to live (revive)
- [ ] Migration: legacy file entries map to station entries with route = 剪贴板; image items are left untouched
- [ ] Zero Electron imports; the full suite is green (this is the spec's primary test seam)

## Blocked by

- None — can start immediately

