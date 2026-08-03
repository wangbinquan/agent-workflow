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

function repoNode(index: number, path: string, readonly = false) {
  const repo = repoOperationsFixture()[index - 1]!
  return {
    path,
    attachment: {
      kind: 'repo' as const,
      cachedRepoId: repo.id,
      repoUrlRedacted: repo.urlRedacted,
      ref: index % 4 === 0 ? 'release/next' : '',
      subdir: index === 3 ? 'packages/core' : '',
      readonly,
    },
  }
}

export function repoGroupOperationsFixture() {
  const flatNodes = [
    { path: '', attachment: null },
    ...Array.from({ length: 20 }, (_, index) => repoNode(index + 1, `service-${index + 1}`)),
  ]
  const nestedNodes = [
    { path: '', attachment: null },
    { path: 'apps', attachment: null },
    repoNode(1, 'apps/web'),
    { path: 'docs', attachment: null },
    { path: 'vendor', attachment: null },
    repoNode(2, 'vendor/sdk', true),
    repoNode(3, 'vendor/sdk/ext'),
  ]
  const base = {
    description: '',
    version: 1,
    schemaVersion: 2,
    createdByUserId: 'owner-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    boundMemories: 0,
  }
  return [
    {
      ...base,
      id: 'group-flat-20',
      name: 'Product platform · 20 repositories',
      description: 'A dense flat workspace for day-to-day product changes',
      nodes: flatNodes,
      directNodeCount: flatNodes.length,
      flatRepoCount: 20,
    },
    {
      ...base,
      id: 'group-nested-3',
      name: 'Platform with nested SDK',
      description: 'Apps, documentation, and a three-level vendor subtree',
      nodes: nestedNodes,
      directNodeCount: nestedNodes.length,
      flatRepoCount: 3,
    },
  ]
}

function layoutForNodes(nodes: Array<{ path: string; attachment: unknown }>, groupName: string) {
  const reposById = new Map(repoOperationsFixture().map((repo) => [repo.id, repo]))
  const repos = nodes.flatMap((node) => {
    const attachment = node.attachment as {
      kind: 'repo'
      cachedRepoId?: string
      repoUrl?: string
      ref?: string
      subdir?: string
      readonly?: boolean
    } | null
    if (attachment?.kind !== 'repo') return []
    const cached = reposById.get(attachment.cachedRepoId ?? '')
    return [
      {
        cachedRepoId: attachment.cachedRepoId ?? `pending:${node.path}`,
        repoUrlRedacted: cached?.urlRedacted ?? attachment.repoUrl ?? '',
        ref: attachment.ref ?? '',
        subdir: attachment.subdir ?? '',
        mountPath: node.path,
        readonly: attachment.readonly ?? false,
        viaGroups: [{ id: 'visual-group', name: groupName }],
      },
    ]
  })
  return {
    groupId: 'visual-group',
    groupName,
    nodes: nodes.map((node) => ({
      path: node.path,
      origins: [
        {
          groupId: 'visual-group',
          groupName,
          viaGroups: [{ id: 'visual-group', name: groupName }],
        },
      ],
    })),
    repos,
    totalRepos: repos.length,
    totalNodes: nodes.length,
    maxDepth: 0,
    pendingImports: repos.filter((repo) => repo.cachedRepoId.startsWith('pending:')).length,
    pendingRepoPaths: repos
      .filter((repo) => repo.cachedRepoId.startsWith('pending:'))
      .map((repo) => repo.mountPath),
  }
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
  await page.route(/\/api\/repo-groups(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { items: repoGroupOperationsFixture() } })
      return
    }
    await route.continue()
  })
  await page.route(/\/api\/repo-groups\/preview(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        name?: string
        nodes: Array<{ path: string; attachment: unknown }>
      }
      await route.fulfill({ json: layoutForNodes(body.nodes, body.name ?? 'Unsaved group') })
      return
    }
    await route.continue()
  })
  await page.route(/\/api\/repo-groups\/([^/?]+)\/layout(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
      const id = route
        .request()
        .url()
        .match(/\/api\/repo-groups\/([^/?]+)\/layout/)?.[1]
      const group = repoGroupOperationsFixture().find((item) => item.id === id)
      if (group !== undefined) {
        await route.fulfill({ json: layoutForNodes(group.nodes, group.name) })
        return
      }
    }
    await route.continue()
  })
}
