/**
 * Pure helpers for the task layer view. Main already sorts the pushed
 * TaskDto[] (status groups, lastActiveAt descending within a group) — these
 * functions only slice that ordered list into renderable sections.
 */
import type { StatusSource, TaskDto, TaskStatus } from '../../shared/types'

/** Fixed display order of status groups (spec: Running > Waiting > Paused > Completed > Archived). */
export const TASK_GROUP_ORDER: TaskStatus[] = ['running', 'waiting', 'paused', 'completed', 'archived']

export interface TaskGroup {
  status: TaskStatus
  tasks: TaskDto[]
}

/** Partition tasks into the fixed group order, preserving the incoming order inside each group. */
export function groupTasksByStatus(tasks: TaskDto[]): TaskGroup[] {
  const buckets = new Map<TaskStatus, TaskDto[]>()
  for (const status of TASK_GROUP_ORDER) buckets.set(status, [])
  for (const task of tasks) {
    const bucket = buckets.get(task.status)
    if (bucket) bucket.push(task)
  }
  return TASK_GROUP_ORDER.map((status) => ({ status, tasks: buckets.get(status)! }))
}

/** Collapsed-state badge: paused + waiting task count. */
export function taskBadgeCount(tasks: TaskDto[]): number {
  return tasks.reduce((n, t) => (t.status === 'paused' || t.status === 'waiting' ? n + 1 : n), 0)
}

/**
 * Source-aware status label (spec user story 8): tells "you paused this
 * task" (user-driven PAUSED) apart from "the system judged it waiting"
 * (system-driven WAITING). Returns an i18n key, or null when the plain
 * group label already says everything (RUNNING, COMPLETED, ARCHIVED, and
 * legacy PAUSED with no user source).
 */
export function taskStatusHintKey(task: { status: TaskStatus; statusSource?: StatusSource }): string | null {
  if (task.status === 'paused' && task.statusSource === 'user') return 'statusPausedByUser'
  if (task.status === 'waiting') return 'statusWaitingSystem'
  return null
}
