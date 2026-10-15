// RFC-370: the actual Intent and Memory algorithms must consume the selected
// System family and opaque runtime/content references on both database engines.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { buildActor, type Actor } from '@/auth/actor'
import {
  intentSessions,
  intentTurns,
  memoryDistillJobs,
  taskFeedback,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { runIntentTurn } from '@/modules/intent/application/turnEngine'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import {
  mountIntentSessionRoutes,
  type IntentSessionRouteDependencies,
} from '@/modules/intent/inbound/intentSessionRoutes'
import { rowToDistillJob, runDistill } from '@/modules/memory/application/distill/memoryDistiller'
import type {
  PreparedSystemAgentRunResult,
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '@/modules/task-execution/public/participants'
import type {
  AgentMaterialContentReference,
  SystemAgentWorkspaceScope,
} from '@/modules/runtime-management/public/participants'
import { emptySystemAgentOutputEvidence } from '@/services/systemAgentRun'
import { createUser } from '@/services/users'
import { errorHandler } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createIntentSessionForTest,
  intentDumpAuxiliaryForTest,
  intentGraphValidationForTest,
  intentPersistenceForTest,
  intentResourceCatalogBinding,
} from './helpers/intentResourceCatalogBinding'
import {
  createSqliteMemoryDistillEnqueuer,
  createSqliteMemoryDistillTestContext,
} from './helpers/memoryDistill'

const ownedHomes = new Set<string>()
function home() {
  const root = mkdtempSync(join(tmpdir(), 'aw-selected-system-callers-'))
  ownedHomes.add(root)
  return root
}
afterEach(() => {
  for (const root of ownedHomes) rmSync(root, { recursive: true, force: true })
  ownedHomes.clear()
})

const runtimeBinding: AgentMaterialContentReference = Object.freeze({
  owner: 'runtime-management',
  reference: 'remote-runtime:profile-revision-17',
  version: '17',
})

function result(eventText: string): PreparedSystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText,
    stderrTail: '',
    durationMs: 1,
    retainedRef: 'remote-retained:invocation-result',
    scratchRetained: true,
    capturedSessionId: 'remote-session:conversation-4',
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

function selectedFamily(
  run: (request: SystemAgentRunRequest) => Promise<PreparedSystemAgentRunResult>,
) {
  const calls: SystemAgentRunRequest[] = []
  const releases: Parameters<SystemAgentRunFamily['retainedContents']['release']>[0][] = []
  const scopes = new Set<SystemAgentWorkspaceScope>()
  const family = Object.freeze<SystemAgentRunFamily>({
    workspaces: {
      capture(input) {
        const scope = Object.freeze({ namespace: input.namespace, name: input.name })
        scopes.add(scope)
        return scope
      },
      withName(scope, name) {
        expect(scopes.has(scope)).toBe(true)
        const named = Object.freeze({ namespace: scope.namespace, name })
        scopes.add(named)
        return named
      },
    },
    async run(request) {
      expect(this).toBe(family)
      expect(request.runtimeBinding).toBe(runtimeBinding)
      expect(scopes.has(request.workspaceScope)).toBe(true)
      for (const key of [
        'runtimeBinary',
        'binaryPath',
        'scratchDir',
        'scratchParent',
        'cmd',
        'env',
      ])
        expect(Object.hasOwn(request, key)).toBe(false)
      calls.push(request)
      return await run(request)
    },
    retainedContents: {
      forget() {},
      release(request) {
        expect(scopes.has(request.scope)).toBe(true)
        releases.push(request)
        return { removed: true }
      },
    },
  })
  return { family, calls, releases }
}

describeEachProvider('RFC-370 selected System family through actual callers', (harness) => {
  test('Intent settles questions and releases the selected retained reference', async () => {
    const root = home(),
      id = ulid()
    const now = Date.now()
    await harness.db.insert(users).values({
      id,
      username: 'system-family-' + id.toLowerCase(),
      displayName: 'System family',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    const actor: Actor = {
      user: {
        id,
        username: 'system-family-' + id.toLowerCase(),
        displayName: 'System family',
        role: 'user',
        status: 'active',
      },
      source: 'session',
      permissions: new Set(),
    }
    const { session } = await createIntentSessionForTest(
      harness.db,
      actor,
      { message: 'Ask which workflow is needed' },
      root,
    )
    const selected = selectedFamily(async (request) => {
      const nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1]
      expect(nonce).toBeString()
      return result(
        `<workflow-output nonce="${nonce}"><port name="summary">Need a workflow choice</port><port name="questions">[{"id":"q1","question":"Which workflow?","options":["Audit","Build"],"multiSelect":false}]</port></workflow-output>`,
      )
    })
    const outcome = await runIntentTurn(
      {
        persistence: intentPersistenceForTest(harness.db),
        appHome: root,
        resourceCatalog: intentResourceCatalogBinding(harness.db, actor, root),
        dumpAuxiliary: intentDumpAuxiliaryForTest(harness.db),
        graphValidation: intentGraphValidationForTest(harness.db),
        systemAgents: selected.family,
        config: {
          runtime: {
            name: 'remote',
            protocol: 'opencode',
            runtimeBinding,
            model: null,
            variant: null,
            temperature: null,
            steps: null,
            maxSteps: null,
            isSandbox: false,
            extraArgs: null,
            configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
          },
          lang: null,
          timeoutMs: 30_000,
          stdoutCapBytes: 8 * 1024 * 1024,
          maxGenerateRounds: 50,
          maxQuestionRounds: 5,
          extraInstructions: null,
        },
      },
      { sessionId: session.id, actor },
    )
    expect(outcome.kind).toBe('questions')
    expect(selected.calls).toHaveLength(1)
    expect(selected.calls[0]?.workspaceScope).toMatchObject({
      namespace: 'intent',
      name: outcome.turnId,
    })
    expect(selected.releases).toEqual([
      {
        retainedRef: 'remote-retained:invocation-result',
        scope: { namespace: 'intent', name: outcome.turnId },
      },
    ])
    const turn = (
      await harness.db.select().from(intentTurns).where(eq(intentTurns.id, outcome.turnId))
    )[0]
    const fresh = (
      await harness.db.select().from(intentSessions).where(eq(intentSessions.id, session.id))
    )[0]
    expect(turn).toMatchObject({ kind: 'questions', captureState: 'complete' })
    expect(fresh).toMatchObject({ inFlightTurnId: null })
    expect(JSON.parse(fresh?.budgetJson ?? '{}').questionRounds).toBe(1)
  })

  test('HTTP Intent forwards a prototype family getter once and settles through the selected adapter', async () => {
    const root = home()
    const user = await createUser(harness.db, {
      username: 'system-http-' + ulid().toLowerCase(),
      displayName: 'System HTTP family',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const actor = buildActor({ user, source: 'session' })
    const identityAccess = createIdentityAccessRuntime({ db: harness.db })
    const selected = selectedFamily(async (request) => {
      const nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1]
      expect(nonce).toBeString()
      return result(
        `<workflow-output nonce="${nonce}"><port name="summary">Need a workflow choice</port><port name="questions">[{"id":"q1","question":"Which workflow?","options":["Audit","Build"],"multiSelect":false}]</port></workflow-output>`,
      )
    })
    type RouteRuntimeInputs = IntentSessionRouteDependencies['intentTurnRuntime']
    let familyReads = 0
    class RouteRuntime implements RouteRuntimeInputs {
      #family = selected.family
      readonly runtimeResolver: RouteRuntimeInputs['runtimeResolver'] = {
        async resolve() {
          return {
            runtime: {
              name: 'remote',
              protocol: 'opencode',
              runtimeBinding,
              model: null,
              variant: null,
              temperature: null,
              steps: null,
              maxSteps: null,
              isSandbox: false,
              extraArgs: null,
              configDir: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
            },
            effectiveDefaultRuntime: { name: 'remote', protocol: 'opencode' },
          }
        },
      }
      readonly dumpAuxiliary = intentDumpAuxiliaryForTest(harness.db)
      readonly graphValidation = intentGraphValidationForTest(harness.db)
      get systemAgents() {
        familyReads += 1
        expect<RouteRuntime>(this).toBe(runtimeInputs)
        return this.#family
      }
    }
    const runtimeInputs = new RouteRuntime()
    expect(Object.hasOwn(runtimeInputs, 'systemAgents')).toBe(false)

    // Wait for the real dispatcher's final persistence operation before the
    // provider harness resets its database. This forwards the actual query.
    const persistence = intentPersistenceForTest(harness.db)
    const activateWorkingSetChange = persistence.activateWorkingSetChange.bind(persistence)
    let drainCompleted = false
    let markDrained!: () => void
    const drained = new Promise<void>((resolve) => {
      markDrained = resolve
    })
    // Keep the complete class instance, including its prototype methods and
    // private receiver. Only this test instance gains a completion observer.
    persistence.activateWorkingSetChange = async (input) => {
      try {
        const outcome = await activateWorkingSetChange(input)
        drainCompleted = true
        return outcome
      } finally {
        markDrained()
      }
    }
    let finishedTurnId = ''
    const http = new Hono()
    const injectActor: MiddlewareHandler = async (context, next) => {
      context.set('actor', actor)
      await next()
    }
    http.use('*', injectActor)
    http.onError(errorHandler)
    mountIntentSessionRoutes(http, {
      appHome: root,
      configuration: { read: () => structuredClone(DEFAULT_CONFIG) },
      identityAccess,
      directAuthority: identityAccess.directAuthority,
      intentPersistence: persistence,
      intentApply: {
        async apply() {
          throw new Error('questions must not commit resources')
        },
      },
      intentTurnRuntime: runtimeInputs,
      resourceCatalogFor: (currentActor) =>
        intentResourceCatalogBinding(harness.db, currentActor, root),
      events: {
        publish(event) {
          if (event.type === 'intent.turn.finished') finishedTurnId = event.turnId
        },
      },
    })
    const response = await http.request('/api/intent-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Ask which workflow is needed' }),
    })
    expect(response.status).toBe(201)
    await drained
    expect<boolean>(drainCompleted).toBe(true)
    expect(finishedTurnId).not.toBe('')
    expect(familyReads).toBe(1)
    expect(selected.calls).toHaveLength(1)
    expect(selected.calls[0]?.workspaceScope).toMatchObject({
      namespace: 'intent',
      name: finishedTurnId,
    })
    expect(selected.releases).toEqual([
      {
        retainedRef: 'remote-retained:invocation-result',
        scope: { namespace: 'intent', name: finishedTurnId },
      },
    ])
    const turn = (
      await harness.db.select().from(intentTurns).where(eq(intentTurns.id, finishedTurnId))
    )[0]
    if (turn === undefined) throw new Error('HTTP dispatch did not persist its turn')
    const fresh = (
      await harness.db.select().from(intentSessions).where(eq(intentSessions.id, turn.sessionId))
    )[0]
    expect(turn).toMatchObject({ kind: 'questions', captureState: 'complete' })
    expect(fresh).toMatchObject({ inFlightTurnId: null })
    expect(JSON.parse(fresh?.budgetJson ?? '{}').questionRounds).toBe(1)
  })

  test('Memory follows up in one selected scope/session and releases once after persistence', async () => {
    const root = home(),
      taskId = ulid(),
      workflowId = ulid(),
      feedbackId = ulid()
    await harness.db
      .insert(workflows)
      .values({ id: workflowId, name: 'Selected memory', definition: '{"nodes":[],"edges":[]}' })
    await harness.db.insert(tasks).values({
      id: taskId,
      name: 'Selected memory task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: root,
      worktreePath: root,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await harness.db.insert(taskFeedback).values({
      id: feedbackId,
      taskId,
      authorUserId: null,
      bodyMd: 'Use one selected conversation for the whole distillation',
      createdAt: Date.now(),
      distilled: 1,
    })
    const enqueuer = createSqliteMemoryDistillEnqueuer(harness.db)
    await enqueuer.enqueue({ taskId, sourceKind: 'feedback', sourceEventId: feedbackId })
    const row = (
      await harness.db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.taskId, taskId))
    )[0]
    if (row === undefined) throw new Error('distill fixture did not enqueue')
    const job = rowToDistillJob(row),
      context = createSqliteMemoryDistillTestContext(harness.db, root)
    let nonce = '',
      round = 0
    const selected = selectedFamily(async (request) => {
      if (round++ === 0) {
        nonce = /nonce="([^"]+)"/.exec(request.prompt)?.[1] ?? ''
        expect(nonce).not.toBe('')
        return result('First response omitted the envelope')
      }
      return result(
        `<workflow-output nonce="${nonce}"><port name="candidates">{"candidates":[]}</port></workflow-output>`,
      )
    })
    const outcome = await runDistill({
      store: context.store,
      nodeRunPrompts: context.nodeRunPrompts,
      reviewedArtifacts: context.reviewedArtifacts,
      job,
      siblings: [job],
      systemAgents: selected.family,
      runtimeBinding,
      protocol: 'opencode',
      timeoutMs: 30_000,
    })
    expect(outcome).toEqual({ candidatesCreated: 0, createdMemoryIds: [] })
    expect(selected.calls).toHaveLength(2)
    const firstCall = selected.calls[0]
    if (firstCall === undefined) throw new Error('first selected distill round missing')
    expect(selected.calls[1]?.workspaceScope).toBe(firstCall.workspaceScope)
    expect(selected.calls[1]?.resumeSessionId).toBe('remote-session:conversation-4')
    expect(selected.calls[1]?.timeoutMs).toBeLessThanOrEqual(selected.calls[0]?.timeoutMs ?? 0)
    expect(selected.calls[1]?.timeoutMs).toBeGreaterThan(0)
    expect(selected.releases).toEqual([
      {
        retainedRef: 'remote-retained:invocation-result',
        scope: firstCall.workspaceScope,
      },
    ])
  })
})
