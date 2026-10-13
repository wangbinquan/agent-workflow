// RFC-370 H7: reading persisted diagnostics in resource-only mode must not
// recover sessions, start a runtime, reconcile state, or install background work.
import { expect, test } from 'bun:test'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  mcps,
  runtimes,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  mcpRuntimeTestEvents,
  mcpRuntimeTestCreateReceipts,
} from '@/db/schema'
import {
  createMcpDiagnosticsApplication,
  bindMcpDiagnosticsRuntime,
  selectMcpDiagnosticsStoredQueries,
} from '@/modules/resource-catalog/composition/mcpDiagnostics'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeMcpCatalog } from '@/modules/resource-catalog/composition/mcpOperations'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { ResourceOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { composeMcpRuntimeTestProvider } from '@/modules/resource-catalog/composition/mcpRuntimeTestPersistence'
import type { McpDiagnosticsCaller } from '@/modules/resource-catalog/application/mcps/runtimeDiagnostics'
import type { McpDiagnosticsEffects } from '@/modules/resource-catalog/application/mcps/runtimeDiagnosticsEffects'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

const actor: McpDiagnosticsCaller = {
  user: { id: SYSTEM_USER_ID },
  permissions: { has: () => true },
}

function unexpected(): never {
  throw new Error('stored query invoked an execution effect')
}

const effects: McpDiagnosticsEffects = {
  now: unexpected,
  setTimeout: unexpected,
  setInterval: unexpected,
  resolveRuntime: unexpected,
  supportsSession: unexpected,
  createNativeSessionId: unexpected,
  workspaceReference: unexpected,
  workspaceExists: unexpected,
  cleanupWorkspace: unexpected,
  currentMcpHash: unexpected,
  broadcast: unexpected,
  hasExecution: unexpected,
  reapTurn: unexpected,
  recoverReapedTurn: unexpected,
  captureTurnStart: unexpected,
  runTurn: unexpected,
  failedResult: unexpected,
}

async function seed(db: ProviderNeutralDatabase) {
  await db.insert(runtimes).values({
    id: 'stored-runtime',
    name: 'stored-runtime',
    protocol: 'opencode',
    enabled: true,
  })
  await db.insert(mcps).values({
    id: 'stored-mcp',
    name: 'stored-mcp',
    description: '',
    type: 'local',
    config: JSON.stringify({ command: ['unused-stored-query-fixture'] }),
    enabled: true,
    ownerUserId: SYSTEM_USER_ID,
    visibility: 'private',
  })
  const provider = composeMcpRuntimeTestProvider(db)
  await provider.persistence.create({
    mcpId: 'stored-mcp',
    ownerUserId: SYSTEM_USER_ID,
    clientCreateId: 'stored-create',
    requestDigest: 'a'.repeat(64),
    sessionId: 'stored-session',
    turnId: 'stored-turn',
    mcpConfigHash: 'b'.repeat(64),
    runtimeRowId: 'stored-runtime',
    runtimeName: 'stored-runtime',
    runtimeProtocol: 'opencode',
    runtimeSnapshotJson: '{}',
    runtimeBinaryPath: 'stored-runtime-label',
    runtimeSessionId: 'native-stored-session',
    scratchRoot: 'stored-workspace',
    message: 'historical question',
    clientMessageId: 'stored-message',
    now: 1000,
    hardDeadlineAt: 301000,
    receiptExpiresAt: 601000,
  })
  const payload = JSON.stringify({
    type: 'text',
    sessionID: 'native-stored-session',
    messageID: 'stored-message',
    part: { type: 'text', text: 'historical response' },
  })
  await provider.persistence.appendEvent({
    sessionId: 'stored-session',
    turnId: 'stored-turn',
    ts: 1001,
    kind: 'text',
    payload,
    runtimeSessionId: 'native-stored-session',
    parentSessionId: null,
    source: 'stream',
    externalEventKey: 'c'.repeat(64),
    payloadBytes: new TextEncoder().encode(payload).length,
    maxSingleEventBytes: 65536,
    maxSessionRows: 100,
    maxSessionBytes: 65536,
  })
  return provider
}

async function facts(db: ProviderNeutralDatabase) {
  return {
    sessions: await db.select().from(mcpRuntimeTestSessions),
    turns: await db.select().from(mcpRuntimeTestTurns),
    events: await db.select().from(mcpRuntimeTestEvents),
    receipts: await db.select().from(mcpRuntimeTestCreateReceipts),
  }
}

describeEachProvider('RFC-370 persisted MCP diagnostic queries', (harness) => {
  test.each(['native', 'host'] as const)(
    'stored public operations retain contexts and coordinator in %s mode',
    async (executionMode) => {
      const provider = await seed(harness.db)
      const application = createMcpDiagnosticsApplication({
        ...provider,
        effects,
        executionMode,
        loadMcp: unexpected,
      })
      application.start = unexpected
      application.reconcile = unexpected
      const identity = createIdentityAccessRuntime({ db: harness.db })
      const coordinator = new ResourceOperationCoordinator()
      const catalog = composeMcpCatalog({
        db: harness.db,
        coordinator,
        nextMutationTimestamp: async (mcp) => mcp.updatedAt + 1,
        runtime: { prepareDelete: unexpected, reconcileDurableIntents: unexpected },
        lifecycle: { transitionMutation: unexpected, deletePrepared: unexpected },
        resourceCatalog: composeResourceCatalogFor({ db: harness.db }),
      })
      const runtime = bindMcpDiagnosticsRuntime(application, {
        queryMode: 'stored',
        coordinator,
        requestBinding: {
          contexts: identity.contexts,
          directAuthority: identity.directAuthority,
          loadVisibleMcp: (authority, id) => catalog.queries.get(authority, { id }),
        },
      })
      try {
        const admitted = await admitTestDirectAuthority(identity.directAuthority, {
          source: 'daemon',
        })
        if (admitted === null) throw new Error('fixture daemon identity missing')
        const context = runtime.contexts.query(admitted.actor)
        const before = await facts(harness.db)
        const session = await runtime.queries.session(context, {
          mcpId: 'stored-mcp',
          sessionId: 'stored-session',
        })
        expect(session.id).toBe('stored-session')
        expect(session.turns[0]?.status).toBe('queued')
        expect(await runtime.queries.latest(context, { mcpId: 'stored-mcp' })).toEqual(session)
        const transcript = await runtime.queries.transcript(context, {
          mcpId: 'stored-mcp',
          sessionId: 'stored-session',
        })
        expect(JSON.stringify(transcript)).toContain('historical response')
        expect(await facts(harness.db)).toEqual(before)
      } finally {
        await runtime.dispose()
        identity.shutdown()
      }
    },
  )

  test('cold queries retain queued facts, capture state, transcript and cursor without recovery', async () => {
    const provider = await seed(harness.db)
    const application = createMcpDiagnosticsApplication({
      ...provider,
      effects,
      loadMcp: unexpected,
    })
    application.start = unexpected
    application.reconcile = unexpected
    const before = await facts(harness.db)
    const queries = selectMcpDiagnosticsStoredQueries(application)
    expect(queries).toBe(application.storedQueries)
    expect(Object.isFrozen(queries)).toBe(true)
    const { latest, get, sessionView } = queries
    const dto = await get(actor, 'stored-mcp', 'stored-session')
    expect(dto).toMatchObject({
      id: 'stored-session',
      mcpId: 'stored-mcp',
      status: 'active',
      endReason: null,
      runtime: { name: 'stored-runtime', protocol: 'opencode' },
      mcpConfigHash: 'b'.repeat(64),
      inFlightTurnId: 'stored-turn',
      eventCursor: 1,
      createdAt: 1000,
      endedAt: null,
      turns: [
        {
          id: 'stored-turn',
          seq: 1,
          prompt: 'historical question',
          status: 'queued',
          captureState: 'live',
          hardDeadlineAt: 301000,
          createdAt: 1000,
        },
      ],
    })
    expect(await latest(actor, 'stored-mcp')).toEqual(dto)
    const view = await sessionView(actor, 'stored-mcp', 'stored-session')
    expect(view.tree.captureComplete).toBe(false)
    expect(JSON.stringify(view.tree)).toContain('historical response')
    expect(JSON.stringify(view.tree)).toContain('historical question')
    expect(await facts(harness.db)).toEqual(before)
    await application.dispose()
    expect(await facts(harness.db)).toEqual(before)
  })

  test('complete capture and missing session retain the original stored projections and errors', async () => {
    const provider = await seed(harness.db)
    await provider.persistence.markCaptureTerminal({
      sessionId: 'stored-session',
      turnId: 'stored-turn',
      state: 'complete',
      reason: null,
    })
    const application = createMcpDiagnosticsApplication({
      ...provider,
      effects,
      loadMcp: unexpected,
    })
    const queries = selectMcpDiagnosticsStoredQueries(application)
    const before = await facts(harness.db)
    expect((await queries.get(actor, 'stored-mcp', 'stored-session')).turns[0]?.captureState).toBe(
      'complete',
    )
    expect(
      (await queries.sessionView(actor, 'stored-mcp', 'stored-session')).tree.captureComplete,
    ).toBe(true)
    expect(await queries.latest(actor, 'missing-mcp')).toBeNull()
    await expect(queries.get(actor, 'stored-mcp', 'missing-session')).rejects.toMatchObject({
      code: 'mcp-test-session-not-found',
      message: 'MCP test session not found',
    })
    await expect(
      queries.sessionView(actor, 'different-mcp', 'stored-session'),
    ).rejects.toMatchObject({
      code: 'mcp-test-session-not-found',
      message: 'MCP test session not found',
    })
    expect(await facts(harness.db)).toEqual(before)
    await application.dispose()
  })

  test('native queries keep their original start and reconcile order before reading the same facts', async () => {
    const provider = await seed(harness.db)
    const application = createMcpDiagnosticsApplication({
      ...provider,
      effects,
      loadMcp: unexpected,
    })
    const order: string[] = []
    application.start = async () => {
      order.push('start')
    }
    application.reconcile = async () => {
      order.push('reconcile')
    }
    const stored = selectMcpDiagnosticsStoredQueries(application)
    expect(await application.latest(actor, 'stored-mcp')).toEqual(
      await stored.latest(actor, 'stored-mcp'),
    )
    expect(order.splice(0)).toEqual(['start', 'reconcile'])
    expect(await application.get(actor, 'stored-mcp', 'stored-session')).toEqual(
      await stored.get(actor, 'stored-mcp', 'stored-session'),
    )
    expect(order.splice(0)).toEqual(['start', 'reconcile'])
    expect(await application.sessionView(actor, 'stored-mcp', 'stored-session')).toEqual(
      await stored.sessionView(actor, 'stored-mcp', 'stored-session'),
    )
    expect(order).toEqual(['start'])
    const other = createMcpDiagnosticsApplication({ ...provider, effects, loadMcp: unexpected })
    expect(selectMcpDiagnosticsStoredQueries(other)).not.toBe(stored)
    await application.dispose()
    await other.dispose()
  })
})
