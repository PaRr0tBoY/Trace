/**
 * t42 — AI 依据 HTML 报告生成器 (spec 实现决策 8).
 *
 * Covers: full-chain rendering with the five kinds, per-row version columns,
 * retrieval hit paths (hitPath/hops), the privacy-blocked styling, HTML
 * escaping of untrusted payload strings, and the empty-chain fallback.
 */
import { describe, expect, it } from 'vitest'
import { isTraceRecordDto, renderTraceReportHtml } from '../electron/main/traceReport'
import type { TraceRecordDto } from '../shared/types'

const T0 = new Date(2026, 0, 1, 12, 0, 0, 0).getTime()

function chain(): TraceRecordDto[] {
  return [
    {
      id: 'r1',
      decisionId: 'd-1',
      kind: 'observed',
      payload: { summary: 'working on the quarterly invoice batch', activityId: 'act-9' },
      agentVersion: 'agent-1.0.0',
      policyVersion: 'policy-2',
      classifierVersion: 'cls-3.1',
      promptVersion: 'prompt-4',
      createdAt: T0
    },
    {
      id: 'r2',
      decisionId: 'd-1',
      kind: 'recall',
      payload: { tool: 'search_clipboard', query: 'invoice', count: 3, preview: 'inv_2026.pdf', hitPath: ['clipboard#a1', 'entity#acme'], hops: 1 },
      agentVersion: 'agent-1.0.0',
      policyVersion: 'policy-2',
      createdAt: T0 + 1000
    },
    {
      id: 'r3',
      decisionId: 'd-1',
      kind: 'decision',
      payload: { action: 'new', title: 'Invoicing', reason: 'user has been invoicing for 40 minutes', rating: 'good', confidence: 0.82 },
      agentVersion: 'agent-1.0.0',
      promptVersion: 'prompt-4',
      createdAt: T0 + 2000
    },
    {
      id: 'r4',
      decisionId: 'd-1',
      kind: 'privacy',
      payload: { reason: 'denied by content-type policy', access: 'clipboard', contentType: 'image' },
      createdAt: T0 + 3000
    },
    {
      id: 'r5',
      decisionId: 'd-1',
      kind: 'result',
      payload: { outcome: 'accepted', proposalId: 'prop-1', taskId: 'task-1', actionReason: 'user_confirmed' },
      createdAt: T0 + 4000
    }
  ]
}

describe('renderTraceReportHtml — AI rationale HTML report (t42)', () => {
  it('完整链渲染：五类 kind、版本信息、检索命中路径、隐私拦截标注', () => {
    const html = renderTraceReportHtml(chain())
    // Kind labels for all five kinds.
    for (const label of ['Observed', 'Recalled', 'Decision', 'Result', 'Privacy filtered']) {
      expect(html).toContain(label)
    }
    // Version columns per row.
    expect(html).toContain('agent-1.0.0')
    expect(html).toContain('policy-2')
    expect(html).toContain('cls-3.1')
    expect(html).toContain('prompt-4')
    // Retrieval hit path rendered as a chain (story 28: hop 数 + 命中路径).
    expect(html).toContain('clipboard#a1')
    expect(html).toContain('entity#acme')
    // Privacy treatment.
    expect(html).toContain('Blocked by privacy policy')
    // decisionId header.
    expect(html).toContain('d-1')
    // Row count stat.
    expect(html).toContain('<b>5</b> trace rows')
  })

  it('payload 中的不可信字符串被 HTML 转义，不注入标签', () => {
    const evil: TraceRecordDto = {
      id: 'r1',
      decisionId: 'd-x',
      kind: 'decision',
      payload: { action: 'new', reason: '<script>alert(1)</script> & "quoted"', confidence: 0.5 },
      createdAt: T0
    }
    const html = renderTraceReportHtml([evil])
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('"quoted"')
    expect(html).toContain('&quot;quoted&quot;')
  })

  it('空链给出空态说明而不是空壳', () => {
    const html = renderTraceReportHtml([])
    expect(html).toContain('No AI rationale data recorded for this chain.')
    expect(html).toContain('<b>0</b> trace rows')
  })

  it('recall 的 hitPath 数组按 → 拼接展示', () => {
    const html = renderTraceReportHtml(chain())
    expect(html).toContain('clipboard#a1 → entity#acme')
  })
})

describe('isTraceRecordDto — IPC 输入运行时守卫 (t42 review)', () => {
  it('接受完整合法记录，拒绝非数组/缺字段/坏 kind/坏 createdAt', () => {
    const good = chain()[0]
    expect(isTraceRecordDto(good)).toBe(true)
    expect(isTraceRecordDto(null)).toBe(false)
    expect(isTraceRecordDto('nope')).toBe(false)
    expect(isTraceRecordDto({ ...good, kind: 'teleport' })).toBe(false)
    expect(isTraceRecordDto({ ...good, createdAt: 'yesterday' })).toBe(false)
    expect(isTraceRecordDto({ ...good, payload: 'raw' })).toBe(false)
    expect(isTraceRecordDto({ ...good, taskId: 7 })).toBe(false)
    expect(isTraceRecordDto({ ...good, decisionId: undefined })).toBe(false)
  })
})
