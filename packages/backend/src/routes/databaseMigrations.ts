// RFC-349 — HTTP adapter over the database-migration operation descriptors.

import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
} from '@/modules/identity-access/public/participants'
import type { DatabaseMigrationOperationDescriptors } from '@/modules/system-operations/public/databaseMigrationOperations'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { safeJsonOrEmpty } from '@/util/http'

interface DatabaseMigrationRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityBinding
}

function commandContext(identity: DatabaseMigrationRouteIdentityAccess, actor: Actor) {
  return identity.contexts.fromAuthority(
    directRequestAuthority(identity.directAuthority, actor),
    'http',
  )
}

function queryContext(identity: DatabaseMigrationRouteIdentityAccess, actor: Actor) {
  return identity.contexts.queryFromAuthority(
    directRequestAuthority(identity.directAuthority, actor),
    'http',
  )
}

export function mountDatabaseMigrationRoutes(
  app: Hono,
  operations: DatabaseMigrationOperationDescriptors,
  identity: DatabaseMigrationRouteIdentityAccess,
): void {
  registerOperationRoute(app, {
    descriptor: operations.overview,
    method: 'GET',
    path: '/api/database',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.preflight,
    method: 'POST',
    path: '/api/database/migrations/preflight',
    tokenAccess: 'allow',
    decode: (c) => safeJsonOrEmpty(c.req.raw),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/database/migrations',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.start,
    method: 'POST',
    path: '/api/database/migrations',
    tokenAccess: 'allow',
    decode: (c) => safeJsonOrEmpty(c.req.raw),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output, 202),
  })
  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/database/migrations/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id') }),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.resume,
    method: 'POST',
    path: '/api/database/migrations/:id/resume',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id') }),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.cancel,
    method: 'POST',
    path: '/api/database/migrations/:id/cancel',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id') }),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.rollback,
    method: 'POST',
    path: '/api/database/migrations/:id/rollback',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id') }),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.finalize,
    method: 'POST',
    path: '/api/database/migrations/:id/finalize',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id') }),
    context: (c) => commandContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
}
