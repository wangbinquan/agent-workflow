// RFC-192 (T1) — /tasks client-side subject × search filter.
//
// Subject classification goes through the SHARED taskExecutionKind (RFC-165
// single derivation point) — including its precedence: a row with BOTH
// workgroupId and sourceAgentName classifies as workgroup, never agent.

import { describe, expect, expectTypeOf, test } from 'vitest'
import type { TaskListItem, TaskSummary } from '@agent-workflow/shared'
import { TASK_LIST_SUBJECTS, type taskExecutionKind } from '@agent-workflow/shared'
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
  // RFC-304 — a code round. `codeRoundId` outranks every other discriminator in
  // `taskExecutionKind`, which is why this row also carries a workgroup: a
  // filter that classified it as anything else would hide it from the only
  // bucket that names it.
  row('review-round', { codeRoundId: 'cr1', workgroupId: 'wg3' }),
]

describe('filterTaskRows', () => {
  test('EVERY execution kind is offered as a filter option', () => {
    // The stronger invariant, and the one the previous test misses: the filter
    // FUNCTION works for any string, so widening only its type leaves the
    // option absent from the UI — the bucket exists and nothing can select it.
    // Mutating `TASK_LIST_SUBJECTS` alone left the other tests green, which is
    // how that gap would ship.
    //
    // Enumerated from `taskExecutionKind`'s own return union rather than a
    // hand-written list, so a fifth kind fails here the day it is added.
    const kinds: Array<ReturnType<typeof taskExecutionKind>> = [
      'code-round',
      'workgroup',
      'agent',
      'workflow',
    ]
    for (const kind of kinds) {
      expect(TASK_LIST_SUBJECTS).toContain(kind)
    }
  })

  test('code rounds are selectable, and outrank every other discriminator', () => {
    // Before T34 the subject union had no `code-round`, so a review task fell
    // into no bucket at all: picking ANY subject hid it, and only "all" showed
    // it. That is worse than a missing filter — the row exists, and the list
    // silently omits it.
    expect(filterTaskRows(ROWS, { subject: 'code-round', search: '' }).map((r) => r.name)).toEqual([
      'review-round',
    ])
  })

  test('a code round does NOT leak into the workgroup bucket', () => {
    // `review-round` carries a workgroupId too. If precedence were re-derived
    // here instead of deferring to `taskExecutionKind`, it would appear twice.
    expect(filterTaskRows(ROWS, { subject: 'workgroup', search: '' }).map((r) => r.name)).toEqual([
      'group-run',
      'both-set',
    ])
  })

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

  test('generic filter preserves the owner-bearing list-item type', () => {
    const ownerRows: TaskListItem[] = [
      {
        ...row('owner-row'),
        ownerUserId: 'u1',
        owner: { id: 'u1', username: 'alice', displayName: 'Alice' },
        childCount: 0,
      },
    ]
    const filtered = filterTaskRows(ownerRows, { subject: 'all', search: '' })
    expectTypeOf(filtered).toEqualTypeOf<TaskListItem[]>()
    expect(filtered[0]?.owner?.username).toBe('alice')
  })
})
