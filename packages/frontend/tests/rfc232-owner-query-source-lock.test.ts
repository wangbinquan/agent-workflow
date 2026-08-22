// RFC-232/RFC-244 — only /tasks uses the owner-enriched operations wire.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relative: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', relative), 'utf8')

describe('RFC-232 — task-list owner query isolation', () => {
  test('/tasks opts in while homepage feeds and schedule run history keep TaskSummary', () => {
    const taskList = read('src/routes/tasks.tsx')
    const unchangedConsumers = [
      read('src/components/home/RunningTaskList.tsx'),
      read('src/components/home/RecentlyDoneList.tsx'),
      read('src/routes/scheduled.$id.tsx'),
    ]

    expect(taskList).toContain('const query = useTaskOperationsPage(')
    expect(taskList).toContain('selectedSource?.id')
    expect(taskList).toContain(
      '<OwnerLabel ownerUserId={item.ownerUserId} owner={item.owner} wrap />',
    )
    const catalogHook = read('src/hooks/useTaskOperationsPage.ts')
    expect(catalogHook).toContain("'/api/task-catalog'")
    expect(catalogHook).toContain('TaskCatalogPageSchema.parse(payload)')
    expect(catalogHook).toContain('type: sourceId')
    expect(catalogHook).not.toContain('provider')
    for (const source of unchangedConsumers) {
      expect(source).not.toContain('include_owner')
      expect(source).not.toContain('TaskListItem')
      expect(source).not.toContain('TaskOperationsListItem')
    }
  })
})
