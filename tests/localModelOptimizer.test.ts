import { describe, expect, it, vi } from 'vitest'

import type { CandidateActivity } from '../shared/types'
import {
  applyOptimizerReply,
  createCandidateOptimizer,
  MAX_LOCAL_CANDIDATES,
  type CandidateOptimizerDeps
} from '../electron/store/localModelOptimizer'

function candidate(activityId: string, score = 0.5, title?: string): CandidateActivity {
  return {
    activityId,
    score,
    ...(title ? { semanticLabel: title } : {}),
    evidenceRefs: ['report.md — Code', 'Code + Chrome']
  }
}

function reply(items: Array<{ index: number; title?: string }>): unknown {
  return { items }
}

describe('applyOptimizerReply — pure reply mapping', () => {
  const input = [candidate('a1', 0.4, 'algo title 1'), candidate('a2', 0.6), candidate('a3', 0.8), candidate('a4', 0.9)]

  it('reranks by reply order and caps at maxCandidates', () => {
    const out = applyOptimizerReply(input, reply([{ index: 3 }, { index: 1 }, { index: 0 }]), MAX_LOCAL_CANDIDATES)
    expect(out).not.toBeNull()
    expect(out!.map((c) => c.activityId)).toEqual(['a4', 'a2', 'a1'])
  })

  it('caps at 3 even when the reply lists more', () => {
    const out = applyOptimizerReply(input, reply([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]), MAX_LOCAL_CANDIDATES)
    expect(out!.map((c) => c.activityId)).toEqual(['a1', 'a2', 'a3'])
    expect(out!.length).toBe(MAX_LOCAL_CANDIDATES)
  })

  it('applies title drafts as semanticLabel, keeping the algorithm title when absent', () => {
    const out = applyOptimizerReply(input, reply([{ index: 2, title: 'drafted title' }, { index: 0 }]), 3)
    expect(out![0].semanticLabel).toBe('drafted title')
    expect(out![1].semanticLabel).toBe('algo title 1')
  })

  it('keeps the input score and evidence untouched (归因全由算法)', () => {
    const out = applyOptimizerReply(input, reply([{ index: 2, title: 'x' }]), 3)
    expect(out![0].score).toBe(0.8)
    expect(out![0].evidenceRefs).toEqual(input[2].evidenceRefs)
    expect(out![0].candidateTaskId).toBeUndefined()
  })

  it('drops out-of-range and duplicate indexes', () => {
    const out = applyOptimizerReply(input, reply([{ index: 9 }, { index: 1 }, { index: 1 }, { index: 0 }]), 3)
    expect(out!.map((c) => c.activityId)).toEqual(['a2', 'a1'])
  })

  it('returns null on malformed replies (never a partial list)', () => {
    expect(applyOptimizerReply(input, null, 3)).toBeNull()
    expect(applyOptimizerReply(input, 'nope', 3)).toBeNull()
    expect(applyOptimizerReply(input, { items: 'nope' }, 3)).toBeNull()
    expect(applyOptimizerReply(input, { items: [{ title: 'no index' }] }, 3)).toBeNull()
    expect(applyOptimizerReply(input, { items: [null] }, 3)).toBeNull()
  })

  it('returns null for an empty refined list — the model can never silence the pipeline', () => {
    expect(applyOptimizerReply(input, reply([]), 3)).toBeNull()
  })

  it('trims and bounds title drafts', () => {
    const long = `t${'x'.repeat(120)}`
    const out = applyOptimizerReply(input, reply([{ index: 0, title: `  ${long}  ` }]), 3)
    expect(out![0].semanticLabel!.length).toBe(60)
    expect(out![0].semanticLabel!.startsWith('t')).toBe(true)
  })
})

describe('createCandidateOptimizer — seam over injected inferJson', () => {
  function deps(inferJson: CandidateOptimizerDeps['inferJson']): CandidateOptimizerDeps {
    return { inferJson }
  }

  it('returns [] for an empty candidate list without calling the model', async () => {
    const inferJson = vi.fn()
    const optimizer = createCandidateOptimizer(deps(inferJson as unknown as CandidateOptimizerDeps['inferJson']))
    await expect(optimizer.optimize([])).resolves.toEqual([])
    expect(inferJson).not.toHaveBeenCalled()
  })

  it('passes the model reply through applyOptimizerReply', async () => {
    const input = [candidate('a1', 0.4), candidate('a2', 0.9, 'keep me')]
    const inferJson = vi.fn().mockResolvedValue(reply([{ index: 1, title: 'draft' }, { index: 0 }]))
    const optimizer = createCandidateOptimizer(deps(inferJson))
    const out = await optimizer.optimize(input)
    expect(out!.map((c) => c.activityId)).toEqual(['a2', 'a1'])
    expect(out![0].semanticLabel).toBe('draft')
    expect(inferJson).toHaveBeenCalledTimes(1)
    const req = inferJson.mock.calls[0][0]
    expect(req.schema).toBeDefined()
    expect(typeof req.messages[1].content).toBe('string')
  })

  it('degrades to null when the model call throws (不变量 H)', async () => {
    const optimizer = createCandidateOptimizer(deps(() => Promise.reject(new Error('engine crashed'))))
    await expect(optimizer.optimize([candidate('a1')])).resolves.toBeNull()
  })

  it('degrades to null when the reply is malformed', async () => {
    const optimizer = createCandidateOptimizer(deps(() => Promise.resolve({ bogus: true })))
    await expect(optimizer.optimize([candidate('a1')])).resolves.toBeNull()
  })

  it('bounds the input to the optimizer context budget', async () => {
    const inferJson = vi.fn().mockResolvedValue(reply([{ index: 0 }]))
    const optimizer = createCandidateOptimizer(deps(inferJson))
    const many = Array.from({ length: 20 }, (_, i) => candidate(`a${i}`))
    await optimizer.optimize(many)
    const userContent = inferJson.mock.calls[0][0].messages[1].content as string
    const payload = JSON.parse(userContent.replace(/^Candidates: /, '')) as { candidates: unknown[] }
    expect(payload.candidates.length).toBe(8)
  })
})
