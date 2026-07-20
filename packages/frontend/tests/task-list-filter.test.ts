// RFC-192 (T1) — /tasks client-side subject × search filter.
//
// Subject classification goes through the SHARED taskExecutionKind (RFC-165
// single derivation point) — including its precedence: a row with BOTH
// workgroupId and sourceAgentName classifies as workgroup, never agent.

import { describe, expect, test } from 'vitest'
import type { TaskSummary } from '@agent-workflow/shared'
import { filterTaskRows } from '../src/lib/task-list-filter'

function row(name: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: `t_${name}`,
    name,
    workflowId: 'wf1',
    workflowName: 'wf-one',
    repoPath: '/repo',
    repoUrl: null,
    cachedRepoId: null,
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    errorSummary: null,
    repoCount: 1,
    spaceKind: 'remote',
    ...overrides,
  }
}

const ROWS: TaskSummary[] = [
  row('plain-workflow'),
  row('group-run', { workgroupId: 'wg1', workgroupName: 'crew' }),
  row('agent-run', { sourceAgentName: 'coder' }),
  // Precedence probe: workgroup wins over agent (taskExecutionKind ordering).
  row('both-set', { workgroupId: 'wg2', sourceAgentName: 'coder' }),
]

describe('filterTaskRows', () => {
  test('all + empty search is identity', () => {
    expect(filterTaskRows(ROWS, { subject: 'all', search: '' })).toEqual(ROWS)
  })

  test('subject buckets follow taskExecutionKind (workgroup > agent precedence)', () => {
    expect(filterTaskRows(ROWS, { subject: 'workflow', search: '' }).map((r) => r.name)).toEqual([
      'plain-workflow',
    ])
    expect(filterTaskRows(ROWS, { subject: 'workgroup', search: '' }).map((r) => r.name)).toEqual([
      'group-run',
      'both-set',
    ])
    expect(filterTaskRows(ROWS, { subject: 'agent', search: '' }).map((r) => r.name)).toEqual([
      'agent-run',
    ])
  })

  test('search is case-insensitive substring over the name; AND-composed with subject', () => {
    expect(filterTaskRows(ROWS, { subject: 'all', search: 'RUN' }).map((r) => r.name)).toEqual([
      'group-run',
      'agent-run',
    ])
    expect(
      filterTaskRows(ROWS, { subject: 'workgroup', search: 'run' }).map((r) => r.name),
    ).toEqual(['group-run'])
    expect(filterTaskRows(ROWS, { subject: 'agent', search: 'zzz' })).toEqual([])
  })
})
