// RFC-347 — trusted authority mint, explicit runtime lifetime and exact
// compatibility-debt ledger.  Existing RFC-305/RFC-312 suites remain the
// behavior oracle; this file locks the new seams that those suites did not
// previously have a way to observe.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createIdentityAccessRuntime,
  type IdentityAccessRuntime,
} from '../src/modules/identity-access/composition'
import { trustedContextMetadata } from '../src/modules/identity-access/application/operationContext'
import type { DirectRequestAuthority } from '../src/modules/identity-access/public/participants'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKEND_ROOT = resolve(import.meta.dir, '..')
const SRC_ROOT = resolve(BACKEND_ROOT, 'src')

function seedUser(db: DbClient, id: string, status: 'active' | 'disabled' = 'active'): void {
  db.$client
    .query(
      `INSERT INTO users (id, username, display_name, role, status, force_password_change,
                          created_at, updated_at, schema_version, access_revision)
       VALUES (?, ?, ?, 'admin', ?, 0, 0, 0, 1, 0)`,
    )
    .run(id, id, id, status)
}

function walkTypeScript(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return walkTypeScript(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

const productionSources = walkTypeScript(SRC_ROOT).map((path) => ({
  path: relative(BACKEND_ROOT, path),
  source: readFileSync(path, 'utf8'),
}))

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function callPaths(needle: string): string[] {
  return productionSources
    .filter(({ source }) => stripComments(source).includes(needle))
    .map(({ path }) => path)
    .sort()
}

function importPaths(needle: string): string[] {
  return productionSources
    .filter(({ source }) => source.includes(needle))
    .map(({ path }) => path)
    .sort()
}

function source(path: string): string {
  return readFileSync(resolve(BACKEND_ROOT, path), 'utf8')
}

describe('RFC-347 direct authority runtime', () => {
  test('one admission resolves once, reuses the opaque handle and rejects foreign/plain handles', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'direct-user')
    let sequence = 0
    const runtime = createIdentityAccessRuntime({
      db,
      id: () => `operation-${++sequence}`,
      now: () => 1_234,
    })
    const foreignRuntime = createIdentityAccessRuntime({ db })

    const identity = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'direct-user',
      source: 'session',
    })
    expect(identity).not.toBeNull()
    expect(runtime.diagnostics.snapshot().authorityReresolution).toBe(1)
    expect(Object.keys(identity!.authority)).toEqual([])

    const context = runtime.contexts.fromAuthority(identity!.authority, 'http')
    expect(context.authority).toBe(identity!.authority)
    expect(context).toMatchObject({ operationId: 'operation-1', now: 1_234 })
    expect(runtime.contexts.resolveCommandContext(context)).toEqual({
      userId: 'direct-user',
      source: 'session',
    })
    expect(runtime.diagnostics.snapshot().authorityReresolution).toBe(1)

    expect(() => foreignRuntime.contexts.fromAuthority(identity!.authority, 'http')).toThrow(
      'foreign-direct-request-authority',
    )
    expect(() => runtime.contexts.fromAuthority({} as DirectRequestAuthority, 'http')).toThrow(
      'foreign-direct-request-authority',
    )

    // Production runtime objects do not carry the plain-principal/raw-presence
    // fixture faces.  Their explicit test peer is composeIdentityAccess().
    expect('fromAuthenticatedPrincipal' in runtime.contexts).toBe(false)
    expect('delegatedContexts' in runtime).toBe(false)
    expect('trackUserPresence' in runtime).toBe(false)
    expect('getUserPresence' in runtime).toBe(false)
    const compileOnlyProductionSurface = (productionRuntime: IdentityAccessRuntime): void => {
      // @ts-expect-error production contexts accept only a minted opaque handle
      productionRuntime.contexts.fromAuthenticatedPrincipal(
        { userId: 'x', source: 'session' },
        'http',
      )
      // @ts-expect-error direct admission accepts only an inbound-adapter credential brand
      productionRuntime.directAuthority.fromSession({ userId: 'x' })
      // @ts-expect-error raw presence tracker is an explicit fixture-only face
      void productionRuntime.trackUserPresence
    }
    void compileOnlyProductionSurface

    runtime.shutdown()
    foreignRuntime.shutdown()
  })

  test('session, PAT and daemon admissions preserve their distinct resolved projections', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'transport-user')
    const runtime = createIdentityAccessRuntime({ db })
    const session = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'transport-user',
      source: 'session',
    })
    const pat = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'transport-user',
      source: 'pat',
      patScopes: ['users:read'],
      patPurpose: 'mcp_only',
      patId: 'pat-1',
    })
    const daemon = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: '__system__',
      source: 'daemon',
    })

    expect(session?.actor.source).toBe('session')
    expect(pat?.actor).toMatchObject({ source: 'pat', purpose: 'mcp_only', patId: 'pat-1' })
    expect(daemon?.actor).toMatchObject({ source: 'daemon', user: { id: '__system__' } })
    expect(runtime.diagnostics.snapshot().authorityReresolution).toBe(3)
    runtime.shutdown()
  })
})

describe('RFC-347 delegated and presence participants', () => {
  test('closed schedule/webhook/call variants bind their real source and attempt identities', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'owner')
    seedUser(db, 'inactive', 'disabled')
    let sequence = 0
    const runtime = createIdentityAccessRuntime({
      db,
      id: () => `delegated-operation-${++sequence}`,
      now: () => 9_000,
    })

    const automatic = await runtime.delegatedRequests.forSchedule({
      ownerUserId: 'owner',
      scheduleId: 'schedule-1',
      invocation: { kind: 'automatic', occurrenceAt: 1_700_000_000_000 },
    })
    expect(automatic?.context).toMatchObject({
      correlationId: 'schedule-1',
      causationId: '1700000000000',
      now: 9_000,
    })
    expect(trustedContextMetadata(automatic!.context)).toEqual({
      source: 'schedule',
      transport: 'delegated',
    })
    expect('idempotencyKey' in automatic!.context).toBe(true)

    const manual = await runtime.delegatedRequests.forSchedule({
      ownerUserId: 'owner',
      scheduleId: 'schedule-1',
      invocation: { kind: 'manual' },
    })
    expect(manual?.context.correlationId).toBe('schedule-1')
    expect('idempotencyKey' in manual!.context).toBe(false)

    const webhook = await runtime.delegatedRequests.forWebhook({
      ownerUserId: 'owner',
      triggerId: 'trigger-1',
      deliveryId: 'delivery-1',
      fireId: 'fire-1',
    })
    expect(webhook?.context.causationId).toBe('fire-1')
    expect(trustedContextMetadata(webhook!.context).source).toBe('webhook')

    const call = await runtime.delegatedRequests.forCall({
      kind: 'call-workgroup',
      ownerUserId: 'owner',
      parentTaskId: 'parent-task',
      parentNodeRunId: 'parent-node-run',
    })
    expect(call?.context).toMatchObject({
      correlationId: 'parent-task',
      causationId: 'parent-node-run',
    })
    expect(trustedContextMetadata(call!.context).source).toBe('call-workgroup')
    expect(
      await runtime.delegatedRequests.forCall({
        kind: 'call-workflow',
        ownerUserId: 'inactive',
        parentTaskId: 'parent-task',
        parentNodeRunId: 'inactive-attempt',
      }),
    ).toBeNull()
    expect(runtime.diagnostics.snapshot().authorityReresolution).toBe(5)
    runtime.shutdown()
  })

  test('presence leases are session-only and release is idempotent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'viewer')
    const runtime = createIdentityAccessRuntime({ db })
    const session = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'viewer',
      source: 'session',
    })
    const pat = await admitTestDirectAuthority(runtime.directAuthority, {
      userId: 'viewer',
      source: 'pat',
      patScopes: ['users:read'],
      patPurpose: 'mcp_only',
    })
    const lease = runtime.presenceConnections.open(session!.authority)
    expect(lease).not.toBeNull()
    expect(runtime.presenceQuery.snapshot()).toContain('viewer')
    expect(runtime.presenceConnections.open(pat!.authority)).toBeNull()
    expect(() => {
      lease!.release()
      lease!.release()
    }).not.toThrow()
    runtime.shutdown()
  })
})

describe('RFC-347 exact production source locks', () => {
  test('runtime composition has one explicit root family and no ambient/WS cycle', () => {
    expect(callPaths('composeIdentityAccess(')).toEqual([
      'src/modules/identity-access/composition.ts',
    ])
    expect(callPaths('createIdentityAccessRuntime(')).toEqual([
      'src/main.ts',
      'src/modules/identity-access/composition.ts',
      'src/modules/identity-access/infrastructure/legacySqliteUserService.ts',
      'src/server.ts',
    ])
    expect(importPaths('identity-access/composition')).toEqual([
      'src/cli/postgresqlDaemonApplication.ts',
      'src/main.ts',
      'src/modules/identity-access/composition/userOperations.ts',
      'src/server.ts',
      'src/services/ownerIdentity.ts',
      'src/services/ownerScopedName.ts',
      'src/services/userIdentities.ts',
      'src/services/users.ts',
    ])
    expect(source('src/modules/identity-access/composition.ts')).not.toContain('/ws/')
    for (const file of productionSources.filter(({ path }) => path.startsWith('src/ws/'))) {
      expect(file.source).not.toContain('identity-access/composition')
      expect(file.source).not.toContain('composeIdentityAccess(')
    }
  })

  test('plain direct mint and central current/inherited Actor constructors have no consumer', () => {
    expect(callPaths('.fromAuthenticatedPrincipal(')).toEqual([
      'src/modules/identity-access/application/operationContext.ts',
    ])
    expect(callPaths('buildCurrentActor(')).toEqual([])
    expect(callPaths('buildInheritedActor(')).toEqual([])
    expect(callPaths('.fromSession(')).toEqual(['src/auth/session.ts'])
    expect(callPaths('.fromPat(')).toEqual(['src/auth/session.ts'])
    expect(callPaths('.fromDaemon(')).toEqual(['src/auth/session.ts'])
    const authorityAdapter = source('src/routes/operationAuthority.ts')
    expect(authorityAdapter).not.toContain('authorityFromAuthenticatedPrincipal')
    expect(authorityAdapter).toContain('authorityForLegacyProjection')
  })

  test('delegated arms and compatibility projection debt match the exact owner ledger', () => {
    expect(callPaths('.forSchedule(')).toEqual(['src/services/scheduledTasks.ts'])
    expect(callPaths('.forWebhook(')).toEqual(['src/services/webhook/webhookDispatch.ts'])
    expect(callPaths('.forCall(')).toEqual([
      'src/modules/task-execution/composition/nodeMechanics.ts',
    ])
    expect(importPaths('/legacyActorProjection')).toEqual([
      'src/modules/identity-access/application/operationContext.ts',
      'src/modules/identity-access/composition.ts',
    ])
    expect(callPaths('.legacyProjection.fromResolvedSubject(')).toEqual([
      'src/services/intent/dispatcher.ts',
    ])
    expect(callPaths('buildActor(')).toEqual([
      'src/auth/actor.ts',
      'src/cli/postgresqlDaemonApplication.ts',
      'src/modules/memory/infrastructure/postgresqlMemoryCatalogOperations.ts',
      'src/modules/memory/infrastructure/sqliteMemoryCatalog.ts',
      'src/modules/resource-catalog/infrastructure/sqliteDigitalEmployeeAgentTemplateCatalog.ts',
    ])
  })

  test('bootstrap admin and local CLI remain distinct exact participants', () => {
    const authRoutes = source('src/routes/auth.ts')
    expect(authRoutes).toContain('auth.completeBootstrap({')
    expect(authRoutes).not.toContain('identityAccess.initialUserAccess')
    expect(authRoutes).not.toMatch(/directAuthority\.(?:fromSession|fromPat|fromDaemon)\(/)
    expect(authRoutes).not.toContain('fromAuthenticatedPrincipal(')

    const participants = source('src/modules/identity-access/public/participants.ts')
    const composition = source('src/modules/identity-access/composition.ts')
    expect(participants).toContain('insert(provision: InitialUserAccessProvision): void')
    expect(participants).not.toContain('TransactionScope')
    expect(composition).toContain('forTransaction(transactionScope: TransactionScope)')
    expect(composition).toContain(
      'insertInitialUserAccessInTransaction(transactionScope, provision)',
    )

    const mainRoot = source('src/main.ts')
    expect(mainRoot).toContain('.localOperator.forUser(')
    expect(mainRoot).not.toMatch(/directAuthority\.(?:fromSession|fromPat|fromDaemon)\(/)
    expect(mainRoot).not.toContain('fromAuthenticatedPrincipal(')

    const packageConsumer = source('src/cli/package.ts')
    expect(packageConsumer).toContain('resolveLocalIdentityByUsername(username)')
    expect(mainRoot).toContain('identityAccess.localOperator.forUser(user.id)')
    expect(packageConsumer).not.toContain('identity-access/composition')
    expect(packageConsumer).not.toMatch(/directAuthority\.(?:fromSession|fromPat|fromDaemon)\(/)
    expect(packageConsumer).not.toContain('fromAuthenticatedPrincipal(')
  })
})
