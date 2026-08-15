# 2 — Spec: Transfer Station (文件中转站) — Yoink-style file shelf & drag overlay rework

# Spec: Transfer Station (文件中转站) — Yoink-style File Shelf & Drag Overlay Rework

## Problem Statement

Files are currently a variant inside the clipboard stack: they share the same storage, the same retention rules (MAX_STACK=10 chunking, historyLimit trimming, autoDeleteHours pruning) and the same stack semantics as text and images. "A trace of what I copied" and "files I want to move somewhere" are different things, and mixing them makes both worse: copied files get evicted like clipboard noise, and files being carried between folders are treated like history. Dragging files out of the panel always copies — there is no move semantics, so relocating a file still means holding the mouse button down while navigating. The drag overlay's save zone is a cramped strip at the top whose copy still says "clipboard shelf", and the panel only appears when the cursor reaches the screen edge, forcing users to drag all the way there.

## Solution

A dedicated Transfer Station (文件中转站): an independent domain with its own lifecycle for files, Yoink-style. Files enter by drag-in or by Ctrl+C (redirected from the clipboard watcher) and are marked by route (拖入 / 剪贴板). Dragging files out honors a user setting — copy or move (default move) — with move implemented as safe staged moving: the file is taken into the station at drag start; a completed drop clears it; a cancelled drag keeps it safe in the station. The drag overlay gains a bottom save zone that fills the panel, marked with a dashed border and contextual labels, and the panel expands as soon as a file drag starts anywhere, not only at the screen edge.

## User Stories

1. As a user, I want to drag files from Explorer onto the Trace panel so that they are held in the Transfer Station as file entries, separate from my clipboard stack.
2. As a user, I want to drag several files at once and see them as one batch entry (chunked at 10) so that the shelf stays tidy.
3. As a user, I want to expand a batch entry into its file members so that I can see and handle individual files.
4. As a user, I want to drag an image file onto the panel so that it becomes a file entry in the station (referencing the original path) rather than a clipboard image.
5. As a user, I want to drag text content (e.g. selected text from a browser) onto the panel so that it is saved as a .txt file entry in the station.
6. As a user, I want to drag image content (e.g. an image from a web page) onto the panel so that it is saved as an image file entry in the station.
7. As a user, I want to press Ctrl+C on files in Explorer and still have them show up in Trace so that my muscle memory keeps working.
8. As a user, I want Ctrl+C file copies to land in the Transfer Station rather than the clipboard stack so that files and clipboard content stay in separate domains.
9. As a user, I want to tell at a glance which station entries came from clipboard copies (a "剪贴板" badge) and which were dragged in, so that I know their provenance.
10. As a user, I want to filter the station by route (全部 / 剪贴板) so that I can focus on one kind of entry.
11. As a user, I want my existing file entries to be migrated into the station on first launch of the new version so that no files disappear silently.
12. As a user, I want station entries to be independent of MAX_STACK=10 and historyLimit so that the station is not evicted like clipboard noise.
13. As a user, I want station entries to follow my existing autoDeleteHours setting (default: never) so that cleanup behaves like the clipboard I already know.
14. As a user, I want to pin an entry so that it is exempt from automatic cleanup forever.
15. As a user, I want pinned entries to render as a compact badge grid (roughly four per row) instead of full-width cards so that many pinned items fit on screen.
16. As a user, I want to expand a pinned badge to see its content at normal size so that compactness never hides information.
17. As a user, I want entries whose original file has disappeared to be marked "文件已消失" so that I can see the shelf is stale.
18. As a user, I want a one-click "clean up stale entries" action so that dead references are easy to remove.
19. As a user, I want a stale entry to revive automatically when its file comes back (e.g. a USB drive is reconnected) so that recoverable references are not lost.
20. As a user, I want drag-out to skip entries whose files are missing so that I never drag broken items.
21. As a user, I want a setting that chooses whether dragging a file out copies it or moves it, so that I can match my workflow.
22. As a user, I want the default drag-out behavior to be "move" so that the common case (relocating files) needs no extra thought.
23. As a user, I want to drag a file out with copy semantics so that the destination receives a copy and the source file and my entry stay untouched.
24. As a user, I want to drag a file out with move semantics so that the file ends up at the destination and leaves its original folder.
25. As a user, I want a completed move to remove the station entry and any held copy so that nothing lingers in the station.
26. As a user, I want to cancel a move-drag (Esc or releasing on empty space) without losing the file — it stays safe in the station and the entry remains usable.
27. As a user, I want to re-drag an in-transit entry after a cancelled move so that I can complete the move on a second attempt.
28. As a user, I want deleting an in-transit entry to send the held file to the Recycle Bin so that the action is recoverable.
29. As a user, I want the guarantee that no action in this feature permanently deletes a file — the worst case is a Recycle Bin copy.
30. As a user, I want the drag overlay's save zone to sit below the task list and fill the remaining panel height (with a minimum height) so that it is always visible and roomy.
31. As a user, I want the save zone to have a dashed border that suggests "drop here", Yoink-style.
32. As a user, I want the save zone to say "拖入即存入文件中转站" so that I know it is the Transfer Station, not the clipboard.
33. As a user, I want contextual save-zone labels: external content says "存入文件中转站", an internal clipboard member says "拖到此处留在剪贴板", and an internal station file says it stays in the station — so that I am never surprised by what the zone does.
34. As a user, I want the panel to expand as soon as I start dragging a file anywhere, so that I don't have to drag all the way to the screen edge.
35. As a user, I want non-file drags (e.g. selecting text) NOT to expand the panel so that the panel stays out of the way during normal mouse work.
36. As a user, I want the panel to retract normally after a drag that never reaches it so that it doesn't linger.
37. As a user, I want to drag files from the station onto task cards to link them as task resources, just like today.
38. As a user, I want to drag a folder into and out of the station so that whole folders can be staged.
39. As a user, I want cross-volume moves to work via a copy+delete fallback so that files on other drives can still be moved.
40. As a user, I want in-transit entries (file held mid-move) to be exempt from automatic cleanup so that auto-clean never destroys a held file.
41. As a user, I want batch-member split (拆出) to remain available through the card's button so that I can still separate files when needed.

## Implementation Decisions

- **Transfer Station domain module** (new, pure logic, zero Electron imports, vitest-tested — mirrors the existing item-store/settings patterns): entry model `{paths, route, pinned, inTransit, capturedAt}`; lifecycle operations (enter via drag-in, enter via clipboard redirect, remove, pin/unpin, member split/merge, revive); retention policy (reuse autoDeleteHours; pinned entries exempt; in-transit entries immune); staleness detection (stat-cached on display, revive on recovery); batch chunking at 10; first-launch migration of legacy file entries (route = 剪贴板; legacy image items stay in the clipboard stack).
- **Clipboard watcher redirect**: file copies (HDROP) no longer enter the clipboard stack; they create station entries with route = 剪贴板. The capture pipeline (PowerShell HDROP list, sourceApp attribution) is unchanged.
- **Drag-in**: file drops become station entries, image files included — the drag-in image re-staging path is removed. A new preload receive capability handles non-file content (text → .txt file, image content → image file), routed through the same station entry path.
- **Drag-out**: new setting `moveMode` (`copy` | `move`, default `move`) in Settings, defaults, clamp and i18n. Copy = unchanged (drag original paths). Move = staged: at drag start the originals rename into a station staging directory (same-volume atomic; cross-volume copy+delete fallback), the entry is marked in-transit, and the drag sources the staged paths. On drag end a heuristic decides success (system drag-end event + cursor over Explorer/desktop) → staged copies move to the Recycle Bin (FOF_ALLOWUNDO) + entry removed; otherwise the entry stays in-transit (re-drag to complete, or delete → Recycle Bin). The staging directory is excluded from startup cleanup and from the self-drop guard.
- **Drag-session state machine** (pure, with thin main-process wiring): inputs = drag start/end events, cursor position facts, source window class, current panel state; outputs = panel expand/retain/retract commands. Detection uses the system drag events via SetWinEventHook (koffi, user32); "file drag" is decided by a source-window-class heuristic (Explorer/desktop classes); DragWindow polling is the fallback if the hook proves unreliable (prototype-verified).
- **Save-zone routing** (extension of the shared drop-action module): external content → station entry (with the content conversion decisions above); internal clipboard members → no-op with "留在剪贴板" label; internal station files → no-op with "留在文件中转站" label; batch-member split stays on the card button — the save zone no longer splits.
- **Drag overlay layout**: save zone at the bottom of the overlay, flex-grow to fill the remaining height with a minimum height, dashed border, centered contextual label; expansion/retraction driven by the drag-session state machine.
- **Files view**: becomes the station interface — existing tabs (all / extension / other) plus a route filter (全部 / 剪贴板) and per-entry route badges; in-transit entries display their state.
- **i18n**: all new copy (save-zone labels, route badges, in-transit state, stale-cleanup action, settings label) across the 30-language catalog.

## Testing Decisions

- What makes a good test: assert observable behavior — entry state transitions (enter / evict / revive / in-transit), decision outputs of the staging function and the state machine, retention edge cases (pinned exemption, in-transit immunity, autoDeleteHours = 0), migration mapping. Not implementation details, not UI internals.
- Modules tested: (1) the Transfer Station domain module — the primary seam carrying the bulk of the cases; (2) the drag-out staging decision function (per setting / kind / path availability); (3) the drag-session state machine (event → command transitions); (4) the drop-action routing (external vs internal → conversion/no-op decisions).
- Not unit-tested (consistent with repo culture): Electron shells (koffi hooks, startDrag, SetWinEventHook), preload, and React components (overlay layout, badges) — verified manually via the dev run.
- Prior art: the repo's 45 pure-logic vitest suites (item-store/settings-adjacent suites, the pure-logic-with-injectable-cache suite, the keyboard-hook/switcher state-machine tests, the drop-action and file-tab lib suites). New suites follow the same pattern.

## Out of Scope

- Electron 36 upgrade (startDrag effectAllowed + DragResult) — clean drop-result semantics; staged move remains the safe implementation until then.
- Pin compact-badge visual design (grid metrics, expansion interaction) — decided in UI iteration against the real render.
- File-drag detection for non-Explorer sources (7-Zip, Total Commander, VS Code, etc.) — edge-dwell expansion remains the fallback for those.
- Modifier-key overrides (Ctrl/Shift) for drag-out effects — not available with Electron 34.
- Undo beyond the Recycle Bin; cross-device transfer; non-Windows platforms.

## Further Notes

- Electron 34 constraints: startDrag has no effect and no callback; the drag-end event is macOS-only; Explorer treats cross-app file drags as copies (OLE contract: the source deletes). These constraints and the heuristic risks are recorded in ADR-0007.
- EVENT_SYSTEM_DRAGDROPSTART/END and the DragWindow fallback need prototype verification on Win10/11 before committing to the detection approach.
- Cross-volume moves copy at drag start — large files may introduce visible latency; evaluate async or degraded handling during implementation.
- The save-zone label for internal station files ("留在文件中转站") is provisional copy, finalized in UI iteration.
- Governing decisions: ADR-0006 (Transfer Station domain separation) and ADR-0007 (reference model with staged move); glossary terms (文件中转站 / 途径 / 在途 / 拖出 / 保存区 / 文件成员) updated in CONTEXT.md.

