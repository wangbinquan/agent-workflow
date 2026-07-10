// RFC-035 PR1 — locks the homepage task-row retrofit. The status chip
// MUST be the unified <StatusChip>, with the same kind map as
// <TaskStatusChip> (so /tasks list and the homepage row stay visually
// aligned). Test covers a few representative statuses; the full map is
// exercised by tests/task-status-kind.test.ts.

import { describe, expect, test, vi } from 'vitest'
import { render } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import type { TaskSummary, TaskStatus } from '@agent-workflow/shared'

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return { ...actual, useNavigate: () => vi.fn() }
})

import { TaskRow } from '../src/components/home/task-row'
import { TASK_STATUS_KIND } from '../src/lib/task-status'
import '../src/i18n'

function fakeTask(id: string, status: TaskStatus): TaskSummary {
  return {
    id,
    name: 'fixture-task',
    workflowId: 'wf_1',
    workflowName: 'wf-x',
    repoPath: '/tmp/x',
    repoUrl: null,
    status,
    startedAt: 1_700_000_000_000,
    finishedAt: null,
    errorSummary: null,
    // RFC-066: TaskSummarySchema now exposes repoCount.
    repoCount: 1,
    spaceKind: 'remote', // RFC-165
    sourceAgentName: null,
  }
}

describe('homepage <TaskRow /> status chip', () => {
  for (const status of ['running', 'done', 'failed', 'awaiting_human'] as TaskStatus[]) {
    test(`renders status=${status} via unified <StatusChip> kind=${TASK_STATUS_KIND[status]}`, () => {
      const t = fakeTask(`t_${status}`, status)
      const { container } = render(<TaskRow task={t} nowMs={1_700_000_300_000} />)
      const chip = container.querySelector('.status-chip')
      expect(chip, 'status-chip span').not.toBeNull()
      expect(chip?.className).toContain(`status-chip--${TASK_STATUS_KIND[status]}`)
      expect(chip?.className).toContain('status-chip--sm')
    })
  }

  test('row chip carries task-row__status className for legacy visual hooks', () => {
    const t = fakeTask('t_running', 'running')
    const { container } = render(<TaskRow task={t} nowMs={1_700_000_300_000} />)
    const chip = container.querySelector('.status-chip.task-row__status')
    expect(chip).not.toBeNull()
  })
})
