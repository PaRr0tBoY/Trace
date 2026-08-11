/**
 * TaskEditor — guided create/edit form (ADR-0002, ADR-0003).
 *
 * Progressive disclosure top to bottom: title → app grid (multi-select) →
 * clipboard list (3 anchors, expands as apps are picked, +3 per "show
 * more", 15 cap, source-app icons) → note → save/cancel. Create and edit
 * share the form; edit pre-selects the task's apps and linked items (dead
 * snapshots show greyed and cannot be unlinked here).
 *
 * The save button doubles as the AI title trigger (ADR-0003): with an empty
 * title and any context it asks the provider chain for a title first, then
 * silently falls back to the algorithmic title ("X + Y task") when
 * generation fails — saving is never blocked.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useStore } from '../../store/appStore'
import type { SuggestTitleContext } from '../../../shared/ipc'
import type { AppRef, ResourceSnapshot, TaskDto } from '../../../shared/types'
import { appKeyFromIdentity } from '../../../shared/appKey'
import { AppIcon } from './AppIcon'
import { CheckIcon, FileIcon, ImageIcon, LinkIcon } from '../icons'
import { relativeTime } from '../../lib/format'
import {
  buildClipboardRows,
  canSaveTaskForm,
  clipboardPreview,
  fallbackTaskTitle,
  revealStepForApps,
  CLIPBOARD_MAX_ROWS,
  type ClipboardRow
} from '../../lib/taskEditor'

/** What the form hands back to TaskView — identical for create and edit. */
export interface TaskSavePayload {
  title: string
  note?: string
  apps: AppRef[]
  clipboardItemIds: string[]
}

interface Props {
  /** The task being edited, or null when creating a new one. */
  task: TaskDto | null
  onSave: (payload: TaskSavePayload) => void
  onCancel: () => void
}

export function TaskEditor({ task, onSave, onCancel }: Props) {
  const { t } = useTranslation()
  const items = useStore((s) => s.items)
  const getTaskAppOptions = useStore((s) => s.getTaskAppOptions)
  const getAppIcons = useStore((s) => s.getAppIcons)
  const suggestTaskTitle = useStore((s) => s.suggestTaskTitle)

  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [appOptions, setAppOptions] = useState<AppRef[]>([])
  const [selectedApps, setSelectedApps] = useState<Map<string, AppRef>>(
    () => new Map((task?.apps ?? []).map((a) => [a.id, a]))
  )
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    () => new Set((task?.resources ?? []).flatMap((r) => (r.kind === 'clipboard' ? [r.itemId] : [])))
  )
  const [icons, setIcons] = useState<Map<string, string | null>>(new Map())
  /**
   * Reveal enough rows that the form is honest about its state: the
   * app-selection step (3 + 3/app) plus every already-linked clipboard row
   * (edit mode) — a pre-checked item must never hide behind "show more".
   */
  const [visibleCount, setVisibleCount] = useState(() => {
    const appCount = task?.apps.length ?? 0
    const linkedCount = (task?.resources ?? []).filter((r) => r.kind === 'clipboard').length
    return Math.min(CLIPBOARD_MAX_ROWS, Math.max(revealStepForApps(appCount), linkedCount))
  })
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // App options are computed main-side (event bus ∪ clipboard sourceApps);
  // load once on mount. Icon/app failures degrade to the empty grid state.
  useEffect(() => {
    let cancelled = false
    void getTaskAppOptions()
      .then((opts) => {
        if (!cancelled) setAppOptions(opts)
      })
      .catch(() => {
        if (!cancelled) setAppOptions([])
      })
    return () => { cancelled = true }
  }, [getTaskAppOptions])

  /** Linked clipboard refs from the task (itemId → snapshot); empty when creating. */
  const linked = useMemo(() => {
    const m = new Map<string, ResourceSnapshot>()
    for (const r of task?.resources ?? []) {
      if (r.kind === 'clipboard') m.set(r.itemId, r.snapshot)
    }
    return m
  }, [task])

  /**
   * Grid entries = main-provided options ∪ the task's own apps. The task's
   * AppRef wins on id collision: it may carry attribution context
   * (lastContext) the bus copy lacks, and it must stay selectable and
   * deselected-able even when absent from both bus and clipboard.
   */
  const options = useMemo(() => {
    const byId = new Map<string, AppRef>()
    for (const a of task?.apps ?? []) byId.set(a.id, a)
    for (const a of appOptions) if (!byId.has(a.id)) byId.set(a.id, a)
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [appOptions, task])

  const rows = useMemo(
    () => buildClipboardRows(items, new Set(selectedApps.keys()), linked, selectedItemIds),
    [items, selectedApps, linked, selectedItemIds]
  )

  const visibleRows = useMemo(
    () => rows.slice(0, Math.min(visibleCount, CLIPBOARD_MAX_ROWS)),
    [rows, visibleCount]
  )

  /** Previews of everything the save will attach — the AI title context. */
  const checkedPreviews = useMemo(() => {
    const previews: string[] = []
    for (const row of rows) {
      if (!row.checked) continue
      previews.push(row.item ? clipboardPreview(row.item) : row.dead!.preview)
    }
    // Edit mode: linked files resources travel along as context too.
    for (const r of task?.resources ?? []) {
      if (r.kind === 'files') previews.push(r.paths.slice(0, 3).join(', '))
    }
    return previews
  }, [rows, task])

  // Icons on demand (app:icons, cache-first): everything visible — grid
  // entries plus the source apps of the revealed clipboard rows.
  useEffect(() => {
    const paths = new Set<string>()
    for (const opt of options) if (opt.exePath) paths.add(opt.exePath)
    for (const row of visibleRows) if (row.item?.sourceApp?.exePath) paths.add(row.item.sourceApp.exePath)
    const missing = [...paths].filter((p) => !icons.has(p))
    if (missing.length === 0) return
    let cancelled = false
    void getAppIcons(missing)
      .then((res) => {
        if (cancelled) return
        setIcons((prev) => {
          const next = new Map(prev)
          for (const p of missing) next.set(p, res[p] ?? null)
          return next
        })
      })
      .catch(() => { /* icons are cosmetic — rows fall back to letter glyphs */ })
    return () => { cancelled = true }
  }, [options, visibleRows, icons, getAppIcons])

  const toggleApp = (app: AppRef): void => {
    const next = new Map(selectedApps)
    if (next.has(app.id)) {
      next.delete(app.id)
      // The app's rows leave the candidate list — its checked items must
      // not linger invisibly in the save payload.
      setSelectedItemIds((prev) => {
        const drop = new Set<string>()
        for (const it of items) {
          if (it.sourceApp && appKeyFromIdentity(it.sourceApp) === app.id) drop.add(it.id)
        }
        if (drop.size === 0) return prev
        const nextSel = new Set(prev)
        for (const id of drop) nextSel.delete(id)
        return nextSel
      })
    } else {
      next.set(app.id, app)
    }
    setSelectedApps(next)
    // Progressive disclosure: each selected app reveals one +3 step of the
    // clipboard list (anchors first, cap 15). Never shrinks the reveal.
    setVisibleCount((c) => Math.max(c, revealStepForApps(next.size)))
  }

  const toggleItem = (row: ClipboardRow): void => {
    if (row.item === null) return // dead snapshots are informational only
    setSelectedItemIds((prev) => {
      const next = new Set(prev)
      if (next.has(row.key)) next.delete(row.key)
      else next.add(row.key)
      return next
    })
  }

  /** ADR-0003 path 2: empty title with context → AI title; any failure silently degrades to the algorithmic title. */
  const resolveTitle = async (apps: AppRef[], noteTrimmed: string): Promise<string> => {
    const appNames = apps.map((a) => a.name)
    const ctx: SuggestTitleContext = {
      note: noteTrimmed || undefined,
      appNames,
      resourcePreviews: checkedPreviews
    }
    try {
      const candidates = await suggestTaskTitle(ctx)
      if (candidates && candidates.length > 0 && candidates[0].trim().length > 0) {
        return candidates[0].trim()
      }
    } catch {
      // fall through — never block saving over a title suggestion
    }
    return fallbackTaskTitle(appNames, noteTrimmed, checkedPreviews)
  }

  const handleSave = async (): Promise<void> => {
    if (saving) return
    const trimmedTitle = title.trim()
    const noteTrimmed = note.trim()
    const apps = [...selectedApps.values()]
    const clipboardItemIds = [...selectedItemIds]
    if (!canSaveTaskForm(trimmedTitle, apps.length > 0, clipboardItemIds.length > 0, noteTrimmed)) return
    setSaving(true)
    try {
      const finalTitle = trimmedTitle.length > 0 ? trimmedTitle : await resolveTitle(apps, noteTrimmed)
      onSave({ title: finalTitle, note: noteTrimmed || undefined, apps, clipboardItemIds })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="task-editor">
      <input
        ref={titleRef}
        className="task-editor-input"
        placeholder={t('tasks.titlePlaceholder')}
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleSave()
          if (e.key === 'Escape') onCancel()
        }}
      />

      <section className="task-editor-section">
        <div className="task-editor-section-title">{t('tasks.processesTitle')}</div>
        {options.length === 0 ? (
          <div className="task-editor-empty">{t('tasks.processesEmpty')}</div>
        ) : (
          <div className="task-editor-apps">
            {options.map((app) => {
              const selected = selectedApps.has(app.id)
              return (
                <button
                  type="button"
                  key={app.id}
                  className={`task-editor-app${selected ? ' selected' : ''}`}
                  title={app.exePath ?? app.name}
                  onClick={() => toggleApp(app)}
                >
                  <AppIcon
                    app={{ name: app.name, iconUrl: app.exePath ? icons.get(app.exePath) ?? undefined : undefined }}
                    size={22}
                  />
                  <span className="task-editor-app-name">{app.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <section className="task-editor-section">
        <div className="task-editor-section-title">{t('tasks.clipboardTitle')}</div>
        {rows.length === 0 ? (
          <div className="task-editor-empty">{t('tasks.clipboardEmpty')}</div>
        ) : (
          <div className="task-editor-clipboard">
            {visibleRows.map((row) => {
              const source = row.item?.sourceApp
              return (
                <button
                  type="button"
                  key={row.key}
                  className={`task-editor-row${row.checked ? ' checked' : ''}${row.item === null ? ' dead' : ''}`}
                  disabled={row.item === null}
                  title={row.item === null ? t('tasks.resourceDead') : undefined}
                  onClick={() => toggleItem(row)}
                >
                  <span className="task-editor-row-icon">
                    {source ? (
                      <AppIcon
                        app={{ name: source.name, iconUrl: source.exePath ? icons.get(source.exePath) ?? undefined : undefined }}
                        size={16}
                      />
                    ) : row.item ? (
                      row.item.data.kind === 'text' ? (
                        row.item.data.isUrl ? <LinkIcon width={13} height={13} /> : <FileIcon width={13} height={13} />
                      ) : (
                        <ImageIcon width={13} height={13} />
                      )
                    ) : null}
                  </span>
                  <span className="task-editor-row-preview">
                    {row.item ? clipboardPreview(row.item) : row.dead!.preview}
                  </span>
                  <span className="task-editor-row-meta">
                    {row.item ? relativeTime(row.item.capturedAt) : t('tasks.resourceDead')}
                    {row.checked && <CheckIcon width={12} height={12} />}
                  </span>
                </button>
              )
            })}
            {rows.length > visibleRows.length && (
              <button
                type="button"
                className="task-editor-more"
                onClick={() => setVisibleCount((c) => Math.min(CLIPBOARD_MAX_ROWS, c + 3))}
              >
                {t('tasks.showMore')}
              </button>
            )}
          </div>
        )}
      </section>

      <textarea
        className="task-editor-textarea"
        placeholder={t('tasks.notePlaceholder')}
        value={note}
        rows={4}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />

      <div className="task-editor-actions">
        <button type="button" className="task-btn" onClick={onCancel} disabled={saving}>
          {t('tasks.cancel')}
        </button>
        <button
          type="button"
          className="task-btn primary"
          disabled={!canSaveTaskForm(title, selectedApps.size > 0, selectedItemIds.size > 0, note) || saving}
          onClick={() => void handleSave()}
        >
          {saving ? t('tasks.saving') : t('tasks.save')}
        </button>
      </div>
    </div>
  )
}
