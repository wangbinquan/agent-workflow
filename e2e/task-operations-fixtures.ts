import type { Page } from '@playwright/test'
import type { TaskLaunchOrigin } from '@agent-workflow/shared'

const STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const

type FixtureStatus = (typeof STATUSES)[number]
type MatchKind = 'self' | 'context'
type ParentAvailability = 'none' | 'visible' | 'unavailable'

interface ItemOptions {
  name?: string
  status?: FixtureStatus
  startedAt?: number
  finishedAt?: number | null
  ownerUserId?: string | null
  owner?: { id: string; username: string; displayName: string } | null
  repoPath?: string
  workflowName?: string | null
  workgroupId?: string | null
  workgroupName?: string | null
  sourceAgentId?: string | null
  sourceAgentName?: string | null
  scheduledTaskId?: string | null
  parentTaskId?: string | null
  invocationDepth?: number
  childCount?: number
  openAlertCount?: number
  errorSummary?: string | null
  matchKind?: MatchKind
  parentAvailability?: ParentAvailability
  qualifyingChildCount?: number
  matchingDescendantCount?: number
  branchStartedAt?: number
}

interface FixtureOptions {
  primaryId?: string
  primaryName?: string
  workflowName?: string
}

export interface TaskOperationsFixtureController {
  requests: string[]
  failRoot: boolean
  failChildFor: string | null
}

const DEFAULT_OWNER = {
  id: 'fixture-owner',
  username: 'fixture-owner',
  displayName: 'Fixture Owner',
}

function isTerminal(status: FixtureStatus): boolean {
  return (
    status === 'done' || status === 'failed' || status === 'canceled' || status === 'interrupted'
  )
}

function item(id: string, now: number, options: ItemOptions = {}) {
  const status = options.status ?? 'done'
  const startedAt = options.startedAt ?? now - 3_600_000
  return {
    id,
    name: options.name ?? id,
    workflowId: 'fixture-workflow-id',
    workflowName: options.workflowName ?? 'Task operations fixture workflow',
    repoPath: options.repoPath ?? '/tmp/agent-workflow-task-operations-fixture',
    repoUrl: null,
    cachedRepoId: null,
    status,
    startedAt,
    finishedAt:
      options.finishedAt === undefined
        ? isTerminal(status)
          ? startedAt + 420_000
          : null
        : options.finishedAt,
    errorSummary: options.errorSummary ?? null,
    repoCount: 1,
    openAlertCount: options.openAlertCount ?? 0,
    scheduledTaskId: options.scheduledTaskId ?? null,
    workgroupId: options.workgroupId ?? null,
    workgroupName: options.workgroupName ?? null,
    spaceKind: 'remote',
    parentTaskId: options.parentTaskId ?? null,
    invocationDepth: options.invocationDepth ?? 0,
    sourceAgentName: options.sourceAgentName ?? null,
    sourceAgentId: options.sourceAgentId ?? null,
    ownerUserId: options.ownerUserId === undefined ? DEFAULT_OWNER.id : options.ownerUserId,
    owner: options.owner === undefined ? DEFAULT_OWNER : options.owner,
    childCount: options.childCount ?? 0,
    executionClock: {
      runningMs: status === 'running' ? 180_000 : 0,
      runningSince: status === 'running' ? now - 120_000 : null,
    },
    listContext: {
      matchKind: options.matchKind ?? 'self',
      parentAvailability: options.parentAvailability ?? 'none',
      qualifyingChildCount: options.qualifyingChildCount ?? 0,
      matchingDescendantCount: options.matchingDescendantCount ?? 0,
      branchStartedAt: options.branchStartedAt ?? startedAt,
    },
  }
}

function viewMatches(row: ReturnType<typeof item>, view: string): boolean {
  if (view === 'active') {
    return ['pending', 'running', 'awaiting_review', 'awaiting_human'].includes(row.status)
  }
  if (view === 'attention') {
    return (
      ['failed', 'awaiting_review', 'awaiting_human'].includes(row.status) || row.openAlertCount > 0
    )
  }
  if (view === 'finished') return ['done', 'failed', 'canceled', 'interrupted'].includes(row.status)
  return true
}

function subjectMatches(row: ReturnType<typeof item>, subject: string): boolean {
  if (subject === 'workgroup') return row.workgroupId !== null
  if (subject === 'agent') return row.sourceAgentId !== null
  if (subject === 'workflow') return row.workgroupId === null && row.sourceAgentId === null
  return true
}

/**
 * Deterministic RFC-244 browser fixture. It represents 30+ root tasks, every
 * lifecycle status, alerts, scheduled launches, unavailable parents, long
 * content, a three-level search-only branch, and a separately paged sibling
 * branch. The browser still runs the production frontend and authenticated
 * shell; only the new list endpoint is intercepted.
 */
export async function routeTaskOperationsFixture(
  page: Page,
  options: FixtureOptions = {},
): Promise<TaskOperationsFixtureController> {
  const controller: TaskOperationsFixtureController = {
    requests: [],
    failRoot: false,
    failChildFor: null,
  }
  const now = Date.now()
  const primaryId = options.primaryId ?? 'ux-task-1'
  const workflowName = options.workflowName ?? 'Task operations fixture workflow'
  const primary = item(primaryId, now, {
    name: options.primaryName ?? 'Responsive task operations row',
    workflowName,
    status: 'done',
  })
  const firstRootPage = [
    primary,
    item('dense-running', now, {
      name: 'Running release verification',
      status: 'running',
      startedAt: now - 480_000,
    }),
    item('dense-pending', now, { name: 'Queued dependency scan', status: 'pending' }),
    item('dense-review', now, {
      name: 'Review production rollout',
      status: 'awaiting_review',
    }),
    item('dense-human', now, {
      name: 'Clarify regional deployment policy',
      status: 'awaiting_human',
    }),
    item('dense-failed', now, {
      name: 'Failed integration verification',
      status: 'failed',
      errorSummary: 'The verification command exited with a non-zero status.',
    }),
    item('dense-canceled', now, { name: 'Canceled documentation pass', status: 'canceled' }),
    item('dense-interrupted', now, {
      name: 'Interrupted migration rehearsal',
      status: 'interrupted',
    }),
    item('dense-alert', now, {
      name: 'Completed task with unresolved lifecycle alert',
      status: 'done',
      openAlertCount: 2,
    }),
    item('dense-scheduled', now, {
      name: 'Nightly scheduled maintenance',
      status: 'pending',
      scheduledTaskId: 'scheduled-fixture',
    }),
    item('branch-many', now, {
      name: 'Fan-out task with many child executions',
      status: 'running',
      childCount: 20,
      qualifyingChildCount: 20,
    }),
    item('tree-root', now, {
      name: 'Three-level context branch',
      childCount: 1,
      qualifyingChildCount: 1,
    }),
    item('unavailable-parent-child', now, {
      name: 'Visible child whose parent is not available',
      status: 'running',
      parentTaskId: 'private-parent',
      invocationDepth: 2,
      parentAvailability: 'unavailable',
    }),
    item('long-content', now, {
      name: 'A deliberately long task title that wraps cleanly without hiding the task identity or forcing the operations list wider than the viewport',
      repoPath:
        '/tmp/a-deliberately-long-repository-display-name-that-must-remain-contained-inside-the-task-cell',
      owner: {
        id: 'owner-with-long-identity',
        username: 'owner-with-a-long-unique-username',
        displayName: 'Owner With A Deliberately Long Display Name',
      },
      ownerUserId: 'owner-with-long-identity',
    }),
    item('workgroup-subject', now, {
      name: 'Workgroup incident response',
      workgroupId: 'fixture-workgroup',
      workgroupName: 'Release response team',
    }),
    item('agent-subject', now, {
      name: 'Single agent research task',
      sourceAgentId: 'fixture-agent',
      sourceAgentName: 'Research agent',
    }),
  ]
  const secondRootPage = Array.from({ length: 18 }, (_, index) =>
    item(`root-page-two-${String(index + 1).padStart(2, '0')}`, now, {
      name: `Additional paged task ${String(index + 1).padStart(2, '0')}`,
      status: STATUSES[index % STATUSES.length],
      startedAt: now - (index + 2) * 60_000,
    }),
  )
  const manyChildren = Array.from({ length: 20 }, (_, index) =>
    item(`branch-child-${String(index + 1).padStart(2, '0')}`, now, {
      name: `Fan-out child execution ${String(index + 1).padStart(2, '0')}`,
      status: STATUSES[index % STATUSES.length],
      parentTaskId: 'branch-many',
      invocationDepth: 1,
      parentAvailability: 'visible',
      startedAt: now - (index + 1) * 30_000,
    }),
  )
  const treeMid = item('tree-middle', now, {
    name: 'Context-only intermediate execution',
    parentTaskId: 'tree-root',
    invocationDepth: 1,
    childCount: 1,
    matchKind: 'context',
    parentAvailability: 'visible',
    qualifyingChildCount: 1,
    matchingDescendantCount: 1,
    branchStartedAt: now - 30_000,
  })
  const deepTarget = item('deep-target', now, {
    name: 'Deep target regression verification',
    status: 'running',
    parentTaskId: 'tree-middle',
    invocationDepth: 2,
    parentAvailability: 'visible',
    startedAt: now - 30_000,
  })

  // Internal-only fixture truth. The intercepted TaskOperations JSON never
  // carries launchOrigin, matching the production wire contract.
  const originByTaskId = new Map<string, TaskLaunchOrigin>()
  for (const row of [...firstRootPage, ...secondRootPage, ...manyChildren, treeMid, deepTarget]) {
    originByTaskId.set(row.id, row.scheduledTaskId === null ? 'manual' : 'scheduled')
  }
  for (const id of ['dense-alert', 'branch-many', ...manyChildren.map((row) => row.id)]) {
    originByTaskId.set(id, 'webhook')
  }
  for (const id of ['tree-root', 'tree-middle', 'deep-target', 'agent-subject']) {
    originByTaskId.set(id, 'api')
  }

  const facets = {
    all: firstRootPage.length + secondRootPage.length,
    active: [...firstRootPage, ...secondRootPage].filter((row) => viewMatches(row, 'active'))
      .length,
    attention: [...firstRootPage, ...secondRootPage].filter((row) => viewMatches(row, 'attention'))
      .length,
    finished: [...firstRootPage, ...secondRootPage].filter((row) => viewMatches(row, 'finished'))
      .length,
  }

  await page.route(/\/api\/tasks\/page(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const requestUrl = new URL(route.request().url())
    controller.requests.push(`${requestUrl.pathname}${requestUrl.search}`)
    const parentId = requestUrl.searchParams.get('parent_id')

    if (parentId === null && controller.failRoot) {
      await route.fulfill({ status: 503, json: { code: 'fixture-root-unavailable' } })
      return
    }
    if (parentId !== null && controller.failChildFor === parentId) {
      await route.fulfill({ status: 503, json: { code: 'fixture-child-unavailable' } })
      return
    }

    const cursor = requestUrl.searchParams.get('cursor')
    const q = requestUrl.searchParams.get('q')?.trim().toLowerCase() ?? ''
    if (parentId !== null) {
      let items: Array<ReturnType<typeof item>> = []
      let nextCursor: string | null = null
      if (parentId === 'branch-many') {
        items = cursor === null ? manyChildren.slice(0, 10) : manyChildren.slice(10)
        nextCursor = cursor === null ? 'branch-many-page-2' : null
      } else if (parentId === 'tree-root') {
        items = [treeMid]
      } else if (parentId === 'tree-middle') {
        items = [deepTarget]
      }
      const origin = requestUrl.searchParams.get('origin') ?? 'all'
      if (origin !== 'all') {
        items = items.filter((row) => originByTaskId.get(row.id) === origin)
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kind: 'children', parentId, items, nextCursor }),
      })
      return
    }

    if (q.includes('deep target')) {
      const contextRoot = {
        ...firstRootPage.find((row) => row.id === 'tree-root')!,
        listContext: {
          ...firstRootPage.find((row) => row.id === 'tree-root')!.listContext,
          matchKind: 'context' as const,
          matchingDescendantCount: 1,
          branchStartedAt: deepTarget.startedAt,
        },
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kind: 'root', items: [contextRoot], nextCursor: null, facets }),
      })
      return
    }

    let rows = cursor === 'root-page-2' ? secondRootPage : firstRootPage
    const view = requestUrl.searchParams.get('view') ?? 'all'
    const statuses = requestUrl.searchParams.get('statuses')?.split(',') ?? []
    const subject = requestUrl.searchParams.get('subject') ?? 'all'
    const origin = requestUrl.searchParams.get('origin') ?? 'all'
    rows = rows.filter(
      (row) =>
        viewMatches(row, view) &&
        (statuses.length === 0 || statuses.includes(row.status)) &&
        subjectMatches(row, subject) &&
        (origin === 'all' || originByTaskId.get(row.id) === origin) &&
        (q === '' ||
          [row.name, row.workflowName, row.repoPath, row.sourceAgentName, row.workgroupName]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLowerCase().includes(q))),
    )
    const nextCursor =
      cursor === null &&
      view === 'all' &&
      statuses.length === 0 &&
      subject === 'all' &&
      origin === 'all'
        ? 'root-page-2'
        : null
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'root', items: rows, nextCursor, facets }),
    })
  })

  return controller
}
