<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="Trace — a work tracker built on the clipboard shelf: an activity stream of apps and copies is cut into task segments with confidence scores" />
</p>

<p align="center">
  <strong>Trace is not another clipboard manager — it is a work tracker that lives inside one.</strong>
  On the edge of your screen, the shelf collects what you copy. Underneath it, Trace watches the
  whole slice of work: the apps you switch between, the windows you work in, the clips you gather.
  It cuts that slice into <strong>tasks</strong>, tracks their progress, and keeps every resource —
  apps, windows, clips, and files — attached to the task it belongs to.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-3b82f6?style=flat&logo=windows&logoColor=white" alt="Platform: Windows 10/11" />
  <img src="https://img.shields.io/badge/electron-34-9ca3af?style=flat" alt="Electron 34" />
  <img src="https://img.shields.io/badge/typescript-5-3b82f6?style=flat&logo=typescript&logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/tests-1111%20unit-14b8a6?style=flat" alt="1111 unit tests" />
  <img src="https://img.shields.io/badge/languages-31-6b7280?style=flat" alt="31 languages" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-6b7280?style=flat" alt="Apache-2.0" /></a>
</p>

<p align="center">
  <a href="#what-is-trace">What is Trace</a> ·
  <a href="#demos">Demos</a> ·
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#status">Status</a> ·
  <a href="#security">Security</a>
</p>

---

## What is Trace

Most clipboard managers treat what you copy as a list. Trace treats it as **evidence of what you are working on**.

Trace looks at your work from a cross-section: at any moment it knows the foreground app, the window title, and the clips you copy. Over time that cross-section becomes a stream — and the stream is cut into **tasks** at cluster boundaries, the way you would segment a long session into "write the API docs", "fix the drag icon", "review the design". Each segment becomes a candidate task card with a confidence score, the apps and windows involved, and the clipboard material attached.

The **task** is the hub, not the clipboard item. A task collects the windows you worked in (one click jumps back to them), the apps involved, and the clips you explicitly bind to it. Its state machine — one running task at a time, waiting, paused, completed — tracks progress honestly, with every transition annotated by who made it and why.

The shelf itself now hosts **four domains** on one hover-to-open blade: the **clipboard stack** (text and images), the **transfer station** (files, kept apart because paths have a different lifecycle than content), **tasks**, and **notes** — a Markdown editor that lives where your work happens.

None of this asks you to do anything extra. The observation is built directly on the clipboard mechanism you already use: the hover-to-open shelf on the screen edge is at once the **capture point**, the **resource repository**, and the **operation surface**. You copy, you drag, you work — Trace segments and suggests in the background, and the AI pass (titles, rationale, memory) is optional, off by default, and explainable.

**This repository is a fork of [Edge-Drop](https://github.com/Deepender25/Edge-Drop).** The clipboard shelf is inherited and kept as the base; the task layer, the transfer station, and the notes domain are rebuilt on top, with upstream's branding and sponsor plumbing removed. Its auto-update machinery was replaced with one pointed at this repository's own releases (see [Privacy](#privacy)).

> **Platform:** Windows 10/11 only. The drag-out pipeline uses Win32 OLE and the edge trigger uses transparent-window cursor polling — there is no macOS or Linux port.

---

## Demos

> All demos are silent autoplay loops. Hover to scrub, right-click → open in new tab for full size.

<table>
  <tr>
    <td width="50%" align="center"><b>1. Welcome to Trace</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/118d59cc-9821-4da1-9424-ea9bc1b6e548" width="100%" autoplay loop muted playsinline></video>
    </td>
    <td width="50%" align="center"><b>2. Collect Anything</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/8daa18a7-d023-4e93-9f17-c30791a7c41c" width="100%" autoplay loop muted playsinline></video>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><b>3. Drag & Drop Anywhere</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/ac8bc411-0827-460c-828c-0799f4cee4d8" width="100%" autoplay loop muted playsinline></video>
    </td>
    <td width="50%" align="center"><b>4. Explore File Stacks</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/b1e47a2b-41d2-4958-8e42-4fefcaa8b26b" width="100%" autoplay loop muted playsinline></video>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><b>5. Ungroup & Split Stacks</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/e41eb9f8-62b0-4525-a28a-2bacafd0bb8c" width="100%" autoplay loop muted playsinline></video>
    </td>
    <td width="50%" align="center"><b>6. Combine & Merge Items</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/cee7d5f7-658b-433a-9fa0-6592a5a75fa4" width="100%" autoplay loop muted playsinline></video>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><b>7. Preview Flyout</b><br/><br/>
      <video src="https://github.com/user-attachments/assets/fe5a8b47-08c6-4d32-92b6-bb4e0446a82a" width="100%" autoplay loop muted playsinline></video>
    </td>
  </tr>
</table>

---

## Features

### Watching your work — segmentation

- **A cross-section, not a log.** A 600 ms clipboard watcher and a foreground-window listener feed one event stream: app switches, window titles, copies. No separate capture ritual — the shelf already exists.
- **Evidence timeline.** Events are deduplicated (FNV-1a signatures, sampled BGRA hashes for images), privacy-filtered, and persisted so any suggestion can be traced back to what was seen.
- **Quiet-period clustering.** During silences, the clusterer segments the stream into activities. Each segment becomes a candidate task card: title, confidence, the apps and windows involved, and the clipboard items it carries.
- **Accept, merge, or ignore.** Accept opens the guided editor; a candidate that matches an existing task merges into it instead. Ignoring writes the signature to a blocklist so the same suggestion does not return.

### Tasks as the hub

- **Guided editor.** Title, an app grid (most recently used first), and a clipboard material picker. When a provider is configured, the AI suggests a title and a one-line rationale; without one, the editor falls back to an algorithmic title — the flow never blocks on AI.
- **Linked windows.** Each task remembers the foreground window it was created from. "Open app" jumps back to that window, or the app's latest window, or launches the app when it is gone.
- **Explicit resource binding.** Drag a shelf item or a station file onto a task card or the binding panel to attach it as linked content. Clips never auto-attach — linkage is a decision, not a side effect.
- **Living resources.** Task resources stay usable: drag a text/image resource out to any app via OLE, or click it to copy it back to the top of the clipboard stack; file resources drag out as the real paths. A resource that was evicted from history degrades to a "dead" placeholder instead of silently vanishing.
- **Honest states.** One task runs at a time (single `RUNNING`); `WAITING` means the system infers you paused, `PAUSED` means you explicitly did, `COMPLETED` and `ARCHIVED` end the lifecycle. Every transition is annotated with its source (user / system) and reason — the UI can tell "you paused it" apart from "the system thinks you are resting".
- **Task detail.** Linked apps and windows, bound content, confidence, and the creation reason — why this task was suggested in the first place.

### Notes on the shelf

- **A Markdown editor where your work happens.** Type in a live-rendering CodeMirror editor: headings, quotes, task lists and links render as you type, with inline markers hidden Obsidian-style and checkboxes that actually toggle.
- **Write-first or read-first.** Single-note mode opens the editor focused (auto-focus, on by default); turn it off for read-first mode, or switch to list mode with pin and fold. A reading-mode toggle in the top bar swaps the editor for a clean rendered view.
- **Yours, locally.** Notes persist to disk with debounced writes, survive restarts, and remember the current note and caret across opens; prev/next steppers move between notes without leaving the keyboard. Destructive actions (like clear-all) require a two-step arm/confirm.

### The transfer station — files

- **Files are paths, not snapshots.** Files stopped living in the clipboard stack: copies and drag-ins land in the transfer station, persisted as path references with pinned and in-transit flags, pruned on the same auto-delete timer as the stack (pinned and in-transit entries are exempt). Legacy file entries migrate silently on first launch.
- **Drag detection that stays out of the way.** OS-level hooks (`SetWinEventHook` in a utility process) recognize a file drag from any app: while dragging, a compact indicator appears instead of the panel, and the blade expands only when the cursor approaches — a drag across the edge never yanks a panel open.
- **Two drag-out modes.** *Copy* leaves the original in place. *Move* stages the original into the station at drag start and completes the move on drop — a cancelled drag keeps the file safe in the station. Nothing in the station domain is ever hard-deleted: deletions go through the Windows recycle bin.
- **Everything becomes a file.** Drag text or images in from anywhere — they are written out as real files (UTF-8 BOM text, so Notepad and Word read the encoding right) and enter the station like any other drop.
- **Staleness-aware.** An entry whose file was moved or deleted elsewhere is flagged with a banner and auto-revives when the file returns. The unified files view has extension tabs, a route filter (clipboard vs. drag-in), and pinned/in-transit badges.

### AI as an optional pass

- **Works without AI.** The whole pipeline runs on deterministic clustering; LLM annotation (title + rationale) is a separate pass that only happens when you configure a provider chain (any OpenAI-compatible endpoint) in Settings → Tasks.
- **Explainable.** Every suggestion cites what it saw and why. The task detail view shows the creation reason; `ai-log.jsonl` records each chat call and algorithm output for inspection.
- **OCR context.** When a provider is set, an OCR pass on the foreground window may add screen text to the suggestion context. OCR output is never shown in the UI and never persisted.
- **Long-term memory.** Accepted tasks feed a memory store (episode / entity / fact) that nudges the confidence of future segments; candidates sit in the memory panel in Settings until you confirm or dismiss them.

### The zero-friction base — the clipboard shelf

- **Hover to open.** A 3px hysteresis zone with a 120 ms dwell opens the panel; moving away closes it with a grace period. The collapsed window is 100% click-through, so the desktop stays fully usable. Hover can be disabled in Settings — `Alt+C` opens the panel instead.
- **Pick your monitor and edge.** Left or right edge, any display; the choice survives reboots (session ID → geometry match → nearest → primary fallback). Fullscreen apps (games, video, presentations) suppress the trigger automatically via native `SHQueryUserNotificationState` detection.
- **Multi-format clipboard.** Plain text, rich HTML, URLs, raw images, and multi-file selections. Duplicate copies are merged by SHA-256 content hash — dedup survives restarts — then bumped to the top and counted.
- **Stacks.** Multi-file drag-ins and multi-image copies group into stacks (max 10) with expand / split / merge, plus a preview flyout for single files and collections.
- **Native OLE drag-out.** Real file handles, not simulated drags: text goes out as a temp UTF-8 file, images and file stacks as files with rendered drag ghosts. Drag files *in* to add them to the transfer station.
- **Alt+Tab switcher.** Hold `Alt+Tab` to replace the system window list with a searchable switcher: tap to flip to the next MRU window, hold for the list, press `Enter` to pin a type-to-search session, `Esc` or click-outside to cancel. Windows of the same app can group into one row.
- **Smart collapse.** When the notes editor or a pinned switcher search holds focus, passive signals — external wheel scroll, an external copy, 5 s of idle, lock/suspend — auto-collapse the panel or abandon the session instead of pinning it open. Toggleable in Settings.
- **31 languages, 5 themes.** Full UI dictionaries for 31 languages (Persian joined in the v0.2.7 upstream merge) with RTL layout for Arabic and Hebrew; Graphite / Cobalt / Verdigris / Amber / Violet accent themes applied to the panel, drag ghost, and copy indicator.
- **Motion & performance.** Motion levels with a blade-open bounce (double bounce on "extended"), edge flares that ride the opening animation, crossfade view transitions, and app icons prewarmed from a disk cache.
- **Battery-aware.** Cursor polling slows on battery power; sleep and unlock events pause the clipboard watcher so no false copy indicators fire when you open the laptop lid.

### Privacy

- **Three privacy planes.** Capture (foreground events), AI (anything leaving the machine), and Memory (what is retained) are enforced by a pure gate module — capture can be switched off entirely, AI only runs when you configure a provider, and denied data never reaches the model, not even as context. A denial always carries a reason for the trace log.
- **Sensitive formats skipped.** Password managers and dictation tools (Bitwarden, KeePass, 1Password, `ExcludeClipboardContentFromMonitorProcessing`, …) are matched case-insensitively and never captured.
- **Incognito and auto-delete.** One click suspends clipboard polling; auto-delete timers (1h / 6h / 24h / 7d) and clear-unpinned-on-restart keep history bounded.
- **No telemetry.** The only network calls are the update check, the What's New release check, and the AI providers you configure. GitHub builds check for updates at startup and download in the background (Settings toggle, default on); Microsoft Store builds never self-update — their updates flow through the Store.

---

## How it works

The core loop, from raw events to adopted tasks — the same stream that fills the shelf is what the tracker segments:

<p align="center">
  <img src="assets/readme/pipeline.svg" width="100%" alt="Activity pipeline: capture clipboard and foreground events, persist an evidence timeline, cluster into activities with confidence, decide proposals, then adopt tasks and feed memory — with privacy gates and traceability cutting across" />
</p>

Three isolated processes follow a strict contract:

1. **Main** (`electron/main/`) — Node.js runtime. Owns the clipboard watcher, the OLE drag pipeline, the transfer station, notes, the updater, window/edge handling, and the task & suggestion engines. It is the single source of truth: every change pushes a full state snapshot to the renderer.
2. **Preload** (`electron/preload/`) — sandboxed bridge exposing `window.edge`, typed against `shared/ipc.ts` (`InvokeMap` / `EventMap` / `SendMap`) and `shared/bridge.ts` (`EdgeApi`). A new channel touches four files: contract, interface, preload implementation, and main handler.
3. **Renderer** (`src/`) — React 18 UI. A Zustand store is a pure view cache of main's pushes; the renderer never persists anything itself.

Windows-specific integration points: koffi (FFI) reads native clipboard formats, detects fullscreen apps, and drives the recycle bin (`SHFileOperationW`); a utility process runs the OS hooks that must not live in the main process — the keyboard hook and drag detection (`SetWinEventHook`); PowerShell handles HDROP file lists (bypassing Electron's single-file limit) and simulated paste; drag ghosts are rendered server-side with `@resvg/resvg-js`. The SuggestionEngine, the station, and the notes domains are pure modules — everything they need is injected, so vitest drives them with a fake clock and real stores.

---

## Quick Start

### Install

Trace is Windows 10/11 only. Every channel installs the same NSIS build, and the app self-updates from GitHub Releases via electron-updater:

| Channel | Command |
|---|---|
| **GitHub Releases** (recommended) | Download `Trace-Setup-*.exe` from the [latest release](https://github.com/PaRr0tBoY/Trace/releases/latest) |
| **npm** | `npm install -g --allow-scripts=@acidevv/trace @acidevv/trace` — or try it once with `npx --yes @acidevv/trace` |
| **Scoop** (own bucket, live) | `scoop bucket add trace https://github.com/PaRr0tBoY/Trace` then `scoop install trace` |
| **Scoop** (Extras) | `scoop install trace` — awaiting [PR #18532](https://github.com/ScoopInstaller/Extras/pull/18532) |
| **winget** | `winget install PaRr0tBoY.Trace` — awaiting [PR #417780](https://github.com/microsoft/winget-pkgs/pull/417780) |
| **Chocolatey** | `choco install trace` — awaiting moderation on chocolatey.org |

> The npm package is a small bootstrap, not the app itself: its `postinstall` downloads the latest installer from GitHub Releases, verifies the SHA-512 against the release's `latest.yml`, and runs it silently (`/S`). No binaries are bundled in the package.

### Prerequisites

- **Node.js** 18+ (npm 11+ blocks postinstall scripts by default)
- **Windows 10/11**

### Run from source

```bash
git clone https://github.com/PaRr0tBoY/Trace.git
cd Trace
npm install
npm run dev    # Electron + Vite HMR
```

> [!NOTE]
> If `npm install` finishes but the first launch fails with missing binaries, approve the postinstall scripts and retry: `npm approve-scripts electron esbuild koffi better-sqlite3 node-llama-cpp`

### Verify, test, package

```bash
npm run typecheck   # tsc --noEmit for both node and web configs
npm test            # 1111 unit tests (vitest, 59 files)
npm run package     # Windows NSIS installer into dist/
npm run build:store # Windows MSIX for the Microsoft Store
```

> [!NOTE]
> If packaging fails with `EBUSY: resource busy or locked`, close any running Trace instance first: `taskkill /F /IM electron.exe /T`

---

## Project structure

```
├─ shared/                 IPC contracts & domain types
│  ├─ ipc.ts               InvokeMap / EventMap / SendMap channel definitions
│  ├─ bridge.ts            EdgeApi interface implemented by preload
│  ├─ types.ts             ItemData, Task, Note, Settings, DTOs
│  ├─ station.ts           transfer-station entry types
│  └─ idle.ts              shared idle guard (smart collapse)
├─ electron/
│  ├─ main/                window & edge trigger, drag (OLE), dragDetect +
│  │                       dragHost (utility-process OS hooks), smartCollapse,
│  │                       suggestionEngine (lifecycle controller), provider
│  │                       chain + decision provider, currentTaskController,
│  │                       MemoryStore wiring, ocr, windowSwitch (linked
│  │                       windows), updater, focus, imageProtocol, aiLog,
│  │                       fullscreen (koffi), recycleBin, powershell, tray
│  ├─ preload/             sandboxed contextBridge
│  ├─ clipboard/           ClipboardWatcher (600ms poll), formats (FNV-1a, HDROP)
│  └─ store/               db.ts (SQLite canonical store + FTS5 + WAL),
│                          ItemStore (SHA-256 text-hash dedup), TaskStore
│                          (state machine + commit seam), NoteStore,
│                          stationStore / transferStation / dragSession /
│                          stagedMove, sessionStore, activityLedger
│                          (clustering), evidenceStore, traceStore,
│                          recommendationHistory, proposalGrading,
│                          memoryGraph (episodes/entities/facts),
│                          episodeConsolidator, privacyGate,
│                          localModelManager / localModelRuntime,
│                          MemoryStore, settings, paths
├─ src/                    React renderer
│  ├─ components/          Panel, Header, ItemList, PreviewFlyout, Settings,
│  │  ├─ notes/            NotesView, markdownEditor (CodeMirror WYSIWYG)
│  │  └─ tasks/            TaskView, TaskEditor, TaskDetail, TaskProposalCard,
│  │                       TaskDropPanel, ContentPicker
│  ├─ hooks/               useEdgeHover (hysteresis), useDragOut
│  ├─ lib/                 fileTabs, theme, restore, taskEditor model
│  ├─ i18n/                translations for 31 languages
│  └─ store/               Zustand appStore (view cache of main state)
├─ assets/readme/          hero and pipeline visuals
└─ tests/                  59 vitest files, 1111 cases
```

---

## Tech stack

| Layer             | Choice                      | Why                                                                       |
| ----------------- | --------------------------- | ------------------------------------------------------------------------- |
| Desktop runtime   | **Electron 34**             | Only way to reach Win32 OLE drag and native clipboard formats from JS     |
| Build tooling     | **electron-vite**           | Separate Main / Preload / Renderer builds with Vite HMR                   |
| UI                | **React 18 + TypeScript 5** | Typed component tree; sandboxed renderer                                  |
| State / animation | **Zustand + Framer Motion** | Single-source-of-truth pushes, spring physics                             |
| Notes editor      | **CodeMirror 6**            | WYSIWYG Markdown with live decorations (Obsidian-style marker reveal)     |
| Native FFI        | **koffi**                   | Fullscreen detection, native clipboard formats, window activation, recycle bin (`SHFileOperationW`) |
| Scripting         | **PowerShell**              | HDROP file lists, simulated paste, WinRT OCR                              |
| Drag ghosts       | **@resvg/resvg-js**         | Server-side SVG → PNG rendering                                           |
| Storage           | **better-sqlite3**          | Evidence / trace / memory store (FTS5 + WAL); tasks, notes and the station are JSON-backed |
| Updates           | **electron-updater**        | GitHub-release auto-updates for NSIS builds; disabled on Store builds     |
| Local model       | **node-llama-cpp**          | Embedded Qwen3-0.6B Q8_0 for offline title drafts / candidate rerank — default off, downloads from Settings |
| Tests             | **vitest**                  | 1111 unit tests, engines tested with fake clock + injected deps           |

---

## Status

**Current release (v2026.8.15)** — the shelf grew from two domains to four:

- **Notes** — a full Markdown notes editor on the blade: live-rendering CodeMirror with hidden inline markers, clickable checkboxes, reading-mode toggle, single-note and list layouts, pin/fold, caret restore.
- **Transfer station (ADR-0008)** — files moved out of the clipboard stack into their own domain: OS-level drag detection (`SetWinEventHook` in a utility process), compact drag indicator that expands only on approach, copy/staged-move drag-out modes, and a recycle-bin safety net — the station never hard-deletes a file.
- **Smart collapse (ADR-0007)** — passive signals (external scroll/copy, idle, lock/suspend) end focus-held sessions instead of pinning the panel open; read-first notes mode via the auto-focus toggle.
- **Task resource model (ADR-0009)** — task resources are living links: drag out via OLE or click to copy back to the stack top; station entries link as task file resources; evicted resources degrade to a visible "dead" placeholder.
- **Foundation updates** — auto-update restored for GitHub builds (Settings toggle + manual check UI; Store builds update only through the Store), SHA-256 text-hash dedup that survives restarts, blade-open bounce + edge flares + crossfade view transitions (motion levels), switcher type-to-search and icon prewarm, 31 languages (Persian added with the upstream v0.2.7 merge).

**Pipeline refactor (ADR-0005, v2026.08.13)** — the suggestion pipeline is rebuilt end to end: an activity ledger clusters the event stream, a current-task controller gates decisions (six triggers, hysteresis in Settings, ~0 LLM calls in steady state), a decision provider escalates to the agent chain on low confidence (fixed four-tool surface, ≤3 calls), proposals are graded L1/L2/L3 with semantic dedup and recommendation-history cooldowns, memory is a reviewable fact graph (episodes → entities → facts, deterministic retrieval, conflict adjudication in Settings), everything is traceable to its evidence, and the embedded local model is wired but off by default. Golden Dataset baseline: precision 1.0 / recall 0.9935 / 0 false positives (181 seeds).

**Designed, not yet built** — ADR-0006: UIA-driven capture (a11y tree first, OCR fallback), an extended trace contract for algorithm/model intermediate states, a developer workstation with a live pipeline cross-section, a smart landing page, and a Morning Brief.

**Deliberately not planned** — Linux/macOS ports, cloud sync, and self-updating Microsoft Store builds (Store builds update only through the Store).

---

## Security

| Control              | Implementation                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Process isolation    | `contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` on all windows                                  |
| Typed IPC            | Channel names and payloads statically checked on both sides (`shared/ipc.ts`)                                         |
| Clipboard privacy    | Password-manager / dictation formats matched case-insensitively and skipped; incognito suspends polling               |
| AI disclosure        | Nothing leaves the machine unless a provider is configured; privacy gates for capture, AI, and memory are independent |
| Protocol confinement | `tracelocal://` thumbnails resolve strictly inside the app data directory with SHA-256 revalidation                   |
| Update provenance    | NSIS builds check and download only from GitHub Releases (toggleable); MSIX builds never self-update — Store policy   |
| PowerShell hardening | Absolute executable path, non-blocking exec, strict path validation                                                   |
| Dev-safe startup     | Login-item registration is gated by `app.isPackaged` — dev builds never touch the registry                            |

---

## License

Apache-2.0 — see [LICENSE](LICENSE). This is a fork of [Edge-Drop](https://github.com/Deepender25/Edge-Drop); upstream's branding and sponsor links were removed in this fork.
