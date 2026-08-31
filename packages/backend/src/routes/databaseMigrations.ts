// RFC-349 — HTTP adapter over the database-migration operation descriptors.

import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
} from '@/modules/identity-access/public/participants'
import type { DatabaseMigrationOperationDescriptors } from '@/modules/system-operations/public/operations'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { safeJsonOrEmpty } from '@/util/http'
import type { DatabaseMigrationArtifactView } from '@/modules/system-operations/public/types'

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

function artifactResponse(output: DatabaseMigrationArtifactView): Response {
  return new Response(output.json, {
    headers: {
      'content-type': output.contentType,
      'content-length': String(output.byteLength),
      'content-disposition': `attachment; filename="${output.fileName}"`,
      etag: `"${output.fileDigest}"`,
      'x-agent-workflow-artifact-digest': output.digest,
    },
  })
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
    descriptor: operations.readArtifact,
    method: 'GET',
    path: '/api/database/migrations/:id/artifacts/:kind',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id'), kind: c.req.param('kind') }),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (_c, output) => artifactResponse(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.inspectLegacyTable,
    method: 'GET',
    path: '/api/database/migrations/:id/legacy/:table',
    tokenAccess: 'allow',
    decode: (c) => ({ operationId: c.req.param('id'), table: c.req.param('table') }),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (c, output) => c.json(output),
  })
  registerOperationRoute(app, {
    descriptor: operations.readLegacyChunk,
    method: 'GET',
    path: '/api/database/migrations/:id/legacy/:table/chunks/:chunk',
    tokenAccess: 'allow',
    decode: (c) => ({
      operationId: c.req.param('id'),
      table: c.req.param('table'),
      chunkIndex: Number(c.req.param('chunk')),
    }),
    context: (c) => queryContext(identity, actorOf(c)),
    encode: (_c, output) => artifactResponse(output),
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
