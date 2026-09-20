// RFC-364: a real shared coordinator must linearize catalog writes and all seven diagnostics calls.
import { describe, expect, test } from 'bun:test'
import type { Mcp } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  AuthorityClaimRegistry,
  DirectOperationContextFactory,
} from '@/modules/identity-access/application/operationContext'
import { createMcpDiagnosticsContexts } from '@/modules/resource-catalog/infrastructure/mcpDiagnosticsContexts'
import { createMcpDiagnosticsOperations } from '@/modules/resource-catalog/application/mcps/diagnosticsOperations'
import { ResourceOperationCoordinator } from '@/services/resourceOperationCoordinator'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  const coordinator = new ResourceOperationCoordinator()
  const registry = new AuthorityClaimRegistry()
  const actor = buildActor({
    user: { id: 'owner', username: 'owner', displayName: 'Owner', role: 'admin', status: 'active' },
    source: 'session',
  })
  const identity = registry.mintDirectAuthority(
    { userId: 'owner', source: 'session' },
    { ...actor, userId: 'owner' },
  )
  const direct = new DirectOperationContextFactory(
    { now: () => 100, id: () => 'operation' },
    registry,
  )
  const reads: string[] = []
  const row: Mcp = {
    id: 'mcp',
    name: 'before',
    type: 'local',
    description: '',
    config: { command: ['mock'] },
    schemaVersion: 1,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  let visible: Mcp | null = row
  const firstRead = gate()
  const contexts = createMcpDiagnosticsContexts({
    contexts: direct,
    directAuthority: {
      authorityForLegacyProjection: (actor) => registry.directAuthorityForProjection(actor),
      legacyProjectionForAuthority: (authority) => registry.directClaim(authority).actor,
    },
    loadVisibleMcp: async (caller, id) => {
      expect(caller).toBe(identity.actor)
      expect(id).toBe('mcp')
      reads.push(visible?.name ?? 'missing')
      firstRead.resolve()
      return visible
    },
  })
  const called: string[] = []
  const stop = new Error('application-call-reached')
  const commands = createMcpDiagnosticsOperations({
    coordinator,
    contexts: contexts.resolver,
    application: {
      async create(caller, mcp) {
        expect(caller.user.id).toBe('owner')
        called.push('create:' + mcp.name)
        throw stop
      },
      async message(caller, mcp) {
        expect(caller.user.id).toBe('owner')
        called.push('message:' + mcp.name)
        throw stop
      },
      async cancel() {
        called.push('cancel')
        throw stop
      },
      async end() {
        called.push('end')
        throw stop
      },
      async latest() {
        called.push('latest')
        return null
      },
      async get() {
        called.push('session')
        throw stop
      },
      async sessionView() {
        called.push('transcript')
        throw stop
      },
    },
  })
  return {
    ...commands,
    coordinator,
    contexts,
    actor: identity.actor,
    reads,
    called,
    stop,
    firstRead,
    change: () => {
      visible = { ...row, name: 'after', updatedAt: 2 }
    },
    remove: () => {
      visible = null
    },
  }
}

describe('RFC-364 context operations and catalog lock', () => {
  for (const operation of ['start', 'submitTurn'] as const) {
    test(operation + ' rereads after a queued catalog mutation under the same lock', async () => {
      const f = fixture()
      const release = gate()
      const held = f.coordinator.runExclusive('mcp', async () => {
        await release.promise
        f.change()
      })
      const context = f.contexts.command(f.actor)
      const pending =
        operation === 'start'
          ? f.commands.start(context, {
              mcpId: 'mcp',
              request: {
                clientCreateId: 'create',
                expectedMcpConfigHash: 'hash',
                runtimeName: null,
                clientMessageId: 'first',
                message: 'hello',
              },
            })
          : f.commands.submitTurn(context, {
              mcpId: 'mcp',
              sessionId: 'session',
              request: { clientMessageId: 'message', expectedSessionVersion: 0, message: 'hello' },
            })
      const observed = pending.catch((error: unknown) => error)
      await f.firstRead.promise
      expect(f.called).toEqual([])
      release.resolve()
      await held
      expect(await observed).toBe(f.stop)
      expect(f.reads).toEqual(['before', 'after'])
      expect(f.called).toEqual([operation === 'start' ? 'create:after' : 'message:after'])
    })
  }
  test('removed catalog entries preserve the original 404 before reaching application', async () => {
    const f = fixture()
    f.remove()
    await expect(
      f.queries.latest(f.contexts.query(f.actor), { mcpId: 'mcp' }),
    ).rejects.toMatchObject({ code: 'mcp-not-found' })
    expect(f.called).toEqual([])
  })
  test('read, cancel and end wait behind the same catalog coordinator', async () => {
    const f = fixture()
    const release = gate()
    const held = f.coordinator.runExclusive('mcp', () => release.promise)
    const ref = { mcpId: 'mcp', sessionId: 'session' }
    const pending = [
      f.queries.latest(f.contexts.query(f.actor), ref),
      f.queries.session(f.contexts.query(f.actor), ref),
      f.queries.transcript(f.contexts.query(f.actor), ref),
      f.commands.cancel(f.contexts.command(f.actor), { ...ref, request: { turnId: 'turn' } }),
      f.commands.end(f.contexts.command(f.actor), ref),
    ].map((p) => p.catch((error: unknown) => error))
    expect(f.reads).toEqual([])
    release.resolve()
    await held
    expect(await Promise.all(pending)).toEqual([null, f.stop, f.stop, f.stop, f.stop])
    expect(f.called).toEqual(['latest', 'session', 'transcript', 'cancel', 'end'])
    expect(f.reads).toHaveLength(5)
  })
})
