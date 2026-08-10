import { describe, expect, it } from 'vitest'
import { groupTasksByStatus, taskBadgeCount, TASK_GROUP_ORDER } from '../src/lib/taskGroups'
import type { TaskDto } from '../shared/types'

function task(id: string, status: TaskDto['status']): TaskDto {
  return {
    id,
    title: id,
    status,
    apps: [],
    resources: [],
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  }
}

describe('groupTasksByStatus', () => {
  it('groups into Active > Waiting > Paused > Completed order', () => {
    const tasks = [
      task('c', 'completed'),
      task('p', 'paused'),
      task('a', 'active'),
      task('w', 'waiting')
    ]
    const groups = groupTasksByStatus(tasks)
    expect(groups.map((g) => g.status)).toEqual(TASK_GROUP_ORDER)
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([
      ['a'],
      ['w'],
      ['p'],
      ['c']
    ])
  })

  it('preserves the incoming (main-sorted) order inside a group', () => {
    const groups = groupTasksByStatus([task('a2', 'active'), task('a1', 'active')])
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['a2', 'a1'])
  })

  it('renders empty groups for missing statuses', () => {
    const groups = groupTasksByStatus([task('a', 'active')])
    expect(groups).toHaveLength(4)
    expect(groups.map((g) => g.tasks.length)).toEqual([1, 0, 0, 0])
  })
})

describe('taskBadgeCount', () => {
  it('counts paused + waiting only', () => {
    const tasks = [
      task('a', 'active'),
      task('w1', 'waiting'),
      task('w2', 'waiting'),
      task('p', 'paused'),
      task('c', 'completed')
    ]
    expect(taskBadgeCount(tasks)).toBe(3)
  })

  it('is zero for an empty list', () => {
    expect(taskBadgeCount([])).toBe(0)
  })
})
