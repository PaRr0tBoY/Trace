/**
 * 记忆可审查面板（t51，spec 决策 10 / 用户故事 29、30）：
 * - 事实按 type 分组展示（过滤视图，8 个已知 type），来源链（episode）可见；
 * - 确认 / 忽略 / 封禁操作经 memory-graph:set-state 生效并持久化；
 * - 冲突对（invalid_at 关联的 active + invalidated）并排展示，三选裁决
 *   （保留 A / 保留 B / 都不保留），不自动覆盖（memory-graph:adjudicate）；
 * - 画像分显式（设置自述 source=user，永远优先展示）与推断（整理归纳）两区。
 * 数据源：main 侧 memoryGraph（SQLite）；DB 故障时主进程返回空载荷，面板只读空态。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store/appStore'
import { useTranslation } from '../i18n'
import { playButtonClickSound } from '../lib/soundEffects'
import type { MemoryConflictResolution, MemoryFactConflictDto, MemoryFactDto, MemoryUserState } from '../../shared/types'

/** 8 个已知事实 type（spec 决策 10：UI 分组 = 按 fact type 过滤的视图）。 */
const FACT_TYPES = ['identity', 'tool', 'project', 'workflow', 'profile', 'pattern', 'task', 'preference'] as const

/** 面板通用时刻格式（多处共用，保持同一格式）。 */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function MemoryGraphPanel() {
  const { t } = useTranslation()
  const payload = useStore((s) => s.memoryFacts)
  const load = useStore((s) => s.loadMemoryFacts)
  const setState = useStore((s) => s.setMemoryFactState)
  const adjudicate = useStore((s) => s.adjudicateMemoryConflict)
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    void load()
  }, [load])

  const facts = payload?.facts ?? []
  const conflicts = payload?.conflicts ?? []

  const typeLabel = (type: string): string => {
    switch (type) {
      case 'identity': return t('memoryGraph.typeIdentity')
      case 'tool': return t('memoryGraph.typeTool')
      case 'project': return t('memoryGraph.typeProject')
      case 'workflow': return t('memoryGraph.typeWorkflow')
      case 'profile': return t('memoryGraph.typeProfile')
      case 'pattern': return t('memoryGraph.typePattern')
      case 'task': return t('memoryGraph.typeTask')
      case 'preference': return t('memoryGraph.typePreference')
      default: return t('memoryGraph.typeOther')
    }
  }

  const sourceLabel = (source: MemoryFactDto['source']): string => {
    switch (source) {
      case 'user': return t('memoryGraph.sourceUser')
      case 'ai-suggest': return t('memoryGraph.sourceAiSuggest')
      case 'task-feedback': return t('memoryGraph.sourceTaskFeedback')
      case 'inferred': return t('memoryGraph.sourceInferred')
    }
  }

  const stateLabel = (state: MemoryUserState): string => {
    switch (state) {
      case 'confirmed': return t('memoryGraph.stateConfirmed')
      case 'suggested': return t('memoryGraph.stateSuggested')
      case 'ignored': return t('memoryGraph.stateIgnored')
      case 'banned': return t('memoryGraph.stateBanned')
    }
  }

  /** 按 userState 给出可执行操作（转换规则与 MemoryStore 一致：confirmed 仅可 ban…）。 */
  const actionsFor = (state: MemoryUserState): Array<{ action: MemoryUserState; label: string; danger?: boolean }> => {
    switch (state) {
      case 'suggested':
        return [
          { action: 'confirmed', label: t('memoryGraph.confirm') },
          { action: 'ignored', label: t('memoryGraph.ignore') },
          { action: 'banned', label: t('memoryGraph.ban'), danger: true }
        ]
      case 'confirmed':
        return [{ action: 'banned', label: t('memoryGraph.ban'), danger: true }]
      case 'ignored':
        return [{ action: 'banned', label: t('memoryGraph.ban'), danger: true }]
      case 'banned':
        return [{ action: 'ignored', label: t('memoryGraph.restore') }]
    }
  }

  const act = (id: string, userState: MemoryUserState): void => {
    playButtonClickSound()
    void setState(id, userState)
  }

  const resolve = (conflict: MemoryFactConflictDto, resolution: MemoryConflictResolution): void => {
    playButtonClickSound()
    void adjudicate(conflict.active.id, conflict.invalidated.id, resolution)
  }

  /** 单条事实来源链（起源 episode 时段 + 整理摘要）。 */
  const sourceChain = (fact: MemoryFactDto): string | null => {
    const ep = fact.episode
    if (!ep) return null
    return ep.summary ? `${fact.episodeId} · ${fmtTime(ep.startedAt)} · ${ep.summary}` : `${fact.episodeId} · ${fmtTime(ep.startedAt)}`
  }

  /** 时间有效性窗口（恒有效 → null）。 */
  const validWindow = (fact: MemoryFactDto): string | null => {
    if (fact.invalidAt !== null || (fact.validAt === null && fact.expiredAt === null)) return null
    const from = fact.validAt !== null ? fmtTime(fact.validAt) : '…'
    const to = fact.expiredAt !== null ? fmtTime(fact.expiredAt) : '…'
    return `${from} → ${to}`
  }

  const metaLine = (fact: MemoryFactDto, showType: boolean): string => {
    const chain = sourceChain(fact)
    const window = validWindow(fact)
    const parts = [
      showType ? typeLabel(fact.type) : null,
      sourceLabel(fact.source),
      stateLabel(fact.userState),
      window ? t('memoryGraph.validWindow', { from: window }) : null,
      chain ? t('memoryGraph.episodeRef', { ref: chain }) : null,
      fact.invalidAt !== null ? t('memoryGraph.invalidatedAt', { at: fmtTime(fact.invalidAt) }) : null
    ]
    return parts.filter((p): p is string => p !== null).join(' · ')
  }

  const factRow = (fact: MemoryFactDto, showType: boolean) => (
    <div key={fact.id} className="setting-row vertical" style={{ gap: 2, padding: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%' }}>
        {fact.source === 'user' && (
          <span className="pill display-pill" style={{ padding: '1px 6px', fontSize: 9, flexShrink: 0, color: '#7fd0a0' }}>
            {t('memoryGraph.explicitBadge')}
          </span>
        )}
        <div style={{ fontSize: 12.5, lineHeight: 1.35, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{fact.content}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <div className="setting-desc" style={{ flex: 1, minWidth: 0, fontSize: 10, opacity: 0.75 }}>
          {metaLine(fact, showType)}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {actionsFor(fact.userState).map((a) => (
            <button
              key={a.action}
              className="pill display-pill"
              style={{ padding: '3px 8px', fontSize: 10.5, cursor: 'pointer', ...(a.danger ? { color: '#ff8a8a' } : {}) }}
              onClick={() => act(fact.id, a.action)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  const conflictCard = (conflict: MemoryFactConflictDto, side: 'active' | 'invalidated') => {
    const fact = side === 'active' ? conflict.active : conflict.invalidated
    const isActive = side === 'active'
    return (
      <div
        className="setting-row vertical"
        style={{
          gap: 2,
          padding: '8px',
          borderRadius: 8,
          flex: 1,
          minWidth: 0,
          border: `1px solid ${isActive ? 'rgba(127,208,160,0.35)' : 'rgba(255,138,138,0.35)'}`
        }}
      >
        <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 2 }}>
          {isActive ? t('memoryGraph.activeSide') : t('memoryGraph.invalidatedSide')}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.35, wordBreak: 'break-word' }}>{fact.content}</div>
        <div className="setting-desc" style={{ fontSize: 10, opacity: 0.75 }}>
          {metaLine(fact, false)}
        </div>
        <button
          className="pill display-pill"
          style={{ padding: '3px 8px', fontSize: 10.5, cursor: 'pointer', marginTop: 4, alignSelf: 'flex-start' }}
          onClick={() => resolve(conflict, isActive ? 'keep-active' : 'keep-invalidated')}
        >
          {isActive ? t('memoryGraph.keepActive') : t('memoryGraph.keepInvalidated')}
        </button>
      </div>
    )
  }

  /** 分组视图：画像两分（显式永远优先）+ 其余 type 组 + 扩展 type 兜底组。 */
  const visible = filter === 'all' ? facts : facts.filter((f) => f.type === filter)
  const groups: Array<{ key: string; title: string; desc?: string; rows: MemoryFactDto[] }> = []
  if (filter === 'all' || filter === 'profile') {
    // 画像两分区只收 profile 型事实：其他 type 的 user/inferred 来源事实
    // 仅在各自 type 组出现一次，避免 'all' 视图下双重渲染
    const explicit = visible.filter((f) => f.type === 'profile' && f.source === 'user')
    const inferred = visible.filter((f) => f.type === 'profile' && f.source !== 'user')
    if (explicit.length > 0) {
      groups.push({ key: 'profile-explicit', title: t('memoryGraph.profileExplicitTitle'), desc: t('memoryGraph.profileExplicitDesc'), rows: explicit })
    }
    if (inferred.length > 0) {
      groups.push({ key: 'profile-inferred', title: t('memoryGraph.profileInferredTitle'), desc: t('memoryGraph.profileInferredDesc'), rows: inferred })
    }
  }
  for (const type of FACT_TYPES) {
    if (type === 'profile') continue
    const rows = visible.filter((f) => f.type === type)
    if (rows.length > 0) groups.push({ key: type, title: typeLabel(type), rows })
  }
  const others = visible.filter((f) => !FACT_TYPES.includes(f.type as (typeof FACT_TYPES)[number]))
  if (others.length > 0) groups.push({ key: '__other__', title: t('memoryGraph.typeOther'), rows: others })

  return (
    <>
      <div className="setting-group-label">{t('memoryGraph.sectionTitle')}</div>
      <div className="setting-desc" style={{ marginTop: 2, marginBottom: 8 }}>{t('memoryGraph.sectionDesc')}</div>

      {/* Type filter pills: 过滤视图（spec 决策 10：分组 = 按 fact type 过滤）。 */}
      <div className="setting-pills" style={{ marginBottom: 8 }}>
        {(['all', ...FACT_TYPES] as const).map((type) => (
          <button
            key={type}
            className={`pill ${filter === type ? 'active' : ''}`}
            onClick={() => { playButtonClickSound(); setFilter(type) }}
          >
            {type === 'all' ? t('memoryGraph.filterAll') : typeLabel(type)}
          </button>
        ))}
      </div>

      {/* ── Conflicts: 并排展示 + 三选裁决（不自动覆盖） ── */}
      <div className="setting-title" style={{ fontSize: 12, marginBottom: 2 }}>{t('memoryGraph.conflictsTitle')}</div>
      <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.75, marginBottom: 4 }}>{t('memoryGraph.conflictsDesc')}</div>
      {conflicts.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memoryGraph.conflictsEmpty')}</div>
      ) : (
        conflicts.map((c) => (
          <div key={`${c.active.id}-${c.invalidated.id}`} className="setting-row vertical" style={{ gap: 6, padding: '4px 0 8px' }}>
            <div style={{ fontSize: 10, opacity: 0.6 }}>{typeLabel(c.active.type)}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', width: '100%' }}>
              {conflictCard(c, 'active')}
              {conflictCard(c, 'invalidated')}
            </div>
            <button
              className="pill display-pill"
              style={{ padding: '3px 8px', fontSize: 10.5, cursor: 'pointer', alignSelf: 'flex-start', color: '#ff8a8a' }}
              onClick={() => resolve(c, 'keep-none')}
            >
              {t('memoryGraph.keepNone')}
            </button>
          </div>
        ))
      )}

      <div className="setting-divider" />

      {/* ── Type groups: 画像两分 + 其余 type（含扩展兜底） ── */}
      {facts.length === 0 && conflicts.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>
          {payload?.degraded ? t('memoryGraph.emptyDegraded') : t('memoryGraph.empty')}
        </div>
      ) : groups.length === 0 ? (
        <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.6 }}>{t('memoryGraph.filterEmpty')}</div>
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <div className="setting-title" style={{ fontSize: 12, marginBottom: 2, marginTop: 6 }}>{g.title}</div>
            {g.desc && <div className="setting-desc" style={{ fontSize: 10.5, opacity: 0.75, marginBottom: 4 }}>{g.desc}</div>}
            {g.rows.map((f) => factRow(f, g.key !== 'profile-explicit' && g.key !== 'profile-inferred'))}
            <div className="setting-divider" />
          </div>
        ))
      )}
    </>
  )
}
