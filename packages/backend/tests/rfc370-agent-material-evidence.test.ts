// RFC-370: evidence comes from the selected native material binding. These
// regressions cover optional capabilities, original receiver/Promise/error
// identity, logical capture epochs and actual native inventory/transcripts.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionCaptureRequest } from '../src/modules/runtime-management/application/ports/agentMaterialEvidence'
import type { NativeUsageCapture } from '../src/modules/runtime-management/application/ports/nativeUsageCapture'
import type {
  NativeAgentMaterialEvidenceHooks,
  NativeAgentMaterialEvidenceScope,
} from '../src/modules/runtime-management/infrastructure/local/agentMaterialEvidence'
import type {
  RuntimeSessionCaptureEvent,
  RuntimeSessionCapturePersistence,
} from '../src/modules/task-execution/application/ports/runtimeSessionCapturePersistence'
import { getRuntimeDriver, bindNativeAgentMaterialEvidence } from '../src/services/runtime'
import { cwdSlug } from '../src/services/runtime/claudeCode/sessionCapture'
import { NOOP_HANDLE } from '../src/services/runtime/opencode/subagentLiveCapture'
import type {
  AgentSpawnPlan,
  SessionCaptureContext,
  SystemAgentSessionSweepContext,
} from '../src/services/runtime/types'
import { createLogger } from '../src/util/log'

const log = createLogger('rfc370-material-evidence')
const persistence: RuntimeSessionCapturePersistence = {
  resolveTaskId: async () => 'task',
  listSiblingCapturedSessionIds: async () => new Set(),
  appendEvents: async () => {},
}
const scope: NativeAgentMaterialEvidenceScope = {
  environment: () => ({}),
  runContent: () => '/selected-run',
  sessionLocation: () => ({ worktreePath: '/selected-worktree' }),
}

describe('RFC-370 selected material evidence', () => {
  test('construction reads neither optional hooks nor physical scope; absence stays unsupported', () => {
    let methodReads = 0
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      get prepareUsageNormalizer() {
        methodReads++
        return undefined
      },
    }
    const unavailable = () => {
      throw new Error('unsupported capability read physical scope')
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, {
      environment: unavailable,
      runContent: unavailable,
      sessionLocation: unavailable,
      liveLocation: unavailable,
    })
    expect(methodReads).toBe(0)
    expect(evidence.prepareUsageNormalizer).toBeUndefined()
    expect(methodReads).toBe(1)
    expect(evidence.prepareNativeUsageCapture).toBeUndefined()
    expect(evidence.prepareSpanCapture).toBeUndefined()
    expect(evidence.readInventory).toBeUndefined()
    expect(evidence.drainFinalEvents).toBeUndefined()
    expect(evidence.startLiveCapture).toBeUndefined()
    expect(evidence.captureSessionsToSink).toBeUndefined()
  })

  test('usage and spans keep the selected receiver, final env and complete inherited identity', () => {
    let currentEnv = { HOME: '/before-wrap' },
      reads = 0
    const selectedScope: NativeAgentMaterialEvidenceScope = {
      ...scope,
      environment() {
        expect<NativeAgentMaterialEvidenceScope>(this).toBe(selectedScope)
        reads++
        return currentEnv
      },
    }
    const normalize = () => ({ measurements: [], diagnostics: [] })
    const capture: NativeUsageCapture = {
      contract: 'opencode-child-steps-v1',
      nativeSource: 'fixture-native',
      includesRecord: () => false,
      begin: () => {},
      finish: () => [],
    }
    const spans = getRuntimeDriver('claude-code').prepareSpanCapture!({
      env: {},
      invocationId: 'i',
    })
    const nextRevision = () => 7
    const seen: unknown[] = []
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      prepareUsageNormalizer(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        seen.push(input)
        return normalize
      },
      prepareNativeUsageCapture(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        seen.push(input)
        return capture
      },
      prepareSpanCapture(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        seen.push(input)
        return spans
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, selectedScope)
    currentEnv = { HOME: '/after-wrap' }
    const identity = Object.create({
      invocationId: 'i',
      taskId: 't',
      nodeRunId: 'n',
      agentId: null,
      resumeSessionId: 'resume',
      nextRevision,
    })
    identity.env = { HOME: '/unselected' }
    expect(evidence.prepareUsageNormalizer!()).toBe(normalize)
    expect(evidence.prepareNativeUsageCapture!(identity)).toBe(capture)
    expect(evidence.prepareSpanCapture!(identity)).toBe(spans)
    expect(seen).toEqual([
      { env: currentEnv },
      {
        env: currentEnv,
        invocationId: 'i',
        taskId: 't',
        nodeRunId: 'n',
        agentId: null,
        resumeSessionId: 'resume',
        nextRevision,
      },
      { env: currentEnv, invocationId: 'i' },
    ])
    expect(reads).toBe(3)
    seen.length = 0
    evidence.prepareNativeUsageCapture!({
      invocationId: 'i',
      taskId: 't',
      nodeRunId: 'n',
      agentId: null,
    })
    expect(seen).toEqual([
      { env: currentEnv, invocationId: 'i', taskId: 't', nodeRunId: 'n', agentId: null },
    ])
  })

  test('capture preserves epochs, persistence and dedupe while native location stays selected', async () => {
    const dedupe = new Map([['child', new Set(['part'])]])
    let received: SessionCaptureContext | undefined
    const pending = Promise.resolve()
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        received = input
        return pending
      },
    }
    const request: AgentSessionCaptureRequest = Object.create({
      rootSessionId: 'epoch',
      logicalRootSessionId: 'final-root',
      nodeRunId: 'n',
      taskId: 't',
      persistence,
      log,
      alreadyInsertedPartIds: dedupe,
    })
    const location = Object.create({
      worktreePath: '/native-worktree',
      configDirEnv: 'NATIVE_CONFIG',
      configDirName: '.native',
      opencodeDbPath: '/private-fixture.db',
    })
    const evidence = bindNativeAgentMaterialEvidence(hooks, {
      ...scope,
      sessionLocation: () => location,
    })
    expect(evidence.captureSessions(request)).toBe(pending)
    await pending
    expect(received).toEqual({
      rootSessionId: 'epoch',
      logicalRootSessionId: 'final-root',
      nodeRunId: 'n',
      taskId: 't',
      persistence,
      log,
      alreadyInsertedPartIds: dedupe,
      worktreePath: '/native-worktree',
      configDirEnv: 'NATIVE_CONFIG',
      configDirName: '.native',
      opencodeDbPath: '/private-fixture.db',
    })
    expect(received?.persistence).toBe(persistence)
    expect(received?.alreadyInsertedPartIds).toBe(dedupe)
  })

  test('inventory/event delegates retain original Promise and reject/throw identity', async () => {
    const marker = new Error('native inventory unavailable')
    const pending = Promise.reject(marker)
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions() {
        throw marker
      },
      readInventory(input) {
        expect(input).toEqual({ runRoot: '/selected-run', nodeKind: 'agent-single' })
        return pending
      },
      drainFinalEvents(input) {
        expect(input).toEqual({
          runRoot: '/selected-run',
          nodeKind: 'agent-single',
          freshRun: false,
        })
        throw marker
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, scope)
    const returned = evidence.readInventory!({ nodeKind: 'agent-single' })
    expect(returned).toBe(pending)
    expect(await returned.catch((reason: unknown) => reason)).toBe(marker)
    let thrown: unknown
    try {
      evidence.drainFinalEvents!({ nodeKind: 'agent-single', freshRun: false })
    } catch (reason) {
      thrown = reason
    }
    expect(thrown).toBe(marker)
    thrown = undefined
    try {
      evidence.captureSessions({
        rootSessionId: 'r',
        nodeRunId: 'n',
        taskId: 't',
        persistence,
        log,
      })
    } catch (reason) {
      thrown = reason
    }
    expect(thrown).toBe(marker)
  })

  test('live callbacks, signal, cadence and original handle survive native fixture injection', () => {
    const signal = new AbortController().signal
    const getRootSessionId = () => 'root',
      onInsert = () => {}
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      startLiveCapture(input) {
        expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
        expect(input).toEqual({
          nodeRunId: 'n',
          taskId: 't',
          nodeId: 'node',
          getRootSessionId,
          persistence,
          pollMs: 0,
          consecutiveFailureLimit: 3,
          signal,
          onInsert,
          log,
          opencodeDbPath: '/private-live.db',
        })
        expect(input.getRootSessionId).toBe(getRootSessionId)
        expect(input.onInsert).toBe(onInsert)
        expect(input.signal).toBe(signal)
        return NOOP_HANDLE
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, {
      ...scope,
      liveLocation: () => Object.create({ opencodeDbPath: '/private-live.db' }),
    })
    expect(
      evidence.startLiveCapture!({
        nodeRunId: 'n',
        taskId: 't',
        nodeId: 'node',
        getRootSessionId,
        persistence,
        pollMs: 0,
        consecutiveFailureLimit: 3,
        signal,
        onInsert,
        log,
      }),
    ).toBe(NOOP_HANDLE)
  })

  test('the normal readonly live dedupe view retains owner updates and is forwarded unchanged after capture', async () => {
    const dedupe = new Map([['child', new Set(['original-part'])]])
    const handle = {
      stop() {},
      tickOnce: async () => 0,
      stats: () => ({
        ticks: 1,
        insertedRows: 1,
        failedTicks: 0,
        disabled: false,
        insertedPartIdsBySession: dedupe,
      }),
    }
    let received: SessionCaptureContext | undefined
    const hooks: NativeAgentMaterialEvidenceHooks = {
      startLiveCapture: () => handle,
      captureSessions: async (input) => {
        received = input
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, scope)
    const live = evidence.startLiveCapture!({
      nodeRunId: 'n',
      taskId: 't',
      nodeId: 'node',
      getRootSessionId: () => 'root',
      persistence,
      pollMs: 0,
      consecutiveFailureLimit: 3,
    })
    expect(live).toBe(handle)
    const view: ReadonlyMap<string, ReadonlySet<string>> = live.stats().insertedPartIdsBySession
    expect(view).toBe(dedupe)
    dedupe.get('child')!.add('owner-committed-part')
    expect(view.get('child')!.has('owner-committed-part')).toBe(true)
    await evidence.captureSessions({
      rootSessionId: 'root',
      nodeRunId: 'n',
      taskId: 't',
      persistence,
      log,
      alreadyInsertedPartIds: view,
    })
    expect(received?.alreadyInsertedPartIds).toBe(view)
    expect(received?.alreadyInsertedPartIds?.get('child')?.has('original-part')).toBe(true)
    expect(received?.alreadyInsertedPartIds?.get('child')?.has('owner-committed-part')).toBe(true)
  })

  test('system sink keeps original two lookups, request, callbacks and failed evidence', async () => {
    let lookups = 0
    const reason = new Error('child sweep failed')
    const failed = { failed: true, failureReason: reason },
      pending = Promise.resolve(failed)
    const sink: SystemAgentSessionSweepContext['sink'] = {
      append: async () => {},
      setRootSessionId: async () => {},
      markTerminal: async () => {},
    }
    const request = { rootSessionId: 'root', sink, log }
    const hooks: NativeAgentMaterialEvidenceHooks = {
      captureSessions: async () => {},
      get captureSessionsToSink() {
        lookups++
        return function (
          this: NativeAgentMaterialEvidenceHooks,
          input: SystemAgentSessionSweepContext,
        ) {
          expect<NativeAgentMaterialEvidenceHooks>(this).toBe(hooks)
          expect(input).toBe(request)
          expect(input.sink).toBe(sink)
          return pending
        }
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(hooks, scope)
    expect(lookups).toBe(0)
    if (evidence.captureSessionsToSink !== undefined) {
      const returned = evidence.captureSessionsToSink(request)
      expect(returned).toBe(pending)
      expect(await returned).toBe(failed)
      expect((await returned).failureReason).toBe(reason)
    }
    expect(lookups).toBe(2)
  })

  test('actual OpenCode rich inventory and final-event gates are unchanged; Claude absence stays absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc370-evidence-inventory-'))
    const previousPure = process.env.OPENCODE_PURE
    const driver = getRuntimeDriver('opencode')
    const evidence = bindNativeAgentMaterialEvidence(driver, { ...scope, runContent: () => root })
    try {
      delete process.env.OPENCODE_PURE
      writeFileSync(
        join(root, 'inventory.json'),
        JSON.stringify({
          captured: true,
          schemaVersion: 1,
          capturedAt: 1700000000,
          agents: [
            {
              name: 'auditor',
              mode: 'subagent',
              modelProviderId: 'anthropic',
              modelId: 'claude-x',
              source: 'inline',
            },
          ],
          skills: [{ name: 'lint', source: 'managed', path: '/s/lint', description: 'lints' }],
          mcps: [{ name: 'rag', type: 'local', status: 'connected', hint: null }],
          plugins: [{ specifier: 'file:///p.mjs', source: 'inline' }],
        }),
      )
      expect(await evidence.readInventory!({ nodeKind: 'agent-single' })).toEqual(
        await driver.readInventory!({ runRoot: root, nodeKind: 'agent-single' }),
      )
      const events = await evidence.drainFinalEvents!({ nodeKind: 'agent-single', freshRun: true })
      expect(events).toEqual(
        await driver.drainFinalEvents!({ runRoot: root, nodeKind: 'agent-single', freshRun: true }),
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.persist).toBe(false)
      expect(events[0]?.data?.inventory?.faces.skills?.[0]).toMatchObject({
        path: '/s/lint',
        description: 'lints',
      })
      expect(
        await evidence.drainFinalEvents!({ nodeKind: 'agent-single', freshRun: false }),
      ).toEqual([])
      expect(await evidence.drainFinalEvents!({ nodeKind: 'wrapper-git', freshRun: true })).toEqual(
        [],
      )
      process.env.OPENCODE_PURE = '1'
      expect(
        await evidence.drainFinalEvents!({ nodeKind: 'agent-single', freshRun: true }),
      ).toEqual([])
      delete process.env.OPENCODE_PURE
      writeFileSync(join(root, 'inventory.json'), '{broken')
      expect(
        await evidence.drainFinalEvents!({ nodeKind: 'agent-single', freshRun: true }),
      ).toEqual([])
      const claude = bindNativeAgentMaterialEvidence(getRuntimeDriver('claude-code'), scope)
      expect(claude.readInventory).toBeUndefined()
      expect(claude.drainFinalEvents).toBeUndefined()
      expect(claude.startLiveCapture).toBeUndefined()
      expect(claude.captureSessionsToSink).toBeUndefined()
    } finally {
      if (previousPure === undefined) delete process.env.OPENCODE_PURE
      else process.env.OPENCODE_PURE = previousPure
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('actual Claude native capture uses the selected profile and preserves resumed logical root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc370-evidence-claude-'))
    const envName = 'AW_RFC370_EVIDENCE_CLAUDE_ROOT',
      previous = process.env[envName]
    const worktree = join(root, 'worktree'),
      config = join(root, '.custom-claude')
    const subdir = join(config, 'projects', cwdSlug(worktree), 'epoch-root', 'subagents')
    mkdirSync(subdir, { recursive: true })
    writeFileSync(
      join(subdir, 'agent-evidence.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'child-evidence',
        timestamp: '2026-07-20T10:00:00.000Z',
        message: { content: [{ type: 'text', text: 'selected transcript' }] },
      }) + '\n',
    )
    const events: RuntimeSessionCaptureEvent[] = []
    const selectedPersistence: RuntimeSessionCapturePersistence = {
      ...persistence,
      async appendEvents(input) {
        expect(input.taskId).toBe('task')
        expect(input.nodeRunId).toBe('node')
        events.push(...input.events)
      },
    }
    const evidence = bindNativeAgentMaterialEvidence(getRuntimeDriver('claude-code'), {
      ...scope,
      sessionLocation: () => ({
        worktreePath: worktree,
        configDirEnv: envName,
        configDirName: '.custom-claude',
      }),
    })
    try {
      process.env[envName] = config
      await evidence.captureSessions({
        rootSessionId: 'epoch-root',
        logicalRootSessionId: 'final-root',
        nodeRunId: 'node',
        taskId: 'task',
        persistence: selectedPersistence,
        log,
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.sessionId).toBe('agent-evidence')
      expect(events[0]?.parentSessionId).toBe('final-root')
      expect(events[0]?.payload).toContain('selected transcript')
    } finally {
      if (previous === undefined) delete process.env[envName]
      else process.env[envName] = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// CI 5083d73: system preparation assigns a nullable plan before binding its
// lazy evidence scope. Type narrowing must survive that callback, while each
// actual evidence request still reads the final environment at call time.
test('system evidence reads the prepared plan lazily and preserves later environment replacement', () => {
  let plan: Pick<AgentSpawnPlan, 'env'> | null = null
  plan = { env: { SELECTED_PROFILE: 'prepared' } }
  const environments: Readonly<Record<string, string | undefined>>[] = []
  const evidence = bindNativeAgentMaterialEvidence(
    {
      captureSessions: async () => {},
      prepareUsageNormalizer(context) {
        environments.push(context.env)
        return () => ({ measurements: [], diagnostics: [] })
      },
    },
    {
      ...scope,
      environment: () => plan!.env,
    },
  )
  expect(environments).toEqual([])
  const finalEnvironment = { SELECTED_PROFILE: 'final' }
  plan.env = finalEnvironment
  evidence.prepareUsageNormalizer!()
  expect(environments).toEqual([finalEnvironment])
  expect(environments[0]).toBe(finalEnvironment)
})
