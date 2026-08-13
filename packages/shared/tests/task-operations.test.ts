// RFC-244 — high-density task operations shared contract locks.

import { describe, expect, test } from 'bun:test'

import {
  TASK_LIST_ACTIVE_STATUSES,
  TASK_LIST_FINISHED_STATUSES,
  TASK_LIST_ORIGINS,
  TASK_LAUNCH_ORIGINS,
  TASK_STATUS,
  StartTaskSchema,
  TaskLaunchOriginSchema,
  TaskListOriginSchema,
  TaskOperationsChildPageSchema,
  TaskOperationsListItemSchema,
  TaskOperationsRootPageSchema,
  canonicalTaskStatuses,
  parseTaskStatusList,
  taskMatchesListView,
  type TaskOperationsListItem,
} from '../src'

function item(): TaskOperationsListItem {
  return {
    id: 'task-1',
    name: 'Task one',
    workflowId: 'wf-1',
    workflowName: 'Workflow one',
    repoPath: '/repo',
    repoUrl: null,
    cachedRepoId: null,
    status: 'running',
    startedAt: 10,
    finishedAt: null,
    errorSummary: null,
    repoCount: 1,
    spaceKind: 'remote',
    ownerUserId: 'user-1',
    owner: { id: 'user-1', username: 'alice', displayName: 'Alice' },
    childCount: 2,
    executionClock: { runningMs: 500, runningSince: 20 },
    listContext: {
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 1,
      matchingDescendantCount: 1,
      branchStartedAt: 30,
    },
  }
}

describe('RFC-244 task list view single source', () => {
  test('active and finished are a disjoint exhaustive TASK_STATUS partition', () => {
    expect(new Set([...TASK_LIST_ACTIVE_STATUSES, ...TASK_LIST_FINISHED_STATUSES])).toEqual(
      new Set(TASK_STATUS),
    )
    expect(
      TASK_LIST_ACTIVE_STATUSES.filter((status) =>
        (TASK_LIST_FINISHED_STATUSES as readonly string[]).includes(status),
      ),
    ).toEqual([])
  })

  test('attention overlaps failed and human waits, and any open alert qualifies', () => {
    expect(taskMatchesListView('attention', 'failed')).toBe(true)
    expect(taskMatchesListView('attention', 'awaiting_review')).toBe(true)
    expect(taskMatchesListView('attention', 'awaiting_human')).toBe(true)
    expect(taskMatchesListView('attention', 'running')).toBe(false)
    expect(taskMatchesListView('attention', 'running', true)).toBe(true)
  })

  test('status query parser rejects empty/unknown tokens and canonicalizes duplicates', () => {
    expect(parseTaskStatusList('running,failed,running')).toEqual(['running', 'failed'])
    expect(canonicalTaskStatuses(['failed', 'pending'])).toEqual(['pending', 'failed'])
    expect(parseTaskStatusList('')).toBeNull()
    expect(parseTaskStatusList('running,')).toBeNull()
    expect(parseTaskStatusList('future')).toBeNull()
  })
})

describe('RFC-301 task launch-origin contract', () => {
  test('persisted and query literals are closed, ordered, and include webhook/api', () => {
    expect(TASK_LAUNCH_ORIGINS).toEqual(['manual', 'scheduled', 'webhook', 'api'])
    expect(TASK_LIST_ORIGINS).toEqual(['all', 'manual', 'scheduled', 'webhook', 'api'])
    for (const origin of TASK_LAUNCH_ORIGINS) {
      expect(TaskLaunchOriginSchema.parse(origin)).toBe(origin)
      expect(TaskListOriginSchema.parse(origin)).toBe(origin)
    }
    expect(TaskListOriginSchema.parse('all')).toBe('all')
    for (const invalid of ['', 'API', 'node', 'future']) {
      expect(TaskLaunchOriginSchema.safeParse(invalid).success).toBe(false)
      expect(TaskListOriginSchema.safeParse(invalid).success).toBe(false)
    }
  })

  test('launch origin stays internal: create input strips it and list items reject it', () => {
    const parsed = StartTaskSchema.parse({
      workflowId: 'wf-1',
      name: 'wire-negative-space',
      inputs: {},
      scratch: true,
      launchOrigin: 'api',
      launch_origin: 'webhook',
    })
    expect(parsed).not.toHaveProperty('launchOrigin')
    expect(parsed).not.toHaveProperty('launch_origin')
    expect(TaskOperationsListItemSchema.safeParse({ ...item(), launchOrigin: 'api' }).success).toBe(
      false,
    )
  })
})

describe('RFC-244 strict page schemas', () => {
  test('root requires facets and child forbids them', () => {
    const root = {
      kind: 'root' as const,
      items: [item()],
      nextCursor: null,
      facets: { all: 1, active: 1, attention: 0, finished: 0 },
    }
    expect(TaskOperationsRootPageSchema.parse(root)).toEqual(root)

    const child = {
      kind: 'children' as const,
      parentId: 'parent',
      items: [item()],
      nextCursor: null,
    }
    expect(TaskOperationsChildPageSchema.parse(child)).toEqual(child)
    expect(TaskOperationsChildPageSchema.safeParse({ ...child, facets: root.facets }).success).toBe(
      false,
    )
  })

  test('item rejects negative clocks/counts and unknown projection keys', () => {
    expect(
      TaskOperationsListItemSchema.safeParse({
        ...item(),
        executionClock: { runningMs: -1, runningSince: null },
      }).success,
    ).toBe(false)
    expect(
      TaskOperationsListItemSchema.safeParse({ ...item(), workflowSnapshot: '{}' }).success,
    ).toBe(false)
  })
})
