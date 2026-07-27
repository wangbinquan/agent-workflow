// RFC-232 — only the dedicated /tasks table opts into the wider task-list wire.

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

    expect(taskList).toContain("include_owner: 'true'")
    for (const source of unchangedConsumers) {
      expect(source).not.toContain('include_owner')
      expect(source).not.toContain('TaskListItem')
    }
  })
})
