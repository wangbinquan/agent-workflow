import {
  TaskCatalogPageSchema,
  TaskCatalogSourcesDocumentSchema,
  type Permission,
  type TaskCatalogListItem,
  type TaskSourceId,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Actor } from '@/auth/actor'
import { TaskCatalogQueryService } from '@/modules/task-catalog/application/taskCatalogQueryService'
import type {
  TaskCatalogSource,
  TaskCatalogSourceListInput,
} from '@/modules/task-catalog/composition/required-ports'
import { composeDigitalEmployeeTaskCatalogSource } from '@/modules/digital-employee/composition'

function actor(permissions: readonly Permission[]): Actor {
  return {
    user: {
      id: 'catalog-user',
      username: 'catalog-user',
      displayName: 'Catalog User',
      role: 'user',
      status: 'active',
    },
    source: 'session',
    permissions: new Set(permissions),
    authorityRevision: 3,
  }
}

function item(sourceId: TaskSourceId): TaskCatalogListItem {
  return {
    id: `${sourceId}-item`,
    sourceId,
    title: `${sourceId} item`,
    subject: {
      resourceId: `${sourceId}-resource`,
      label: { 'zh-CN': sourceId, 'en-US': sourceId },
    },
    targetLabel: null,
    status: 'done',
    statusDetail: null,
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    executionClock: { runningMs: 1, runningSince: null },
    ownerUserId: null,
    owner: null,
    ownerLabel: null,
    errorSummary: null,
    failureCode: null,
    childCount: 0,
    repositoryCount: 0,
    scheduledTaskId: null,
    openAlertCount: 0,
    hierarchy: {
      parentItemId: null,
      invocationDepth: 0,
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 0,
      matchingDescendantCount: 0,
      branchStartedAt: 2,
    },
  }
}

function source(sourceId: TaskSourceId, calls: TaskCatalogSourceListInput[]): TaskCatalogSource {
  return {
    sourceId,
    supportsHierarchy: sourceId !== 'digital-employee',
    async list(input) {
      calls.push(input)
      return {
        items: [item(sourceId)],
        nextCursor: null,
        facets: { all: 1, active: 0, attention: 0, finished: 1 },
      }
    },
  }
}

function completeSources(calls: Partial<Record<TaskSourceId, TaskCatalogSourceListInput[]>> = {}) {
  return (['agent', 'workflow', 'workgroup', 'digital-employee'] as const).map((sourceId) =>
    source(sourceId, calls[sourceId] ?? []),
  )
}

describe('RFC-310 unified task catalog', () => {
  test('dispatches by registered task source and returns one normalized page', async () => {
    const calls: Partial<Record<TaskSourceId, TaskCatalogSourceListInput[]>> = {
      workflow: [],
      'digital-employee': [],
    }
    const service = new TaskCatalogQueryService(completeSources(calls))
    const requestActor = actor(['tasks:read', 'digital-employees:read'])

    const workflow = TaskCatalogPageSchema.parse(
      JSON.parse(
        await service.list({ sourceId: 'workflow', view: 'active', limit: '20' }, requestActor),
      ),
    )
    expect(workflow).toMatchObject({
      schemaVersion: 1,
      sourceIds: ['workflow'],
      items: [{ id: 'workflow-item', sourceId: 'workflow' }],
    })
    expect(calls.workflow).toHaveLength(1)
    expect(calls.workflow?.[0]).toMatchObject({ view: 'active', limit: '20' })
    expect(calls['digital-employee']).toHaveLength(0)

    const all = TaskCatalogPageSchema.parse(JSON.parse(await service.list({}, requestActor)))
    expect(all.sourceIds).toEqual(['agent', 'workflow', 'workgroup', 'digital-employee'])
    expect(all.items.map((entry) => entry.sourceId).sort()).toEqual([
      'agent',
      'digital-employee',
      'workflow',
      'workgroup',
    ])
  })

  test('validates exact source coverage and per-source read authority', async () => {
    expect(() => new TaskCatalogQueryService(completeSources().slice(0, 3))).toThrow(
      'task catalog source is missing: digital-employee',
    )
    expect(
      () => new TaskCatalogQueryService([...completeSources(), source('workflow', [])]),
    ).toThrow('duplicate task catalog source: workflow')

    const service = new TaskCatalogQueryService(completeSources())
    await expect(
      service.list({ sourceId: 'digital-employee' }, actor(['tasks:read'])),
    ).rejects.toMatchObject({ code: 'task-source-forbidden' })
  })

  test('discovery is generated from the same source registrations', () => {
    const service = new TaskCatalogQueryService(completeSources())
    const document = TaskCatalogSourcesDocumentSchema.parse(
      JSON.parse(
        service.listSources(
          actor([
            'tasks:read',
            'tasks:execute',
            'digital-employees:read',
            'development-missions:launch',
          ]),
        ),
      ),
    )
    expect(document.sources.map((source) => source.id)).toEqual([
      'agent',
      'workflow',
      'workgroup',
      'digital-employee',
    ])
    for (const registration of document.sources) {
      expect(Object.keys(registration).sort()).toEqual([
        'catalogPath',
        'creationPermission',
        'descriptionKey',
        'detailPath',
        'id',
        'labelKey',
        'listPermission',
        'order',
      ])
    }
  })

  test('digital-employee source enforces the common scope and launch-origin filters', async () => {
    const calls: Array<Record<string, unknown>> = []
    const employeeSource = composeDigitalEmployeeTaskCatalogSource({
      queries: {
        listCasePage(input) {
          calls.push(input)
          return JSON.stringify({
            items: [],
            nextCursor: null,
            facets: { all: 0, active: 0, attention: 0, finished: 0 },
          })
        },
      },
    })
    const member = actor(['tasks:read', 'digital-employees:read'])

    await employeeSource.list({ actor: member, scope: 'all', origin: 'webhook' })
    expect(calls).toEqual([
      expect.objectContaining({ ownerUserId: 'catalog-user', launchOrigin: 'event' }),
    ])

    const shared = await employeeSource.list({ actor: member, scope: 'shared' })
    expect(shared.items).toEqual([])
    expect(calls).toHaveLength(1)

    await employeeSource.list({
      actor: actor(['tasks:read', 'tasks:read:all', 'digital-employees:read']),
      scope: 'all',
      origin: 'api',
    })
    expect(calls[1]).toMatchObject({ launchOrigin: 'api' })
    expect(calls[1]).not.toHaveProperty('ownerUserId')
  })

  test('digital-employee source accepts the zero-based first execution round', async () => {
    const employeeSource = composeDigitalEmployeeTaskCatalogSource({
      queries: {
        listCasePage() {
          return JSON.stringify({
            items: [
              {
                id: 'case-1',
                revision: 1,
                state: 'active',
                terminalKind: null,
                blockReason: null,
                employeeRef: { id: 'employee-1', revision: 1 },
                employeeName: 'Developer',
                typeRef: { typeId: 'development', revision: 6 },
                typeName: { 'zh-CN': '开发数字员工', 'en-US': 'Development employee' },
                taskName: '修复登录失败',
                subjectRef: 'issue-1',
                targetRef: 'repository-1',
                currentWorkItemRef: 'analyze',
                currentWorkItemName: { 'zh-CN': '分析', 'en-US': 'Analyze' },
                activeRound: {
                  id: 'round-1',
                  state: 'running',
                  workItemRef: 'analyze',
                  attemptOrdinal: 0,
                },
                pendingEventCount: 0,
                openChannelCount: 0,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            nextCursor: null,
            facets: { all: 1, active: 1, attention: 0, finished: 0 },
          })
        },
      },
    })

    const page = await employeeSource.list({
      actor: actor(['tasks:read', 'digital-employees:read']),
    })
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'case-1',
        sourceId: 'digital-employee',
        title: '修复登录失败',
        status: 'running',
        // Operators need both the broad employee category and the exact employee identity.
        subject: {
          resourceId: 'employee-1',
          label: {
            'zh-CN': '开发数字员工 · Developer',
            'en-US': 'Development employee · Developer',
          },
        },
      }),
    ])
  })

  test('the catalog application layer contains no concrete task-source decisions', () => {
    const sourceCode = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/task-catalog/application/taskCatalogQueryService.ts',
      ),
      'utf8',
    )
    for (const concrete of ["'agent'", "'workflow'", "'workgroup'", "'digital-employee'"]) {
      expect(sourceCode).not.toContain(concrete)
    }
  })

  test('the route rejects an unknown source with the stable task-source-invalid code', () => {
    const routeSource = readFileSync(
      resolve(import.meta.dir, '../src/routes/taskCatalog.ts'),
      'utf8',
    )
    expect(routeSource).toContain('!isTaskSourceId(rawSource)')
    expect(routeSource).toContain("new ValidationError('task-source-invalid'")
  })
})
