// RFC-246 — deterministic populated fixtures shared by geometry and visual tests.

import type { Page } from '@playwright/test'

export const OPERATIONS_VISUAL_TIME = new Date('2026-08-01T12:00:00.000Z')

export function scheduledOperationsFixture() {
  const now = OPERATIONS_VISUAL_TIME.getTime()
  return Array.from({ length: 28 }, (_, index) => {
    const paused = index % 7 === 0
    const failed = index % 9 === 0
    return {
      id: `scheduled-ux-${String(index + 1).padStart(2, '0')}`,
      name: index === 1 ? 'Weekly release readiness review' : `Recurring operation ${index + 1}`,
      ownerUserId: index % 3 === 0 ? 'owner-2' : 'owner-1',
      owner:
        index % 3 === 0
          ? { id: 'owner-2', username: 'bob.ops', displayName: 'Bob Operations' }
          : { id: 'owner-1', username: 'alice', displayName: 'Alice' },
      launchKind: index % 3 === 0 ? 'workgroup' : index % 3 === 1 ? 'workflow' : 'agent',
      launchPayload: { name: 'scheduled run', inputs: {}, workflowId: 'workflow-1' },
      scheduleSpec: { kind: 'daily', at: '09:30', timezone: 'UTC' },
      migrationNeeded: false,
      migrationError: null,
      launchPayloadWorkflowId: 'workflow-1',
      enabled: !paused,
      nextRunAt: paused ? null : now + (index + 1) * 3_600_000,
      lastRunAt: index === 0 ? null : now - (index + 1) * 3_600_000,
      lastStatus: index === 0 ? null : failed ? 'failed' : 'launched',
      lastError: failed ? 'Previous launch failed' : null,
      lastTaskId: failed || index === 0 ? null : `task-${index}`,
      consecutiveFailures: failed ? 3 : 0,
      createdAt: now - 86_400_000,
      updatedAt: now,
    }
  })
}

export function repoOperationsFixture() {
  return Array.from({ length: 28 }, (_, index) => ({
    id: `repo-ux-${String(index + 1).padStart(2, '0')}`,
    urlRedacted:
      index === 1
        ? 'git@github.com:example/release-coordination-platform.git'
        : `https://github.com/example/service-${index + 1}.git`,
    localPath: `/var/lib/agent-workflow/repos/cache-${index + 1}-service`,
    defaultBranch: index % 4 === 0 ? 'release/next' : 'main',
    lastFetchedAt: '2026-08-01T08:00:00.000Z',
    lastAutoRefreshAt: index % 3 === 0 ? '2026-08-01T07:30:00.000Z' : null,
    createdAt: '2026-07-01T00:00:00.000Z',
    referencingTaskCount: index % 5,
    hasSubmodules: index % 6 === 0,
    lastSubmoduleSyncOk: index % 12 === 0 ? false : index % 6 === 0 ? true : null,
    lastSubmoduleSyncError: index % 12 === 0 ? 'submodule fetch failed' : null,
  }))
}

export async function routeOperationsSurfaceFixtures(page: Page): Promise<void> {
  await page.route(/\/api\/scheduled-tasks(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: scheduledOperationsFixture() })
      return
    }
    await route.continue()
  })
  await page.route(/\/api\/cached-repos(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: repoOperationsFixture() } })
      return
    }
    await route.continue()
  })
}
