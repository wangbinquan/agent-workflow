import { isTaskSourceId } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import type { TaskCatalogQueries } from '@/modules/task-catalog/public/queries'
import { registerRoute } from '@/routes/registry'
import { ValidationError } from '@/util/errors'
import { jsonDocumentResponse } from '@/util/jsonDocument'

// RFC-435: the catalog queries return typed documents; this inbound adapter owns their JSON encoding.
export function mountTaskCatalogRoutes(
  app: Hono,
  module: { readonly queries: TaskCatalogQueries },
): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/task-catalog/sources',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List registered task sources and their creation and list capabilities',
    },
    (c) => jsonDocumentResponse(JSON.stringify(module.queries.listSources(actorOf(c)))),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/task-catalog',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List registered task sources through the unified task catalog',
    },
    async (c) => {
      const rawSource = c.req.query('type')
      if (rawSource !== undefined && !isTaskSourceId(rawSource)) {
        throw new ValidationError('task-source-invalid', `unknown task source: ${rawSource}`)
      }
      const page = await module.queries.list(
        {
          ...(rawSource === undefined ? {} : { sourceId: rawSource }),
          ...(c.req.query('view') === undefined ? {} : { view: c.req.query('view')! }),
          ...(c.req.query('q') === undefined ? {} : { q: c.req.query('q')! }),
          ...(c.req.query('statuses') === undefined ? {} : { statuses: c.req.query('statuses')! }),
          ...(c.req.query('scope') === undefined ? {} : { scope: c.req.query('scope')! }),
          ...(c.req.query('origin') === undefined ? {} : { origin: c.req.query('origin')! }),
          ...(c.req.query('parent_id') === undefined
            ? {}
            : { parentItemId: c.req.query('parent_id')! }),
          ...(c.req.query('cursor') === undefined ? {} : { cursor: c.req.query('cursor')! }),
          ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit')! }),
        },
        actorOf(c),
      )
      return jsonDocumentResponse(JSON.stringify(page))
    },
  )
}
