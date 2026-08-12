import { describe, expect, it } from 'vitest'

import {
  CLASSIFIER_VERSION,
  clusterEvents,
  createActivityLedger,
  type Activity,
  type ClusterParams,
  type SegmentInfo
} from '../electron/store/activityLedger'
import { createMemoryEvidenceStore, evidenceFromUsageEvent, type EvidenceStore } from '../electron/store/evidenceStore'
import { createIgnoredTable } from '../electron/main/ignored'
import type { AppSwitchEvent, Task, UsageEvent } from '../shared/types'

/** Baseline params: defaults as t19 will inject from settings. */
const P: ClusterParams = {
  hardGapMs: 600_000,
  transientMs: 2_500,
  overlapThreshold: 0.3,
  confidenceHigh: 0.7,
  confidenceLow: 0.45
}

function ev(appName: string, ts: number, title = ''): AppSwitchEvent {
  return {
    type: 'app-switch',
    appName,
    exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`,
    pid: 1,
    windowTitle: title,
    ts
  }
}

function clipEv(appName: string, ts: number, itemId?: string): UsageEvent {
  return { type: 'clipboard', appName, exePath: `C:\\Apps\\${appName.toLowerCase()}.exe`, pid: 1, ts, itemId }
}

function task(id: string, title: string, apps: string[], lastActiveAt = 0): Task {
  return {
    id,
    title,
    status: 'running',
    statusSource: 'system',
    apps: apps.map((a) => ({ id: a, name: a })),
    resources: [],
    windowTitles: [],
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt,
    activeMs: 0
  }
}

interface LedgerHarness {
  evidence: EvidenceStore
  ignored: ReturnType<typeof createIgnoredTable>
  tasks: Task[]
  ledger: ReturnType<typeof createActivityLedger>
}

function makeLedger(initialEvents: UsageEvent[] = [], tasks: Task[] = []): LedgerHarness {
  const evidence = createMemoryEvidenceStore()
  for (const e of initialEvents) evidence.record(evidenceFromUsageEvent(e))
  const ignored = createIgnoredTable({ load: () => null, save: () => {} })
  const ledger = createActivityLedger({
    evidence,
    getTasks: () => tasks,
    getParams: () => P,
    ignored
  })
  return { evidence, ignored, tasks, ledger }
}

/** 5 events, one segment (1s gaps < transientMs 2.5s), spread over 4s. */
function batch(base = 10_000): UsageEvent[] {
  return [
    ev('Code', base),
    ev('Code', base + 1_000, 'report.md — Code'),
    ev('Chrome', base + 2_000, 'docs.example.com'),
    ev('Chrome', base + 3_000),
    ev('Code', base + 4_000)
  ]
}

function segmentsOf(activities: Activity[], details: Array<{ windowTitles: string[] }>): SegmentInfo[] {
  return activities.map((a, i) => ({
    startTs: a.startAt,
    endTs: a.endAt,
    durationMs: a.endAt - a.startAt,
    eventCount: 0,
    appNames: a.apps.map((app) => app.name),
    appKeys: a.apps.map((app) => app.id),
    appDurationsMs: a.apps.map((app) => app.durationMs),
    appWindows: a.apps.map((app) => app.windows),
    windowTitles: details[i].windowTitles,
    titleTokens: []
  }))
}

describe('ActivityLedger — contract shape (spec 实现决策 3)', () => {
  it('stamps every field of the Activity contract', async () => {
    const h = makeLedger(batch())
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    const a = activities[0]
    expect(typeof a.id).toBe('string')
    expect(a.startAt).toBe(10_000)
    expect(a.endAt).toBe(14_000)
    // apps: identity key + display name + dwell + windows, dwell-ordered.
    expect(a.apps.map((app) => app.name)).toEqual(['Chrome', 'Code'])
    expect(a.apps.map((app) => app.id)).toEqual(['c:/apps/chrome.exe', 'c:/apps/code.exe'])
    for (const app of a.apps) {
      expect(typeof app.durationMs).toBe('number')
      expect(Array.isArray(app.windows)).toBe(true)
    }
    // 'new' zone: no attribution; clipboard refs + signature + classifier version present.
    expect(a.attribution).toBeUndefined()
    expect(a.clipboardRefs).toEqual([])
    expect(typeof a.signature).toBe('string')
    expect(a.signature.length).toBeGreaterThan(0)
    expect(a.classifierVersion).toBe(CLASSIFIER_VERSION)
    expect(a.promptVersion).toBeUndefined()
    expect(a.sessionId).toBeUndefined()
  })

  it('carries attribution {taskId, confidence} for a matched activity', async () => {
    // Task apps are matched in the display-name key space (the segment's
    // scoring keys are name-first).
    const h = makeLedger(batch(), [task('t1', 'Writing report', ['chrome', 'code'])])
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    expect(activities[0].attribution).toMatchObject({ taskId: 't1' })
    expect(typeof activities[0].attribution!.confidence).toBe('number')
  })

  it('records per-app dwell and windows (dwell-weighted, aligned with app ids)', async () => {
    const h = makeLedger([
      ev('Chrome', 10_000, 'research'),
      ev('Chrome', 110_000, 'main.ts'),
      ev('Chrome', 210_000),
      ev('Code', 210_100)
    ])
    const { activities } = await h.ledger.analyze()
    const [chrome, code] = activities[0].apps
    expect(chrome.name).toBe('Chrome')
    expect(chrome.durationMs).toBe(200_100) // dwell includes the 100ms gap before the Code switch
    expect(chrome.windows).toEqual(['main.ts', 'research']) // most-dwelled first
    expect(code.durationMs).toBe(0)
    expect(code.windows).toEqual([])
  })

  it('stamps a custom classifierVersion and promptVersion when provided', async () => {
    const h = makeLedger(batch())
    const ledger = createActivityLedger({
      evidence: h.evidence,
      getTasks: () => h.tasks,
      getParams: () => P,
      ignored: h.ignored,
      classifierVersion: 'clusterer@2',
      promptVersion: 'prompt@3'
    })
    const { activities } = await ledger.analyze()
    expect(activities[0].classifierVersion).toBe('clusterer@2')
    expect(activities[0].promptVersion).toBe('prompt@3')
  })
})

describe('ActivityLedger — traceability (each activity back to its events)', () => {
  it('eventsOf returns exactly the events in the activity window', async () => {
    // Two segments: Code block then a hard-separated Word block.
    const events = [
      ev('Code', 10_000),
      ev('Code', 11_000, 'report.md — Code'),
      ev('Chrome', 12_000, 'docs.example.com'),
      ev('Code', 13_000),
      ev('Word', 710_000, 'word doc'),
      clipEv('Word', 710_500, 'i-w'),
      ev('Word', 711_000)
    ]
    const h = makeLedger(events)
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(2)

    const first = h.ledger.eventsOf(activities[0].id)
    const second = h.ledger.eventsOf(activities[1].id)
    expect(first.map((e) => e.kind)).toEqual(['app-switch', 'app-switch', 'app-switch', 'app-switch'])
    expect(first.map((e) => e.capturedAt)).toEqual([10_000, 11_000, 12_000, 13_000])
    // The clipboard row assigned to the second segment travels with it.
    expect(second.map((e) => e.kind)).toEqual(['app-switch', 'clipboard', 'app-switch'])
    expect(second.map((e) => e.capturedAt)).toEqual([710_000, 710_500, 711_000])

    // Partition: every recorded event lands in exactly one activity.
    const covered = [...first, ...second].map((e) => e.id).sort()
    const recorded = h.evidence.query({}).map((e) => e.id).sort()
    expect(covered).toEqual(recorded)
    // Unknown activity id -> empty, never throws.
    expect(h.ledger.eventsOf('nope')).toEqual([])
  })

  it('the [startAt, endAt] window is a reconstructable query condition', async () => {
    const h = makeLedger(batch())
    const { activities } = await h.ledger.analyze()
    const a = activities[0]
    // Events at or after startAt and at or before endAt — segments partition
    // the batch, so the window reproduces the exact event set.
    const fromWindow = h.evidence.query({ from: a.startAt, to: a.endAt + 1 })
    expect(fromWindow.map((e) => e.id).sort()).toEqual(
      h.ledger.eventsOf(a.id).filter((e) => e.kind === 'app-switch').map((e) => e.id).sort()
    )
  })
})

describe('ActivityLedger — trigger cursor over the evidence timeline', () => {
  it('baseline skips pre-baseline events', async () => {
    const h = makeLedger(batch(10_000))
    h.ledger.baseline() // newest event at 14_000
    expect(h.ledger.pendingCount()).toBe(0)
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(0)
  })

  it('pending stats reflect the batch since the cursor; analyze advances it', async () => {
    const h = makeLedger()
    h.ledger.baseline()
    h.evidence.record(evidenceFromUsageEvent(ev('Code', 100)))
    h.evidence.record(evidenceFromUsageEvent(clipEv('Code', 200, 'i1')))
    expect(h.ledger.pendingCount()).toBe(2)
    expect(h.ledger.pendingLastTs()).toBe(200)
    expect(h.ledger.hasPendingSwitches()).toBe(true)

    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    // Cursor advanced: the same batch must not re-cluster.
    expect(h.ledger.pendingCount()).toBe(0)
    expect(h.ledger.hasPendingSwitches()).toBe(false)
    expect(h.ledger.pendingLastTs()).toBeNull()
  })

  it('markSeen advances the cursor on a clipboard-only batch', async () => {
    const h = makeLedger()
    h.ledger.baseline()
    for (let i = 0; i < 5; i++) h.evidence.record(evidenceFromUsageEvent(clipEv('Code', 10_000 + i * 10_000, `i${i}`)))
    expect(h.ledger.pendingCount()).toBe(5)
    expect(h.ledger.hasPendingSwitches()).toBe(false)
    h.ledger.markSeen()
    expect(h.ledger.pendingCount()).toBe(0)
  })

  it('analyze returns nothing for a clipboard-only batch (and advances)', async () => {
    const h = makeLedger()
    h.ledger.baseline()
    h.evidence.record(evidenceFromUsageEvent(clipEv('Code', 500, 'i1')))
    const { activities, details } = await h.ledger.analyze()
    expect(activities).toHaveLength(0)
    expect(details).toHaveLength(0)
    expect(h.ledger.pendingCount()).toBe(0)
  })

  it('clusters every pending event even beyond one query page (paging)', async () => {
    const h = makeLedger()
    h.ledger.baseline()
    // 205 events: one segment (1s gaps < transientMs); exceeds the 200-row query cap.
    for (let i = 0; i < 205; i++) h.evidence.record(evidenceFromUsageEvent(ev('Code', 1_000 + i * 1_000)))
    expect(h.ledger.pendingCount()).toBe(205)
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    expect(h.ledger.eventsOf(activities[0].id)).toHaveLength(205)
  })

  it('keeps the batch pending for retry when clustering fails', async () => {
    const evidence = createMemoryEvidenceStore()
    const ignored = createIgnoredTable({ load: () => null, save: () => {} })
    let params = { ...P }
    const ledger = createActivityLedger({ evidence, getTasks: () => [], getParams: () => params, ignored })
    ledger.baseline()
    for (const e of batch()) evidence.record(evidenceFromUsageEvent(e))

    params = { ...params, confidenceHigh: 0.3, confidenceLow: 0.7 } // invalid: high <= low
    await expect(ledger.analyze()).rejects.toThrow()
    // The cursor must NOT have advanced: the batch survives for the next pass.
    expect(ledger.pendingCount()).toBe(5)

    params = { ...P }
    const { activities } = await ledger.analyze()
    expect(activities).toHaveLength(1)
    expect(ledger.pendingCount()).toBe(0)
  })
})

describe('ActivityLedger — ignore gate and dismiss', () => {
  it('drops activities whose signature is on the ignored table', async () => {
    const h = makeLedger(batch())
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    h.ledger.dismiss(activities[0].signature)
    expect(h.ignored.has(activities[0].signature)).toBe(true)

    // Same activity again: the ledger filters it out.
    h.evidence.record(evidenceFromUsageEvent(ev('Code', 20_000)))
    h.evidence.record(evidenceFromUsageEvent(ev('Code', 21_000)))
    h.evidence.record(evidenceFromUsageEvent(ev('Chrome', 22_000)))
    h.evidence.record(evidenceFromUsageEvent(ev('Chrome', 23_000)))
    h.evidence.record(evidenceFromUsageEvent(ev('Code', 24_000)))
    const again = await h.ledger.analyze()
    expect(again.activities).toHaveLength(0)
    expect(again.details).toHaveLength(0)
  })
})

describe('ActivityLedger — evidence timeline input is behavior-identical', () => {
  it('produces the same segmentation as direct clusterEvents input', async () => {
    // Three hard-separated blocks (700k gaps ≥ hardGapMs 600k): no soft
    // merge, exactly three segments, identical on both input paths.
    const usageEvents: UsageEvent[] = [
      ev('Code', 10_000),
      ev('Code', 11_000),
      ev('Chrome', 711_000),
      ev('Chrome', 712_000),
      ev('Code', 1_411_000),
      ev('Code', 1_412_000)
    ]
    const h = makeLedger(usageEvents)
    const { activities, details } = await h.ledger.analyze()
    expect(activities).toHaveLength(3)

    const direct = await clusterEvents(
      usageEvents.filter((e): e is AppSwitchEvent => e.type === 'app-switch'),
      [],
      P
    )
    expect(segmentsOf(activities, details).map((s) => [s.startTs, s.endTs, s.appNames])).toEqual(
      direct.attributions.map((a) => [a.segment.startTs, a.segment.endTs, a.segment.appNames])
    )
  })

  it('reconstructs display names and identity keys from the payload', async () => {
    const h = makeLedger(batch())
    const { activities } = await h.ledger.analyze()
    expect(activities[0].apps.map((a) => a.name)).toEqual(['Chrome', 'Code'])
    expect(activities[0].apps.map((a) => a.id)).toEqual(['c:/apps/chrome.exe', 'c:/apps/code.exe'])
  })
})

describe('ActivityLedger — clipboard refs by activity window', () => {
  it('assigns between-segment copies to the preceding activity and keeps post-switch copies with the last', async () => {
    const h = makeLedger([
      ...batch(),
      clipEv('Code', 20_000, 'a'),
      ev('Word', 30_000, 'word doc'),
      clipEv('Word', 30_500, 'b'),
      ev('Word', 31_000)
    ])
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(2)
    const first = activities.find((a) => a.apps.some((app) => app.name === 'Code'))!
    const second = activities.find((a) => a.apps.some((app) => app.name === 'Word'))!
    expect(first.clipboardRefs).toContain('a')
    expect(first.clipboardRefs).not.toContain('b')
    expect(second.clipboardRefs).toContain('b')
  })

  it('keeps a copy after the final app switch with the last activity', async () => {
    const h = makeLedger([...batch(), clipEv('Code', 15_000, 'late')])
    const { activities } = await h.ledger.analyze()
    expect(activities).toHaveLength(1)
    expect(activities[0].clipboardRefs).toEqual(['late'])
  })

  it('ignores clipboard rows without an itemId', async () => {
    const h = makeLedger([...batch(), clipEv('Code', 12_000)])
    const { activities } = await h.ledger.analyze()
    expect(activities[0].clipboardRefs).toEqual([])
  })
})
