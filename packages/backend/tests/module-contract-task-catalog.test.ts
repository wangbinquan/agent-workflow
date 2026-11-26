import {
  TASK_SOURCE_IDS,
  TaskCatalogSourcesDocumentSchema,
  type Permission,
  type TaskCatalogListItem,
  type TaskSourceId,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { Hono, type Context } from 'hono'

import type { Actor } from '@/auth/actor'
import { composeTaskCatalog, mountTaskCatalogRoutes } from '@/modules/task-catalog/composition'
import type {
  TaskCatalogSource,
  TaskCatalogSourceListInput,
  TaskCatalogSourcePage,
} from '@/modules/task-catalog/composition/required-ports'
import { errorHandler } from '@/platform/errors/domainErrors'

const viewer = {
  user: { id: 'catalog-contract-viewer' },
  permissions: new Set<Permission>(['tasks:read', 'digital-employees:read']),
}

function item(sourceId: TaskSourceId, id = `${sourceId}-item`, branchStartedAt = 2) {
  return {
    id,
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
      branchStartedAt,
    },
  } satisfies TaskCatalogListItem
}

function page(items: readonly TaskCatalogListItem[] = [], nextCursor: string | null = null) {
  return {
    items,
    nextCursor,
    facets: { all: items.length, active: 0, attention: 0, finished: items.length },
  } satisfies TaskCatalogSourcePage
}

type SourceHandler = (
  sourceId: TaskSourceId,
  input: TaskCatalogSourceListInput,
) => Promise<TaskCatalogSourcePage>

function catalog(handler: SourceHandler = async () => page()) {
  const calls: { sourceId: TaskSourceId; input: TaskCatalogSourceListInput }[] = []
  const sources: TaskCatalogSource[] = TASK_SOURCE_IDS.map((sourceId) => ({
    sourceId,
    supportsHierarchy: sourceId !== 'digital-employee',
    list(input) {
      calls.push({ sourceId, input })
      return handler(sourceId, input)
    },
  }))
  return { ...composeTaskCatalog({ sources }), sources, calls }
}

function cursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function http(module: ReturnType<typeof composeTaskCatalog>) {
  const app = new Hono()
  const actor: Actor = {
    ...viewer,
    user: {
      ...viewer.user,
      username: 'catalog-viewer',
      displayName: 'Catalog Viewer',
      role: 'user',
      status: 'active',
    },
    source: 'session',
  }
  app.use('*', async (context: Context, next) => {
    context.set('actor', actor)
    await next()
  })
  app.onError(errorHandler)
  mountTaskCatalogRoutes(app, module)
  return { app, actor }
}

describe('task-catalog external query contract', () => {
  test('composition and source discovery perform no source reads', () => {
    const module = catalog()
    const discovery = module.queries.listSources(viewer)
    expect(discovery.sources.map((source) => source.id)).toEqual([...TASK_SOURCE_IDS])
    expect(TaskCatalogSourcesDocumentSchema.safeParse(discovery).success).toBe(true)
    expect(module.calls).toEqual([])
  })

  test('composition rejects an extra unregistered source before any source reads', () => {
    const module = catalog()
    // Runtime provider registration can violate its compile-time source-id contract.
    const unknown: TaskCatalogSource = {
      sourceId: 'unexpected' as TaskSourceId,
      supportsHierarchy: false,
      list: async () => page(),
    }
    expect(() => composeTaskCatalog({ sources: [...module.sources, unknown] })).toThrow(
      'task catalog source is not registered: unexpected',
    )
    expect(module.calls).toEqual([])
  })

  test('forwards every filter once to the selected source and keeps its cursor opaque', async () => {
    const module = catalog()
    const opaque = 'provider cursor / 中文 ?=+&'
    const filters = {
      view: 'attention',
      q: ' 修复 ',
      statuses: 'failed,waiting',
      scope: 'mine',
      origin: 'event',
      parentItemId: 'parent-1',
      limit: '37',
    }
    await module.queries.list(
      { sourceId: 'workflow', ...filters, cursor: cursor({ v: 1, cursors: { workflow: opaque } }) },
      viewer,
    )
    expect(module.calls).toEqual([
      { sourceId: 'workflow', input: { viewer, ...filters, cursor: opaque } },
    ])
    expect(module.calls[0]!.input.viewer).toBe(viewer)
  })

  test('preserves empty filter values and does not manufacture unspecified defaults', async () => {
    const module = catalog()
    await module.queries.list({ sourceId: 'agent', q: '', statuses: '', limit: '0' }, viewer)
    expect(module.calls).toEqual([
      { sourceId: 'agent', input: { viewer, q: '', statuses: '', limit: '0' } },
    ])
  })

  test('merges by branch time then descending id, sums facets and leaves source order intact', async () => {
    const sourceItems = Object.freeze([item('agent', 'a-old', 1), item('agent', 'a-tie', 10)])
    const module = catalog(async (sourceId) => {
      if (sourceId === 'agent') {
        return { ...page(sourceItems), facets: { all: 4, active: 2, attention: 1, finished: 2 } }
      }
      if (sourceId === 'workflow') {
        return {
          ...page([item('workflow', 'z-tie', 10), item('workflow', 'newest', 20)]),
          facets: { all: 9, active: 3, attention: 2, finished: 6 },
        }
      }
      return page()
    })
    const result = await module.queries.list({}, viewer)
    expect(result.schemaVersion).toBe(1)
    expect(result.sourceIds).toEqual([...TASK_SOURCE_IDS])
    expect(result.items.map((row) => row.id)).toEqual(['newest', 'z-tie', 'a-tie', 'a-old'])
    expect(result.facets).toEqual({ all: 13, active: 5, attention: 3, finished: 8 })
    expect(result.nextCursor).toBeNull()
    expect(sourceItems.map((row) => row.id)).toEqual(['a-old', 'a-tie'])
  })

  test('round trips independent source cursors and never re-reads exhausted sources', async () => {
    const module = catalog(async (sourceId, input) => {
      if (sourceId === 'agent') {
        return input.cursor === undefined
          ? page([item(sourceId, 'a1')], 'opaque:agent:2')
          : page([item(sourceId, 'a2')])
      }
      if (sourceId === 'workflow') {
        if (input.cursor === undefined) return page([item(sourceId, 'w1')], 'opaque:workflow:2')
        if (input.cursor === 'opaque:workflow:2') {
          return page([item(sourceId, 'w2')], 'opaque:workflow:3')
        }
        return page([item(sourceId, 'w3')])
      }
      return page()
    })
    const first = await module.queries.list({}, viewer)
    expect(first.nextCursor).not.toBeNull()
    const second = await module.queries.list({ cursor: first.nextCursor! }, viewer)
    expect(second.items.map((row) => row.id)).toEqual(['w2', 'a2'])
    expect(module.calls.slice(4)).toEqual([
      { sourceId: 'agent', input: { viewer, cursor: 'opaque:agent:2' } },
      { sourceId: 'workflow', input: { viewer, cursor: 'opaque:workflow:2' } },
    ])
    expect(second.nextCursor).not.toBeNull()
    const third = await module.queries.list({ cursor: second.nextCursor! }, viewer)
    expect(third.items.map((row) => row.id)).toEqual(['w3'])
    expect(third.nextCursor).toBeNull()
    expect(module.calls.slice(6)).toEqual([
      { sourceId: 'workflow', input: { viewer, cursor: 'opaque:workflow:3' } },
    ])
  })

  test('an explicitly exhausted cursor returns an empty terminal page without provider calls', async () => {
    const module = catalog()
    const result = await module.queries.list(
      {
        cursor: cursor({
          v: 1,
          cursors: Object.fromEntries(TASK_SOURCE_IDS.map((id) => [id, null])),
        }),
      },
      viewer,
    )
    expect(result.items).toEqual([])
    expect(result.nextCursor).toBeNull()
    expect(result.facets).toEqual({ all: 0, active: 0, attention: 0, finished: 0 })
    expect(module.calls).toEqual([])
  })

  test.each([
    ['empty', ''],
    ['not JSON', Buffer.from('not-json').toString('base64url')],
    ['null envelope', cursor(null)],
    ['array envelope', cursor([])],
    ['wrong version', cursor({ v: 2, cursors: {} })],
    ['missing map', cursor({ v: 1 })],
    ['null map', cursor({ v: 1, cursors: null })],
    ['array map', cursor({ v: 1, cursors: [] })],
    ['unknown source', cursor({ v: 1, cursors: { unexpected: 'next' } })],
    ['numeric cursor', cursor({ v: 1, cursors: { agent: 2 } })],
    ['nested cursor', cursor({ v: 1, cursors: { agent: { next: '2' } } })],
    ['noncanonical padding', `${cursor({ v: 1, cursors: {} })}=`],
  ])('rejects %s cursors with a stable error before any source reads', async (_name, raw) => {
    const module = catalog()
    await expect(module.queries.list({ cursor: raw }, viewer)).rejects.toMatchObject({
      code: 'task-page-cursor-invalid',
    })
    expect(module.calls).toEqual([])
  })

  test('hierarchy fanout excludes sources without child-task support', async () => {
    const module = catalog()
    await module.queries.list({ parentItemId: 'root' }, viewer)
    expect(module.calls).toEqual(
      (['agent', 'workflow', 'workgroup'] as const).map((sourceId) => ({
        sourceId,
        input: { viewer, parentItemId: 'root' },
      })),
    )
  })

  test('an explicitly unsupported hierarchy fails before reading providers', async () => {
    const module = catalog()
    await expect(
      module.queries.list({ sourceId: 'digital-employee', parentItemId: 'root' }, viewer),
    ).rejects.toMatchObject({ code: 'task-hierarchy-unsupported' })
    expect(module.calls).toEqual([])
  })

  test('rejects a source identity mismatch instead of publishing a mixed-owner page', async () => {
    const module = catalog(async () => page([item('workflow')]))
    await expect(module.queries.list({ sourceId: 'agent' }, viewer)).rejects.toThrow(
      'task catalog source returned the wrong identity: agent/workflow',
    )
  })

  test.each([
    ['negative child count', { childCount: -1 }],
    ['fractional timestamp', { startedAt: 0.5 }],
    ['unknown status', { status: 'provider-private-state' }],
    ['extra private field', { privateStorageKey: 'internal' }],
  ])('rejects invalid provider DTOs: %s', async (_name, override) => {
    const malformed = { ...item('agent'), ...override } as TaskCatalogListItem
    const module = catalog(async () => page([malformed]))
    await expect(module.queries.list({ sourceId: 'agent' }, viewer)).rejects.toMatchObject({
      name: 'ZodError',
    })
  })

  test('preserves provider failures and permits a subsequent independent successful request', async () => {
    const failure = new Error('source unavailable')
    let fail = true
    const module = catalog(async (sourceId) => {
      if (fail && sourceId === 'workflow') throw failure
      return page([item(sourceId)])
    })
    await expect(module.queries.list({}, viewer)).rejects.toBe(failure)
    fail = false
    const recovered = await module.queries.list({}, viewer)
    expect(recovered.items).toHaveLength(4)
    expect(module.calls).toHaveLength(8)
  })

  test('starts all independent source reads concurrently without timing assumptions', async () => {
    const pending = new Map(TASK_SOURCE_IDS.map((id) => [id, deferred<TaskCatalogSourcePage>()]))
    const module = catalog((id) => pending.get(id)!.promise)
    const result = module.queries.list({}, viewer)
    try {
      expect(module.calls.map((call) => call.sourceId)).toEqual([...TASK_SOURCE_IDS])
    } finally {
      for (const [id, request] of pending) request.resolve(page([item(id)]))
    }
    expect((await result).items).toHaveLength(4)
  })

  test.each([1, 100])('uses exactly one read per source for pages of %i rows', async (size) => {
    const module = catalog(async (id) =>
      page(Array.from({ length: size }, (_, index) => item(id, `${id}-${index}`, index))),
    )
    const result = await module.queries.list({ limit: String(size) }, viewer)
    expect(result.items).toHaveLength(TASK_SOURCE_IDS.length * size)
    expect(result.facets.all).toBe(TASK_SOURCE_IDS.length * size)
    expect(module.calls).toEqual(
      TASK_SOURCE_IDS.map((sourceId) => ({ sourceId, input: { viewer, limit: String(size) } })),
    )
    expect(result.items[0]!.hierarchy.branchStartedAt).toBe(size - 1)
    expect(result.items.at(-1)!.hierarchy.branchStartedAt).toBe(0)
  })
})

describe('task-catalog HTTP wire contract', () => {
  test('maps the public filter names and encodes the same versioned document as the query', async () => {
    const module = catalog(async (id) => page([item(id)]))
    const { app, actor } = http(module)
    const params = new URLSearchParams({
      type: 'agent',
      view: 'active',
      q: '中文 + query',
      statuses: 'running,paused',
      scope: 'all',
      origin: 'manual',
      parent_id: 'parent/id',
      limit: '15',
      cursor: cursor({ v: 1, cursors: { agent: 'source+cursor' } }),
    })
    const response = await app.request(`/api/task-catalog?${params}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      sourceIds: ['agent'],
      items: [item('agent')],
      facets: { all: 1, active: 0, attention: 0, finished: 1 },
      nextCursor: null,
    })
    expect(module.calls).toEqual([
      {
        sourceId: 'agent',
        input: {
          viewer: actor,
          view: 'active',
          q: '中文 + query',
          statuses: 'running,paused',
          scope: 'all',
          origin: 'manual',
          parentItemId: 'parent/id',
          limit: '15',
          cursor: 'source+cursor',
        },
      },
    ])
  })

  test('discovery is the same schema-versioned document and does not call list providers', async () => {
    const module = catalog()
    const { app, actor } = http(module)
    const response = await app.request('/api/task-catalog/sources')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(module.queries.listSources(actor))
    expect(module.calls).toEqual([])
  })

  test.each([
    ['type=unexpected', 'task-source-invalid'],
    ['cursor=not-a-cursor', 'task-page-cursor-invalid'],
    ['type=digital-employee&parent_id=root', 'task-hierarchy-unsupported'],
  ])('returns a stable validation status and code for %s', async (query, code) => {
    const module = catalog()
    const { app } = http(module)
    const response = await app.request(`/api/task-catalog?${query}`)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ ok: false, code, message: expect.any(String) })
    expect(module.calls).toEqual([])
  })
})
