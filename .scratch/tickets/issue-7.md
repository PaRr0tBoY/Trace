# 7 — T4b — Drag-session state machine + panel expansion (拖拽会话状态机)

## Parent

Spec: #2 — Transfer Station (文件中转站): Yoink-style file shelf & drag overlay rework (implementation decision: drag-session state machine).

## What to build

A pure state machine (vitest-tested, mirroring the keyboard-hook / switcher pattern) plus thin main-process wiring whose event source follows the T4a verdict. Inputs: drag start/end events, cursor position facts, source window class, current panel state. Outputs: expand / retain / retract commands. Behaviour: the panel expands as soon as a file drag starts anywhere on screen — no need to drag to the screen edge; non-file drags never expand it; a drag that never reaches the panel leaves it to retract normally. The always-on-top heartbeat pauses during native drags.

## Acceptance criteria

- [ ] State machine transitions (event + facts → command) unit-tested and green
- [ ] Starting a file drag anywhere expands the panel; text / selection drags do not
- [ ] A file drag that never reaches the panel lets the panel retract afterwards
- [ ] Heartbeat pauses during the drag and resumes after
- [ ] No interaction regressions with Alt+Tab switcher sessions or hover expansion

## Blocked by

- #4 — T4a: Drag-detection prototype on Win10/11 (拖拽检测原型)

