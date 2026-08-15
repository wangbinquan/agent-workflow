import { afterEach, describe, expect, test } from 'bun:test'
import { canonicalBinaryPath } from './fixtures/platformPaths'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  mcps,
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  runtimes,
  users,
} from '../src/db/schema'
import { getMcpById } from '../src/services/mcp'
import {
  MCP_RUNTIME_TEST_IDLE_MS,
  MCP_RUNTIME_TEST_TURN_TIMEOUT_MS,
  McpRuntimeTestEventSink,
  McpRuntimeTestService,
} from '../src/services/mcpRuntimeTest'
import { getRuntimeDriver } from '../src/services/runtime'
import {
  emptySystemAgentOutputEvidence,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '../src/services/systemAgentRun'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const tempDirs: string[] = []

const actor = buildActor({
  user: {
    id: SYSTEM_USER_ID,
    username: SYSTEM_USER_ID,
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

function successResult(
  opts: SystemAgentRunOptions,
  sessionId: string,
  status: SystemAgentRunResult['status'] = 'ok',
): SystemAgentRunResult {
  return {
    status,
    exitCode: status === 'ok' ? 0 : null,
    eventText: '',
    stderrTail: '',
    durationMs: 5,
    capturedSessionId: sessionId,
    scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unknown'),
    scratchRetained: true,
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

async function seed(protocol: 'opencode' | 'claude-code' = 'opencode'): Promise<{
  db: DbClient
  mcp: NonNullable<Awaited<ReturnType<typeof getMcpById>>>
  root: string
  runtimeName: string
}> {
  const db = createInMemoryDb(MIGRATIONS)
  const runtimeName = protocol === 'claude-code' ? 'test-claude' : 'test-opencode'
  db.insert(runtimes)
    .values({
      id: 'runtime-1',
      name: runtimeName,
      protocol,
      binaryPath: canonicalBinaryPath(protocol === 'claude-code' ? 'claude' : 'opencode'),
      model: 'openai/test-model',
      enabled: true,
    })
    .run()
  db.insert(mcps)
    .values({
      id: 'mcp-1',
      name: 'fixture',
      description: '',
      type: 'local',
      config: JSON.stringify({ command: ['fixture-mcp'] }),
      enabled: true,
      ownerUserId: SYSTEM_USER_ID,
      visibility: 'private',
    })
    .run()
  const mcp = await getMcpById(db, 'mcp-1')
  if (mcp === null) throw new Error('fixture MCP missing')
  const root = mkdtempSync(join(tmpdir(), 'rfc238-service-'))
  tempDirs.push(root)
  return { db, mcp, root, runtimeName }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RFC-238 MCP runtime test service', () => {
  test('rejects empty and over-64-KiB UTF-8 messages before scheduling a runtime', async () => {
    const { db, mcp, root } = await seed()
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        runs += 1
        return successResult(opts, 'must-not-run')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const base = {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      clientCreateId: 'create-invalid-message',
      clientMessageId: 'message-invalid',
    }
    await expect(service.create(actor, mcp, { ...base, message: '   ' })).rejects.toMatchObject({
      code: 'mcp-test-message-empty',
    })
    await expect(
      service.create(actor, mcp, { ...base, message: '界'.repeat(21_846) }),
    ).rejects.toMatchObject({ code: 'mcp-test-message-too-large' })
    expect(runs).toBe(0)
  })

  test('resumes multiple turns and expires only after 10 minutes of terminal idle', async () => {
    const { db, mcp, root } = await seed()
    let now = 1_000
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      runFn: async (opts) => {
        runs += 1
        await opts.onSpawned?.({
          pid: 10 + runs,
          spawnedAt: now,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-session')
        await opts.eventSink?.append({
          ts: now,
          kind: 'text',
          payload: JSON.stringify({
            type: 'text',
            sessionID: 'native-session',
            messageID: `message-${runs}`,
            part: { type: 'text', text: `answer-${runs}` },
          }),
          sessionId: 'native-session',
          parentSessionId: null,
          source: 'stream',
          externalEventId: `part-${runs}`,
        })
        await opts.eventSink?.markTerminal('complete')
        return successResult(opts, 'native-session')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'first',
      clientCreateId: 'create-1',
      clientMessageId: 'message-1',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    let session = await service.get(actor, mcp.id, created.sessionId)
    expect(session.status).toBe('active')
    expect(session.nativeSessionReady).toBe(true)
    expect(session.idleDeadlineAt).toBe(now + MCP_RUNTIME_TEST_IDLE_MS)

    now = session.idleDeadlineAt! - 1
    await service.reconcile()
    expect((await service.get(actor, mcp.id, session.id)).status).toBe('active')

    const second = await service.message(actor, mcp, session.id, {
      message: 'second',
      clientMessageId: 'message-2',
      expectedSessionVersion: session.sessionVersion,
    })
    expect(second.acceptedTurnId).not.toBe(created.acceptedTurnId)
    await waitFor(
      async () => (await service.get(actor, mcp.id, session.id)).inFlightTurnId === null,
    )
    session = await service.get(actor, mcp.id, session.id)
    expect(session.turns.map((turn) => turn.prompt)).toEqual(['first', 'second'])
    expect(runs).toBe(2)
    expect(session.idleDeadlineAt).toBe(now + MCP_RUNTIME_TEST_IDLE_MS)

    now = session.idleDeadlineAt!
    await service.reconcile()
    session = await service.get(actor, mcp.id, session.id)
    expect(session.status).toBe('ended')
    expect(session.endReason).toBe('idle-timeout')
  })

  test('explicit conversation reset rotates the playground native lease and next-turn resume id', async () => {
    const { db, mcp, root, runtimeName } = await seed('claude-code')
    const observedBeforeRuns: Array<string | null> = []
    let initialNativeId: string | null = null
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        expect(opts.nativeIdentityAuthoritative).toBe(true)
        runs += 1
        const persistedNativeId =
          db
            .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
            .from(mcpRuntimeTestSessions)
            .get()?.id ?? null
        observedBeforeRuns.push(persistedNativeId)
        await opts.onSpawned?.({
          pid: 100 + runs,
          spawnedAt: runs,
          spawnBinaryPath: canonicalBinaryPath('claude'),
        })
        if (runs === 1) {
          expect(persistedNativeId).not.toBeNull()
          initialNativeId = persistedNativeId
          await opts.eventSink?.setRootSessionId(persistedNativeId!)
          await opts.eventSink?.append({
            ts: 1,
            kind: 'text',
            payload: JSON.stringify({
              type: 'assistant',
              session_id: persistedNativeId,
              message: { content: [{ type: 'text', text: 'before reset' }] },
            }),
            sessionId: persistedNativeId!,
            parentSessionId: null,
            source: 'stream',
          })
          await opts.eventSink?.markRootSessionResetPending?.(persistedNativeId!)
          await opts.eventSink?.append({
            ts: 2,
            kind: 'text',
            payload: JSON.stringify({
              type: 'conversation_reset',
              session_id: persistedNativeId,
              new_conversation_id: 'ui-correlation-only',
            }),
            sessionId: persistedNativeId!,
            parentSessionId: null,
            source: 'stream',
          })
          await opts.eventSink?.setRootSessionId('native-reset-new', persistedNativeId!)
        } else {
          await opts.eventSink?.setRootSessionId('native-reset-new')
        }
        await opts.eventSink?.markTerminal('complete')
        return successResult(opts, 'native-reset-new')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName,
      message: 'first',
      clientCreateId: 'create-reset',
      clientMessageId: 'message-reset-1',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    let session = await service.get(actor, mcp.id, created.sessionId)
    expect(session.nativeSessionReady).toBe(true)
    expect(
      db
        .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, created.sessionId))
        .get(),
    ).toEqual({ id: 'native-reset-new' })

    await service.message(actor, mcp, created.sessionId, {
      message: 'second',
      clientMessageId: 'message-reset-2',
      expectedSessionVersion: session.sessionVersion,
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    session = await service.get(actor, mcp.id, created.sessionId)
    expect(session.nativeSessionReady).toBe(true)
    expect(initialNativeId).not.toBeNull()
    expect(observedBeforeRuns).toEqual([initialNativeId, 'native-reset-new'])
    expect(
      db
        .select({ id: mcpRuntimeTestEvents.sessionId })
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, created.sessionId))
        .all(),
    ).toEqual([{ id: 'native-reset-new' }, { id: 'native-reset-new' }])
  })

  test('reset without replacement makes an established playground session unusable', async () => {
    const { db, mcp, root, runtimeName } = await seed('claude-code')
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        expect(opts.nativeIdentityAuthoritative).toBe(true)
        runs += 1
        const persistedNativeId = db
          .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
          .from(mcpRuntimeTestSessions)
          .get()?.id
        expect(persistedNativeId).toBeString()
        await opts.onSpawned?.({
          pid: 200 + runs,
          spawnedAt: runs,
          spawnBinaryPath: canonicalBinaryPath('claude'),
        })
        await opts.eventSink?.setRootSessionId(persistedNativeId!)
        if (runs === 1) {
          await opts.eventSink?.markTerminal('complete')
          return successResult(opts, persistedNativeId!)
        }
        await opts.eventSink?.markRootSessionResetPending?.(persistedNativeId!)
        await opts.eventSink?.append({
          ts: 2,
          kind: 'text',
          payload: JSON.stringify({
            type: 'conversation_reset',
            session_id: persistedNativeId,
            new_conversation_id: 'ui-correlation-only',
          }),
          sessionId: persistedNativeId!,
          parentSessionId: null,
          source: 'stream',
        })
        await opts.eventSink?.markTerminal('incomplete', 'stream-persist-failed')
        const failed = successResult(opts, persistedNativeId!, 'exit-nonzero')
        delete failed.capturedSessionId
        failed.nativeSessionIntegrityFailed = true
        return failed
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName,
      message: 'first',
      clientCreateId: 'create-reset-eof',
      clientMessageId: 'message-reset-eof-1',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    const ready = await service.get(actor, mcp.id, created.sessionId)
    await service.message(actor, mcp, created.sessionId, {
      message: 'reset then eof',
      clientMessageId: 'message-reset-eof-2',
      expectedSessionVersion: ready.sessionVersion,
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ended',
    )
    const ended = await service.get(actor, mcp.id, created.sessionId)
    expect(ended.nativeSessionReady).toBe(false)
    expect(ended.endReason).toBe('session-unusable')
    expect(ended.turns.at(-1)).toMatchObject({
      captureState: 'incomplete',
      failureCode: 'mcp-test-session-conflict',
    })
    expect(
      db
        .select({ reason: mcpRuntimeTestTurns.captureIncompleteReason })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, ended.turns.at(-1)!.id))
        .get(),
    ).toEqual({ reason: 'stream-persist-failed' })
    expect(runs).toBe(2)
  })

  test('native identity integrity failure cannot restore a prior ready resume id', async () => {
    const { db, mcp, root, runtimeName } = await seed('claude-code')
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        expect(opts.nativeIdentityAuthoritative).toBe(true)
        runs += 1
        const persistedNativeId = db
          .select({ id: mcpRuntimeTestSessions.runtimeSessionId })
          .from(mcpRuntimeTestSessions)
          .get()?.id
        expect(persistedNativeId).toBeString()
        await opts.onSpawned?.({
          pid: 300 + runs,
          spawnedAt: runs,
          spawnBinaryPath: canonicalBinaryPath('claude'),
        })
        await opts.eventSink?.setRootSessionId(persistedNativeId!)
        if (runs === 1) {
          await opts.eventSink?.markTerminal('complete')
          return successResult(opts, persistedNativeId!)
        }
        await opts.eventSink?.markTerminal('incomplete', 'stream-persist-failed')
        const failed = successResult(opts, persistedNativeId!, 'exit-nonzero')
        delete failed.capturedSessionId
        failed.nativeSessionIntegrityFailed = true
        return failed
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName,
      message: 'establish native session',
      clientCreateId: 'create-identity-invalid',
      clientMessageId: 'message-identity-invalid-1',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    const ready = await service.get(actor, mcp.id, created.sessionId)
    expect(ready.nativeSessionReady).toBe(true)

    await service.message(actor, mcp, created.sessionId, {
      message: 'contradict native identity',
      clientMessageId: 'message-identity-invalid-2',
      expectedSessionVersion: ready.sessionVersion,
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ended',
    )
    const ended = await service.get(actor, mcp.id, created.sessionId)
    expect(ended.nativeSessionReady).toBe(false)
    expect(ended.endReason).toBe('session-unusable')
    expect(ended.turns.at(-1)).toMatchObject({
      status: 'failed',
      captureState: 'incomplete',
      failureCode: 'mcp-test-session-conflict',
    })
  })

  test('cancel current turn preserves the session; end now terminates the next turn', async () => {
    const { db, mcp, root } = await seed()
    let now = 5_000
    let runIndex = 0
    let nativeSessionObserved = false
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      runFn: async (opts) => {
        runIndex += 1
        await opts.onSpawned?.({
          pid: 20 + runIndex,
          spawnedAt: now,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-cancel')
        nativeSessionObserved = true
        return await new Promise<SystemAgentRunResult>((resolveRun) => {
          const finish = () => {
            void opts.eventSink?.markTerminal('complete').then(() => {
              resolveRun(successResult(opts, 'native-cancel', 'aborted'))
            })
          }
          if (opts.abortSignal?.aborted === true) finish()
          else opts.abortSignal?.addEventListener('abort', finish, { once: true })
        })
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'cancel me',
      clientCreateId: 'create-cancel',
      clientMessageId: 'message-cancel-1',
    })
    await waitFor(
      async () =>
        (await service.get(actor, mcp.id, created.sessionId)).turns[0]?.status === 'running',
    )
    await waitFor(() => nativeSessionObserved)
    let session = await service.get(actor, mcp.id, created.sessionId)
    await service.cancel(actor, mcp.id, session.id, { turnId: created.acceptedTurnId })
    await waitFor(
      async () => (await service.get(actor, mcp.id, session.id)).inFlightTurnId === null,
    )
    session = await service.get(actor, mcp.id, session.id)
    expect(session.status).toBe('active')
    expect(session.turns[0]?.status).toBe('canceled')

    now += 100
    const accepted = await service.message(actor, mcp, session.id, {
      message: 'end this one',
      clientMessageId: 'message-cancel-2',
      expectedSessionVersion: session.sessionVersion,
    })
    await waitFor(async () =>
      (await service.get(actor, mcp.id, session.id)).turns.some(
        (turn) => turn.id === accepted.acceptedTurnId && turn.status === 'running',
      ),
    )
    const ended = await service.end(actor, mcp.id, session.id)
    expect(ended.session.status).toBe('ended')
    expect(ended.session.endReason).toBe('user')
    expect(ended.session.turns[1]?.status).toBe('interrupted')
  })

  test('canceling the first turn before a native session is ready ends the logical session', async () => {
    const { db, mcp, root } = await seed()
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        await opts.onSpawned?.({
          pid: 25,
          spawnedAt: 1,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        return await new Promise<SystemAgentRunResult>((resolveRun) => {
          const finish = () =>
            resolveRun({
              status: 'aborted',
              exitCode: null,
              eventText: '',
              stderrTail: '',
              durationMs: 1,
              scratchDir: join(opts.scratchParent, opts.scratchName ?? 'unknown'),
              scratchRetained: true,
              outputEvidence: emptySystemAgentOutputEvidence(),
            })
          if (opts.abortSignal?.aborted === true) finish()
          else opts.abortSignal?.addEventListener('abort', finish, { once: true })
        })
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'cancel before session capture',
      clientCreateId: 'create-pre-session-cancel',
      clientMessageId: 'message-pre-session-cancel',
    })
    await waitFor(
      async () =>
        (await service.get(actor, mcp.id, created.sessionId)).turns[0]?.status === 'running',
    )
    await service.cancel(actor, mcp.id, created.sessionId, {
      turnId: created.acceptedTurnId,
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ended',
    )
    const ended = await service.get(actor, mcp.id, created.sessionId)
    expect(ended.endReason).toBe('session-unusable')
    expect(ended.nativeSessionReady).toBe(false)
    expect(ended.turns[0]?.status).toBe('canceled')
  })

  test('create idempotency and canonical event dedupe prevent repeated side effects', async () => {
    const { db, mcp, root } = await seed()
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        runs += 1
        await opts.onSpawned?.({
          pid: 30,
          spawnedAt: 1,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-idempotent')
        await opts.eventSink?.markTerminal('complete')
        return successResult(opts, 'native-idempotent')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const input = {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'only once',
      clientCreateId: 'create-idempotent',
      clientMessageId: 'message-idempotent',
    } as const
    const first = await service.create(actor, mcp, input)
    const replay = await service.create(actor, mcp, input)
    expect(replay).toEqual(first)
    expect(await service.create(actor, { ...mcp, enabled: false }, input)).toEqual(first)
    await expect(
      service.create(actor, mcp, { ...input, message: 'different' }),
    ).rejects.toMatchObject({ code: 'mcp-test-idempotency-mismatch' })
    await waitFor(
      async () => (await service.get(actor, mcp.id, first.sessionId)).inFlightTurnId === null,
    )
    expect(runs).toBe(1)

    const turnId = first.acceptedTurnId
    const sink = new McpRuntimeTestEventSink(db, {
      sessionId: first.sessionId,
      turnId,
    })
    // Re-open capture only for this isolated sink/dedupe assertion.
    db.update(mcpRuntimeTestTurns)
      .set({ captureState: 'live' })
      .where(eq(mcpRuntimeTestTurns.id, turnId))
      .run()
    await sink.append({
      ts: 2,
      kind: 'text',
      payload: '{}',
      sessionId: 'native-idempotent',
      parentSessionId: null,
      source: 'stream',
      externalEventId: 'same-part',
    })
    await sink.append({
      ts: 3,
      kind: 'text',
      payload: '{}',
      sessionId: 'native-idempotent',
      parentSessionId: null,
      source: 'post-run-child',
      externalEventId: 'same-part',
    })
    expect(
      db
        .select()
        .from(mcpRuntimeTestEvents)
        .where(eq(mcpRuntimeTestEvents.testSessionId, first.sessionId))
        .all(),
    ).toHaveLength(1)
  })

  test('message response-loss replay is exact and does not schedule a duplicate turn', async () => {
    const { db, mcp, root } = await seed()
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        runs += 1
        await opts.onSpawned?.({
          pid: 300 + runs,
          spawnedAt: runs,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-message-replay')
        await opts.eventSink?.markTerminal('complete')
        return successResult(opts, 'native-message-replay')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'first',
      clientCreateId: 'create-message-replay',
      clientMessageId: 'message-replay-1',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )
    const idle = await service.get(actor, mcp.id, created.sessionId)
    const input = {
      message: 'second',
      clientMessageId: 'message-replay-2',
      expectedSessionVersion: idle.sessionVersion,
    } as const
    const accepted = await service.message(actor, mcp, idle.id, input)
    const replay = await service.message(actor, mcp, idle.id, input)
    expect(replay).toEqual(accepted)
    await expect(
      service.message(actor, mcp, idle.id, { ...input, message: 'different' }),
    ).rejects.toMatchObject({ code: 'mcp-test-idempotency-mismatch' })
    await waitFor(async () => (await service.get(actor, mcp.id, idle.id)).inFlightTurnId === null)
    expect(runs).toBe(2)
    expect((await service.get(actor, mcp.id, idle.id)).turns).toHaveLength(2)
  })

  test('transcripts are owner-only while mcp-runtime-tests:audit grants exact-id read only', async () => {
    const { db, mcp, root } = await seed()
    for (const id of ['owner-user', 'stranger-user']) {
      db.insert(users)
        .values({
          id,
          username: id,
          displayName: id,
          role: 'user',
          status: 'active',
          forcePasswordChange: false,
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
    }
    const ownerActor = buildActor({
      user: {
        id: 'owner-user',
        username: 'owner-user',
        displayName: 'Owner',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })
    const strangerActor = buildActor({
      user: {
        id: 'stranger-user',
        username: 'stranger-user',
        displayName: 'Stranger',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })
    const auditorActor = buildActor({
      user: {
        id: 'stranger-user',
        username: 'stranger-user',
        displayName: 'Auditor',
        role: 'user',
        status: 'active',
      },
      source: 'session',
      additionalPermissions: ['mcp-runtime-tests:audit'],
    })
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        await opts.eventSink?.setRootSessionId('native-private')
        await opts.eventSink?.markTerminal('complete')
        return successResult(opts, 'native-private')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(ownerActor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'private transcript',
      clientCreateId: 'create-private',
      clientMessageId: 'message-private',
    })
    await waitFor(
      async () =>
        (await service.get(ownerActor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )

    await expect(service.get(strangerActor, mcp.id, created.sessionId)).rejects.toMatchObject({
      code: 'mcp-test-session-not-found',
    })
    expect(await service.latest(strangerActor, mcp.id)).toBeNull()
    expect((await service.get(auditorActor, mcp.id, created.sessionId)).id).toBe(created.sessionId)
    expect(await service.latest(auditorActor, mcp.id)).toBeNull()
    await expect(service.end(auditorActor, mcp.id, created.sessionId)).rejects.toMatchObject({
      code: 'mcp-test-session-not-found',
    })
  })

  test('end intent wins the final pre-spawn fence and prevents a late process start', async () => {
    const { db, mcp, root } = await seed()
    let planReady = false
    let releasePlan = (): void => {}
    let spawnAttempts = 0
    const proceed = new Promise<void>((resolveProceed) => {
      releasePlan = resolveProceed
    })
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        if (opts.testPlanOverride === undefined) throw new Error('missing test build plan')
        const plan = await opts.testPlanOverride({
          driver: getRuntimeDriver(opts.protocol),
          worktreePath: join(root, 'worktree'),
          runDir: join(root, 'run'),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
        })
        planReady = true
        await proceed
        await plan.beforeSpawn?.()
        spawnAttempts += 1
        return successResult(opts, 'must-not-spawn')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'do not start after end',
      clientCreateId: 'create-fenced-end',
      clientMessageId: 'message-fenced-end',
    })
    await waitFor(() => planReady)

    const endPromise = service.end(actor, mcp.id, created.sessionId)
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ending',
    )
    releasePlan()
    const ended = await endPromise

    expect(spawnAttempts).toBe(0)
    expect(ended.session.status).toBe('ended')
    expect(ended.session.endReason).toBe('user')
    expect(ended.session.turns[0]?.status).toBe('interrupted')
  })

  test('the spawned receipt is durable and a crossed hard deadline still blocks prompt delivery', async () => {
    const { db, mcp, root } = await seed()
    let now = 1_000
    let promptDelivered = false
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      runFn: async (opts) => {
        if (opts.testPlanOverride === undefined || opts.onSpawned === undefined) {
          throw new Error('missing process-boundary hooks')
        }
        await opts.testPlanOverride({
          driver: getRuntimeDriver(opts.protocol),
          worktreePath: join(root, 'worktree'),
          runDir: join(root, 'run'),
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
        })
        now += MCP_RUNTIME_TEST_TURN_TIMEOUT_MS
        await opts.onSpawned({
          pid: 7331,
          spawnedAt: now,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        promptDelivered = true
        return successResult(opts, 'must-not-prompt')
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'deadline fence',
      clientCreateId: 'create-deadline-spawn-fence',
      clientMessageId: 'message-deadline-spawn-fence',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ended',
    )

    const turn = db
      .select()
      .from(mcpRuntimeTestTurns)
      .where(eq(mcpRuntimeTestTurns.id, created.acceptedTurnId))
      .get()
    expect(promptDelivered).toBe(false)
    expect(turn).toMatchObject({
      status: 'timed_out',
      failureCode: 'mcp-test-turn-timeout',
      pid: null,
      spawnBinaryPath: canonicalBinaryPath('opencode'),
    })
  })

  test('an unreaped child quarantines the session and blocks replacement', async () => {
    const { db, mcp, root } = await seed()
    let runs = 0
    let reapOutcome: 'kill-failed' | 'not-alive' = 'kill-failed'
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        runs += 1
        await opts.onSpawned?.({
          pid: 4241 + runs,
          spawnedAt: 1,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        if (runs > 1) {
          await opts.eventSink?.setRootSessionId('native-replacement')
          await opts.eventSink?.markTerminal('complete')
          return successResult(opts, 'native-replacement')
        }
        await opts.eventSink?.setRootSessionId('native-unreaped')
        await opts.eventSink?.markTerminal('incomplete', 'post-exit-flush-timeout')
        return successResult(opts, 'native-unreaped', 'unreaped')
      },
      killStaleRunProcessTree: async () => reapOutcome,
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'leave a survivor',
      clientCreateId: 'create-unreaped',
      clientMessageId: 'message-unreaped',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).status === 'ended',
    )
    const ended = await service.get(actor, mcp.id, created.sessionId)
    expect(ended.cleanupState).toBe('quarantined')
    expect(ended.endReason).toBe('capture-incomplete')
    expect(
      db
        .select({ pid: mcpRuntimeTestTurns.pid })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, created.acceptedTurnId))
        .get()?.pid,
    ).toBe(4242)
    expect(
      db
        .select({ cleanupErrorCode: mcpRuntimeTestSessions.cleanupErrorCode })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, created.sessionId))
        .get()?.cleanupErrorCode,
    ).toBe('mcp-test-child-unreaped')

    await expect(
      service.create(actor, mcp, {
        expectedMcpConfigHash: hash,
        runtimeName: 'test-opencode',
        message: 'replacement must be blocked',
        clientCreateId: 'create-after-unreaped',
        clientMessageId: 'message-after-unreaped',
      }),
    ).rejects.toMatchObject({ code: 'mcp-test-cleanup-quarantined' })

    reapOutcome = 'not-alive'
    await service.reconcile()
    const recovered = await service.get(actor, mcp.id, created.sessionId)
    expect(recovered.cleanupState).toBe('complete')
    expect(
      db
        .select({ pid: mcpRuntimeTestTurns.pid })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, created.acceptedTurnId))
        .get()?.pid,
    ).toBeNull()

    const replacement = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'replacement after proven reap',
      clientCreateId: 'create-after-proven-reap',
      clientMessageId: 'message-after-proven-reap',
    })
    await waitFor(
      async () => (await service.get(actor, mcp.id, replacement.sessionId)).inFlightTurnId === null,
    )
    expect(runs).toBe(2)
    expect((await service.get(actor, mcp.id, replacement.sessionId)).status).toBe('active')
  })

  test('boot recovery retains identity and scratch when the old child cannot be reaped', async () => {
    const { db, mcp, root } = await seed()
    const scratchRoot = join(root, 'mcp-runtime-tests', 'orphan-session')
    mkdirSync(scratchRoot, { recursive: true })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'orphan-session',
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'orphan-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'test-opencode',
        runtimeProtocol: 'opencode',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: canonicalBinaryPath('opencode'),
        nativeSessionState: 'pending',
        inFlightTurnId: 'orphan-turn',
        turnSeq: 1,
        sessionVersion: 1,
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 900,
        updatedAt: 900,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'orphan-turn',
        sessionId: 'orphan-session',
        seq: 1,
        clientMessageId: 'orphan-message',
        promptText: 'was running before restart',
        status: 'running',
        hardDeadlineAt: 10_000,
        captureState: 'live',
        pid: 5151,
        spawnedAt: 910,
        spawnBinaryPath: canonicalBinaryPath('opencode'),
        startedAt: 905,
        createdAt: 900,
      })
      .run()
    let reapedPid: number | null = null
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 1_000,
      killStaleRunProcessTree: async (run) => {
        reapedPid = run.pid
        return 'kill-failed'
      },
    })
    await service.start()
    await waitFor(
      () =>
        db
          .select({ status: mcpRuntimeTestSessions.status })
          .from(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, 'orphan-session'))
          .get()?.status === 'ended',
    )
    const recovered = await service.get(actor, mcp.id, 'orphan-session')
    expect(String(reapedPid)).toBe('5151')
    expect(recovered.cleanupState).toBe('quarantined')
    expect(recovered.turns[0]?.status).toBe('interrupted')
    expect(existsSync(scratchRoot)).toBe(true)
    expect(
      db
        .select({ pid: mcpRuntimeTestTurns.pid })
        .from(mcpRuntimeTestTurns)
        .where(eq(mcpRuntimeTestTurns.id, 'orphan-turn'))
        .get()?.pid,
    ).toBe(5151)
  })

  test('boot preserves a completely captured native session after the old child is gone', async () => {
    const { db, mcp, root } = await seed()
    const sessionId = 'recovered-opencode-session'
    const turnId = 'recovered-opencode-turn'
    const runtimeSessionId = 'native-recovered-opencode'
    const scratchRoot = join(root, 'mcp-runtime-tests', sessionId)
    mkdirSync(scratchRoot, { recursive: true })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: sessionId,
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'recovered-opencode-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'test-opencode',
        runtimeProtocol: 'opencode',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: canonicalBinaryPath('opencode'),
        runtimeSessionId,
        nativeSessionState: 'ready',
        inFlightTurnId: turnId,
        turnSeq: 1,
        sessionVersion: 1,
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 900,
        updatedAt: 900,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: turnId,
        sessionId,
        seq: 1,
        clientMessageId: 'recovered-opencode-message',
        promptText: 'captured before the daemon stopped',
        status: 'running',
        hardDeadlineAt: 10_000,
        captureState: 'complete',
        pid: 8181,
        spawnedAt: 910,
        spawnBinaryPath: canonicalBinaryPath('opencode'),
        startedAt: 905,
        createdAt: 900,
      })
      .run()

    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 1_000,
      killStaleRunProcessTree: async () => 'not-alive',
    })
    await service.start()
    const recovered = await service.get(actor, mcp.id, sessionId)
    expect(recovered.status).toBe('active')
    expect(recovered.inFlightTurnId).toBeNull()
    expect(recovered.nativeSessionReady).toBe(true)
    expect(recovered.idleDeadlineAt).toBe(1_000 + MCP_RUNTIME_TEST_IDLE_MS)
    expect(recovered.turns[0]?.status).toBe('interrupted')
    expect(recovered.turns[0]?.captureState).toBe('complete')
    expect(existsSync(scratchRoot)).toBe(true)
  })

  test('graceful shutdown reaps the turn, preserves a proven native session, and rejects new work', async () => {
    const { db, mcp, root } = await seed()
    let running = false
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        await opts.onSpawned?.({
          pid: 6161,
          spawnedAt: 10,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-shutdown')
        running = true
        return await new Promise<SystemAgentRunResult>((resolveRun) => {
          const finish = () => {
            void opts.eventSink?.markTerminal('complete').then(() => {
              resolveRun(successResult(opts, 'native-shutdown', 'aborted'))
            })
          }
          if (opts.abortSignal?.aborted === true) finish()
          else opts.abortSignal?.addEventListener('abort', finish, { once: true })
        })
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'running during shutdown',
      clientCreateId: 'create-shutdown',
      clientMessageId: 'message-shutdown',
    })
    await waitFor(() => running)

    await service.shutdown(1_000)
    const resumed = await service.get(actor, mcp.id, created.sessionId)
    expect(resumed.status).toBe('active')
    expect(resumed.endReason).toBeNull()
    expect(resumed.nativeSessionReady).toBe(true)
    expect(resumed.inFlightTurnId).toBeNull()
    expect(resumed.idleDeadlineAt).not.toBeNull()
    expect(resumed.turns[0]?.status).toBe('interrupted')
    expect(resumed.turns[0]?.failureCode).toBe('mcp-test-daemon-shutdown')
    expect(resumed.cleanupState).toBe('not-started')
    await expect(
      service.create(actor, mcp, {
        expectedMcpConfigHash: hash,
        runtimeName: 'test-opencode',
        message: 'must be rejected',
        clientCreateId: 'create-after-shutdown',
        clientMessageId: 'message-after-shutdown',
      }),
    ).rejects.toMatchObject({ code: 'mcp-test-service-stopping' })
  })

  test('graceful shutdown also reaps a turn already marked ending by a durable mutation', async () => {
    const { db, mcp, root } = await seed()
    let running = false
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      runFn: async (opts) => {
        await opts.onSpawned?.({
          pid: 6262,
          spawnedAt: 10,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-ending-shutdown')
        running = true
        return await new Promise<SystemAgentRunResult>((resolveRun) => {
          const finish = () => {
            void opts.eventSink?.markTerminal('complete').then(() => {
              resolveRun(successResult(opts, 'native-ending-shutdown', 'aborted'))
            })
          }
          if (opts.abortSignal?.aborted === true) finish()
          else opts.abortSignal?.addEventListener('abort', finish, { once: true })
        })
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'running while access is revoked',
      clientCreateId: 'create-ending-shutdown',
      clientMessageId: 'message-ending-shutdown',
    })
    await waitFor(() => running)
    db.update(mcpRuntimeTestSessions)
      .set({
        status: 'ending',
        endReason: 'access-revoked',
        idleDeadlineAt: null,
      })
      .where(eq(mcpRuntimeTestSessions.id, created.sessionId))
      .run()

    await service.shutdown(1_000)
    const ended = await service.get(actor, mcp.id, created.sessionId)
    expect(ended.status).toBe('ended')
    expect(ended.endReason).toBe('access-revoked')
    expect(ended.inFlightTurnId).toBeNull()
    expect(ended.turns[0]?.status).toBe('interrupted')
    expect(ended.turns[0]?.failureCode).toBe('mcp-test-daemon-shutdown')
    expect(ended.cleanupState).toBe('complete')
  })

  test('an accepted running turn times out at its hard deadline without ending a proven session', async () => {
    const { db, mcp, root } = await seed()
    let now = 20_000
    let running = false
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      runFn: async (opts) => {
        await opts.onSpawned?.({
          pid: 7171,
          spawnedAt: now,
          spawnBinaryPath: canonicalBinaryPath('opencode'),
        })
        await opts.eventSink?.setRootSessionId('native-timeout')
        running = true
        return await new Promise<SystemAgentRunResult>((resolveRun) => {
          const finish = () => {
            void opts.eventSink?.markTerminal('complete').then(() => {
              resolveRun(successResult(opts, 'native-timeout', 'aborted'))
            })
          }
          if (opts.abortSignal?.aborted === true) finish()
          else opts.abortSignal?.addEventListener('abort', finish, { once: true })
        })
      },
    })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    const created = await service.create(actor, mcp, {
      expectedMcpConfigHash: hash,
      runtimeName: 'test-opencode',
      message: 'run until the accepted deadline',
      clientCreateId: 'create-timeout',
      clientMessageId: 'message-timeout',
    })
    await waitFor(() => running)
    const admitted = await service.get(actor, mcp.id, created.sessionId)
    now = admitted.turns[0]!.hardDeadlineAt
    await service.reconcile()
    await waitFor(
      async () => (await service.get(actor, mcp.id, created.sessionId)).inFlightTurnId === null,
    )

    const timedOut = await service.get(actor, mcp.id, created.sessionId)
    expect(timedOut.status).toBe('active')
    expect(timedOut.nativeSessionReady).toBe(true)
    expect(timedOut.turns[0]?.status).toBe('timed_out')
    expect(timedOut.turns[0]?.failureCode).toBe('mcp-test-turn-timeout')
    expect(timedOut.idleDeadlineAt).toBe(now + MCP_RUNTIME_TEST_IDLE_MS)
  })

  test('reconciliation times out an expired queued continuation before it can spawn', async () => {
    const { db, mcp, root } = await seed()
    let now = 100
    let runs = 0
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      runFn: async (opts) => {
        runs += 1
        return successResult(opts, 'must-not-run')
      },
    })
    await service.start()
    const scratchRoot = join(root, 'mcp-runtime-tests', 'expired-queued-session')
    mkdirSync(scratchRoot, { recursive: true })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'expired-queued-session',
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'expired-queued-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude',
        runtimeSessionId: 'native-expired-queued',
        nativeSessionState: 'ready',
        inFlightTurnId: 'expired-queued-turn',
        turnSeq: 2,
        sessionVersion: 2,
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 2,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'expired-queued-turn',
        sessionId: 'expired-queued-session',
        seq: 2,
        clientMessageId: 'expired-queued-message',
        promptText: 'must expire in the queue',
        status: 'queued',
        hardDeadlineAt: 200,
        captureState: 'live',
        createdAt: 50,
      })
      .run()

    now = 200
    await service.reconcile()
    const recovered = await service.get(actor, mcp.id, 'expired-queued-session')
    expect(runs).toBe(0)
    expect(recovered.status).toBe('active')
    expect(recovered.inFlightTurnId).toBeNull()
    expect(recovered.turns[0]?.status).toBe('timed_out')
    expect(recovered.turns[0]?.failureCode).toBe('mcp-test-turn-timeout')
    expect(recovered.idleDeadlineAt).toBe(now + MCP_RUNTIME_TEST_IDLE_MS)
  })

  test('worker admission preserves a ready continuation that expires while queued', async () => {
    const { db, mcp, root } = await seed()
    db.insert(mcps)
      .values({
        id: 'mcp-2',
        name: 'fixture_two',
        description: '',
        type: 'local',
        config: JSON.stringify({ command: ['fixture-mcp-two'] }),
        enabled: true,
        ownerUserId: SYSTEM_USER_ID,
        visibility: 'private',
      })
      .run()
    const secondMcp = await getMcpById(db, 'mcp-2')
    if (secondMcp === null) throw new Error('second fixture MCP missing')

    let now = 100
    let runs = 0
    let releaseBlockingRun = (): void => {}
    const blockingRun = new Promise<void>((resolveRun) => {
      releaseBlockingRun = resolveRun
    })
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => now,
      capacity: 1,
      runFn: async (opts) => {
        runs += 1
        if (opts.prompt === 'block the only worker') {
          await opts.eventSink?.setRootSessionId('native-blocking')
          await blockingRun
          return successResult(opts, 'native-blocking')
        }
        if (opts.prompt === 'must expire before spawn') {
          throw new Error('expired queued continuation spawned')
        }
        await opts.eventSink?.setRootSessionId('native-continuation')
        return successResult(opts, 'native-continuation')
      },
    })
    const { mcpOperationConfigHashOf } = await import('../src/services/mcpOperationRevision')
    const primed = await service.create(actor, secondMcp, {
      expectedMcpConfigHash: mcpOperationConfigHashOf(secondMcp),
      runtimeName: 'test-opencode',
      message: 'prime continuation',
      clientCreateId: 'create-worker-timeout-prime',
      clientMessageId: 'message-worker-timeout-prime',
    })
    await waitFor(
      async () =>
        (await service.get(actor, secondMcp.id, primed.sessionId)).inFlightTurnId === null,
    )
    const blocker = await service.create(actor, mcp, {
      expectedMcpConfigHash: mcpOperationConfigHashOf(mcp),
      runtimeName: 'test-opencode',
      message: 'block the only worker',
      clientCreateId: 'create-worker-timeout-blocker',
      clientMessageId: 'message-worker-timeout-blocker',
    })
    await waitFor(
      async () =>
        (await service.get(actor, mcp.id, blocker.sessionId)).turns[0]?.status === 'running',
    )

    const idle = await service.get(actor, secondMcp.id, primed.sessionId)
    await service.message(actor, secondMcp, primed.sessionId, {
      message: 'must expire before spawn',
      clientMessageId: 'message-worker-timeout-expired',
      expectedSessionVersion: idle.sessionVersion,
    })
    const queued = await service.get(actor, secondMcp.id, primed.sessionId)
    now = queued.turns[1]!.hardDeadlineAt
    releaseBlockingRun()

    await waitFor(
      () =>
        db
          .select({ status: mcpRuntimeTestTurns.status })
          .from(mcpRuntimeTestTurns)
          .where(eq(mcpRuntimeTestTurns.id, queued.turns[1]!.id))
          .get()?.status === 'timed_out',
    )
    const recovered = await service.get(actor, secondMcp.id, primed.sessionId)
    expect(runs).toBe(2)
    expect(recovered.status).toBe('active')
    expect(recovered.nativeSessionReady).toBe(true)
    expect(recovered.turns[1]?.status).toBe('timed_out')
    expect(recovered.turns[1]?.failureCode).toBe('mcp-test-turn-timeout')
    expect(recovered.idleDeadlineAt).toBe(now + MCP_RUNTIME_TEST_IDLE_MS)
  })

  test('canceling a queued continuation does not reopen a drift-blocked session', async () => {
    const { db, mcp, root } = await seed()
    const sessionId = 'blocked-queued-session'
    const turnId = 'blocked-queued-turn'
    const scratchRoot = join(root, 'mcp-runtime-tests', sessionId)
    mkdirSync(join(scratchRoot, 'session-store'), { recursive: true })
    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 10,
      runFn: async () => {
        throw new Error('blocked queued turn must not run')
      },
    })
    await service.start()
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: sessionId,
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'blocked-queued-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude',
        runtimeSessionId: 'native-blocked-queued',
        nativeSessionState: 'ready',
        inFlightTurnId: turnId,
        turnSeq: 2,
        sessionVersion: 2,
        continuationBlockedReason: 'mcp-config-changed',
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 2,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: turnId,
        sessionId,
        seq: 2,
        clientMessageId: 'blocked-queued-message',
        promptText: 'must not reopen',
        status: 'queued',
        hardDeadlineAt: 600_002,
        captureState: 'live',
        createdAt: 2,
      })
      .run()

    const canceled = await service.cancel(actor, mcp.id, sessionId, { turnId })
    expect(canceled.session.status).toBe('ended')
    expect(canceled.session.endReason).toBe('session-unusable')
    expect(canceled.session.turns[0]?.status).toBe('canceled')
    expect(canceled.session.cleanupState).toBe('complete')
  })

  test('boot safely settles a never-spawned queued turn without quarantining it', async () => {
    const { db, mcp, root } = await seed()
    const scratchRoot = join(root, 'mcp-runtime-tests', 'queued-session')
    mkdirSync(scratchRoot, { recursive: true })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'queued-session',
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'queued-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude',
        nativeSessionState: 'pending',
        inFlightTurnId: 'queued-turn',
        turnSeq: 1,
        sessionVersion: 1,
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values({
        id: 'queued-turn',
        sessionId: 'queued-session',
        seq: 1,
        clientMessageId: 'queued-message',
        promptText: 'never spawned',
        status: 'queued',
        hardDeadlineAt: 600_001,
        captureState: 'live',
        createdAt: 1,
      })
      .run()

    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 10,
    })
    await service.start()
    const recovered = await service.get(actor, mcp.id, 'queued-session')
    expect(recovered.status).toBe('ended')
    expect(recovered.cleanupState).toBe('complete')
    expect(recovered.turns[0]?.status).toBe('interrupted')
    expect(existsSync(scratchRoot)).toBe(false)
  })

  test('boot keeps a proven native session active when a later queued turn never spawned', async () => {
    const { db, mcp, root } = await seed()
    const scratchRoot = join(root, 'mcp-runtime-tests', 'queued-resume-session')
    mkdirSync(scratchRoot, { recursive: true })
    const hash = (await import('../src/services/mcpOperationRevision')).mcpOperationConfigHashOf(
      mcp,
    )
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'queued-resume-session',
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'queued-resume-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'active',
        mcpConfigHash: hash,
        runtimeRowId: 'runtime-1',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude',
        runtimeSessionId: 'native-queued-resume',
        nativeSessionState: 'ready',
        inFlightTurnId: 'queued-resume-turn-2',
        turnSeq: 2,
        sessionVersion: 2,
        scratchRoot,
        cleanupState: 'not-started',
        createdAt: 1,
        updatedAt: 2,
      })
      .run()
    db.insert(mcpRuntimeTestTurns)
      .values([
        {
          id: 'queued-resume-turn-1',
          sessionId: 'queued-resume-session',
          seq: 1,
          clientMessageId: 'queued-resume-message-1',
          promptText: 'completed before restart',
          status: 'succeeded',
          hardDeadlineAt: 600_001,
          captureState: 'complete',
          durationMs: 1,
          startedAt: 1,
          finishedAt: 2,
          createdAt: 1,
        },
        {
          id: 'queued-resume-turn-2',
          sessionId: 'queued-resume-session',
          seq: 2,
          clientMessageId: 'queued-resume-message-2',
          promptText: 'accepted but never spawned',
          status: 'queued',
          hardDeadlineAt: 600_003,
          captureState: 'live',
          createdAt: 3,
        },
      ])
      .run()

    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 10,
    })
    await service.start()
    const recovered = await service.get(actor, mcp.id, 'queued-resume-session')
    expect(recovered.status).toBe('active')
    expect(recovered.inFlightTurnId).toBeNull()
    expect(recovered.nativeSessionReady).toBe(true)
    expect(recovered.idleDeadlineAt).toBe(10 + MCP_RUNTIME_TEST_IDLE_MS)
    expect(recovered.turns[1]?.status).toBe('interrupted')
    expect(recovered.turns[1]?.captureState).toBe('complete')
    expect(existsSync(scratchRoot)).toBe(true)
  })

  test('periodic reconciliation retries pending cleanup and expires old create receipts', async () => {
    const { db, mcp, root } = await seed()
    const scratchRoot = join(root, 'mcp-runtime-tests', 'pending-session')
    mkdirSync(scratchRoot, { recursive: true })
    db.insert(mcpRuntimeTestSessions)
      .values({
        id: 'pending-session',
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'pending-create',
        clientCreateDigest: 'a'.repeat(64),
        status: 'ended',
        endReason: 'user',
        mcpConfigHash: 'a'.repeat(64),
        runtimeRowId: 'runtime-1',
        runtimeName: 'claude-code',
        runtimeProtocol: 'claude-code',
        runtimeSnapshotJson: '{}',
        runtimeBinaryPath: '/mock/claude',
        nativeSessionState: 'ready',
        turnSeq: 0,
        sessionVersion: 1,
        scratchRoot,
        cleanupState: 'pending',
        cleanupErrorCode: 'mcp-test-cleanup-failed',
        createdAt: 1,
        updatedAt: 2,
        endedAt: 2,
      })
      .run()
    db.insert(mcpRuntimeTestCreateReceipts)
      .values({
        mcpId: mcp.id,
        ownerUserId: SYSTEM_USER_ID,
        clientCreateId: 'expired-create',
        requestDigest: 'c'.repeat(64),
        sessionId: 'expired-session',
        acceptedTurnId: 'expired-turn',
        createdAt: 1,
        expiresAt: 2,
      })
      .run()

    const service = new McpRuntimeTestService({
      db,
      configPath: join(root, 'config.json'),
      appHome: root,
      now: () => 10,
    })
    await service.start()
    expect(
      db
        .select({ cleanupState: mcpRuntimeTestSessions.cleanupState })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, 'pending-session'))
        .get()?.cleanupState,
    ).toBe('complete')
    expect(existsSync(scratchRoot)).toBe(false)
    expect(db.select().from(mcpRuntimeTestCreateReceipts).all()).toHaveLength(0)
  })
})
