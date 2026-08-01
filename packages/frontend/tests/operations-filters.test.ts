// RFC-246 — business views are deterministic projections over each API's
// complete authorized list. These tests lock overlap and unknown-state edges.

import type { CachedRepo, ScheduledTaskListItem } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'

import {
  filterRepoOperations,
  filterScheduledOperations,
  repoNeedsAttention,
  repoOperationsFacets,
  scheduledNeedsAttention,
  scheduledNeedsRepair,
  scheduledOperationsFacets,
} from '@/lib/operations-filters'

function schedule(
  id: string,
  overrides: Partial<ScheduledTaskListItem> = {},
): ScheduledTaskListItem {
  return {
    id,
    name: `schedule-${id}`,
    ownerUserId: 'owner-1',
    owner: { id: 'owner-1', username: 'alice', displayName: 'Alice' },
    launchKind: 'workflow',
    launchPayload: { workflowId: 'wf-1', name: 'run', inputs: {} },
    scheduleSpec: { kind: 'daily', at: '02:30', timezone: 'UTC' },
    migrationNeeded: false,
    migrationError: null,
    enabled: true,
    nextRunAt: 10,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastTaskId: null,
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function repo(id: string, overrides: Partial<CachedRepo> = {}): CachedRepo {
  return {
    id,
    urlRedacted: `git@example.com/org/${id}.git`,
    localPath: `/cache/${id}`,
    defaultBranch: 'main',
    lastFetchedAt: '2026-08-01T00:00:00.000Z',
    lastAutoRefreshAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    referencingTaskCount: 0,
    hasSubmodules: false,
    lastSubmoduleSyncOk: null,
    lastSubmoduleSyncError: null,
    ...overrides,
  }
}

describe('scheduled operations views', () => {
  test('attention includes repair/failure facts and can overlap enabled', () => {
    const rows = [
      schedule('healthy'),
      schedule('failed', { lastStatus: 'failed', lastError: 'boom' }),
      schedule('paused', { enabled: false }),
      schedule('repair', { migrationNeeded: true, launchPayload: null }),
    ]
    expect(scheduledNeedsAttention(rows[1]!)).toBe(true)
    expect(scheduledNeedsAttention(rows[2]!)).toBe(false)
    expect(scheduledNeedsRepair(schedule('outcome-only', { lastStatus: 'failed' }))).toBe(false)
    expect(scheduledNeedsAttention(schedule('outcome-only', { lastStatus: 'failed' }))).toBe(true)
    expect(scheduledOperationsFacets(rows)).toEqual({
      all: 4,
      enabled: 3,
      attention: 2,
      paused: 1,
    })
  })

  test('view, exact filters, schedule text, and owner search compose', () => {
    const rows = [
      schedule('daily-agent', { launchKind: 'agent', lastStatus: 'launched' }),
      schedule('weekly-group', {
        launchKind: 'workgroup',
        owner: { id: 'owner-2', username: 'bob', displayName: 'Bob Chen' },
        ownerUserId: 'owner-2',
        lastStatus: 'failed',
      }),
    ]
    const filtered = filterScheduledOperations(
      rows,
      { view: 'attention', q: 'bob chen', launchKind: 'workgroup', outcome: 'failed' },
      (row) => (row.id.startsWith('weekly') ? 'Every Friday' : 'Every day'),
    )
    expect(filtered.map((row) => row.id)).toEqual(['weekly-group'])
    expect(
      filterScheduledOperations(
        rows,
        { view: 'all', q: 'friday', launchKind: 'all', outcome: 'all' },
        (row) => (row.id.startsWith('weekly') ? 'Every Friday' : 'Every day'),
      ).map((row) => row.id),
    ).toEqual(['weekly-group'])
  })
})

describe('repo operations views', () => {
  test('attention only claims an explicit failed submodule sync', () => {
    const rows = [
      repo('used', { referencingTaskCount: 3 }),
      repo('failed-submodule', {
        hasSubmodules: true,
        lastSubmoduleSyncOk: false,
        lastSubmoduleSyncError: 'failed',
      }),
      repo('pending-submodule', { hasSubmodules: true, lastSubmoduleSyncOk: null }),
    ]
    expect(repoNeedsAttention(rows[1]!)).toBe(true)
    expect(repoNeedsAttention(rows[2]!)).toBe(false)
    expect(repoOperationsFacets(rows)).toEqual({ all: 3, referenced: 1, attention: 1, unused: 2 })
  })

  test('redacted URL/path/branch search composes with explicit tri-state filters', () => {
    const rows = [
      repo('auto-submodule', {
        defaultBranch: 'release/next',
        hasSubmodules: true,
        lastSubmoduleSyncOk: true,
        lastAutoRefreshAt: '2026-08-01T01:00:00.000Z',
      }),
      repo('plain'),
      repo('unknown', { hasSubmodules: null }),
    ]
    expect(
      filterRepoOperations(rows, {
        view: 'all',
        q: 'release/next',
        submodules: 'with',
        autoRefresh: 'refreshed',
      }).map((row) => row.id),
    ).toEqual(['auto-submodule'])
    expect(
      filterRepoOperations(rows, {
        view: 'unused',
        q: '',
        submodules: 'without',
        autoRefresh: 'never',
      }).map((row) => row.id),
    ).toEqual(['plain'])
  })
})
