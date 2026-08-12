/**
 * TaskList — status-grouped task list (Running > Waiting > Paused > Completed > Archived).
 * Group order and in-group ordering come from main's sorted TaskDto push;
 * this component only slices the list into sections.
 */
import { useTranslation } from '../../i18n'
import { groupTasksByStatus } from '../../lib/taskGroups'
import type { TaskDto, TaskStatus } from '../../../shared/types'
import { TaskCard } from './TaskCard'
import { PlusIcon } from '../icons'

interface Props {
  tasks: TaskDto[]
  onOpen: (task: TaskDto) => void
  onCreate: () => void
  onDeleteRequest: (task: TaskDto) => void
}

const GROUP_LABEL: Record<TaskStatus, string> = {
  running: 'groupRunning',
  waiting: 'groupWaiting',
  paused: 'groupPaused',
  completed: 'groupCompleted',
  archived: 'groupArchived'
}

export function TaskList({ tasks, onOpen, onCreate, onDeleteRequest }: Props) {
  const { t } = useTranslation()
  const groups = groupTasksByStatus(tasks)
  const hasAny = tasks.length > 0

  return (
    <div className="task-list">
      <div className="task-list-header">
        <span className="task-list-title">{t('tasks.viewTitle')}</span>
        <button type="button" className="task-btn primary" onClick={onCreate}>
          <PlusIcon width={13} height={13} />
          {t('tasks.newTask')}
        </button>
      </div>

      {!hasAny ? (
        <div className="task-empty">
          <div className="title">{t('tasks.emptyTitle')}</div>
          <div className="hint">{t('tasks.emptyHint')}</div>
        </div>
      ) : (
        groups.map(
          (group) =>
            group.tasks.length > 0 && (
              <section className="task-group" key={group.status}>
                <div className="task-group-label">
                  <span>{t(`tasks.${GROUP_LABEL[group.status]}`)}</span>
                  <span className="task-group-count">{group.tasks.length}</span>
                </div>
                {group.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onOpen={onOpen}
                    onDeleteRequest={onDeleteRequest}
                  />
                ))}
              </section>
            )
        )
      )}
    </div>
  )
}
