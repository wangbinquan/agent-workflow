// RFC-328 code-host effect contract: every real mutation send owns one durable
// attempt, existing transport retries remain live, and earlier ambiguity is
// retained unless a later applied response resolves the logical operation.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionLineageOperationRecords,
  tasks,
} from '@/db/schema'
import { createTaskExecutionTestModule } from '@/modules/task-execution/composition'
import { createTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { createCodeHostEffectAttemptObserver } from '@/modules/task-execution/application/codeHostEffectObserver'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import { canonicalJson, type LineageSlot } from '@/modules/task-execution/domain/executionIntent'
import { executeCodeHostCall } from '@/services/codeHost/call'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import {
  CODE_HOST_ACTIONS,
  type CodeHostAction,
  type CodeHostProvider,
} from '@agent-workflow/shared'
import {
  buildCodeHostRecoveryDescriptor,
  buildCodeHostRecoveryBindingManifest,
  classifyCodeHostProbeResponse,
  validateCodeHostRecoveryBindingManifest,
} from '@/modules/task-execution/domain/codeHostRecovery'
import { createVerifiedOutcomeUnknownClosure } from '@/modules/task-execution/domain/ownership'
import { submitTaskContinuationTx } from '@/modules/task-execution/application/submitTaskContinuation'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function fixture(
  taskId: string,
  action: CodeHostAction = 'custom',
  provider: CodeHostProvider = 'gitlab',
) {
  const db = createInMemoryDb(MIGRATIONS)
  const slotPath: readonly LineageSlot[] = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  db.insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: 'workflow-rfc328-codehost',
      workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
      workflowVersion: 1,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: canonicalJson(slotPath),
    })
    .run()
  const module = createTaskExecutionTestModule(`daemon-${taskId}`)
  const intent = module.intents.submit({
    db,
    intentId: `intent-${taskId}`,
    request: {
      taskId,
      kind: 'launch',
      source: 'rest',
      actorUserId: 'actor-1',
      expectedTaskRevision: 1,
      scope: {
        executionLineageId: taskId,
        continuationSlotKey: `${taskId}:root`,
        slotPath,
        operationGeneration: 0,
      },
      payload: { v: 1 },
    },
  })
  const claim = module.claim({ db, intentId: intent.intentId })
  module.claimGate.leave(claim.permit)
  const context = createTaskExecutionContext({
    intentId: intent.intentId,
    token: claim.token,
    db,
  })
  const family = operationFamilyKey({
    executionLineageId: taskId,
    slotPath,
    effectKind: 'code-host-mutation',
    stableActionOrdinal: `${action}:0`,
  })
  const identity = {
    executionLineageId: taskId,
    operationFamilyKey: family,
    operationGeneration: 0,
    operationKey: `${taskId}:${action}`,
    requestHash: requestHash({ provider, action, fixture: taskId }),
    slotPathJson: canonicalJson(slotPath),
    slotPathDigest: requestHash(canonicalJson(slotPath)),
    resourceKeys: [`code-host:${provider}:${taskId}`],
  } as const
  const observer = createCodeHostEffectAttemptObserver({
    db,
    context,
    action,
    identity,
  })
  return { db, observer, module, taskId, family, slotPath, identity, context, provider, action }
}

function deps(
  observer: ReturnType<typeof createCodeHostEffectAttemptObserver>,
  fetchImpl: (url: string, init?: BunFetchRequestInit) => Promise<Response>,
  provider: CodeHostProvider = 'gitlab',
) {
  return {
    connection: {
      provider,
      baseUrl:
        provider === 'gitlab' ? 'https://gitlab.example/api/v4' : 'https://api.github.example',
      repositoryUrlPrefixes: [],
      token: 'aw-rfc328-fixture-token', // gitleaks:allow
      rejectUnauthorized: true,
    },
    ctx: { ports: {}, triggerContext: null },
    projectFallback: { ok: true as const, value: 'group%2Frepo' },
    sleep: async () => {},
    fetchImpl,
    attemptObserver: observer,
  }
}

function response(status: number): Response {
  return new Response('{"ok":true}', {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface ApproveRemoteState {
  head: string
  approved: boolean
  approvalReset: boolean
  reviewDismissed: boolean
}

async function approveResponseLossDriftFixture(input: {
  taskId: string
  provider: CodeHostProvider
  drift: (state: ApproveRemoteState) => void
}): Promise<{ state: ApproveRemoteState; sends: number }> {
  const h = fixture(input.taskId, 'mr.approve', input.provider)
  const state: ApproveRemoteState = {
    head: 'head-before-approve',
    approved: false,
    approvalReset: false,
    reviewDismissed: false,
  }
  let sends = 0
  let requestBody: unknown = null
  const outcome = await executeCodeHostCall(
    {
      provider: input.provider,
      action: 'mr.approve',
      params: {
        project: input.provider === 'gitlab' ? 'group/repo' : 'owner/repo',
        mr: '17',
      },
    },
    deps(
      h.observer,
      async (_url, init) => {
        sends += 1
        expect(init?.method).toBe('POST')
        if (typeof init?.body === 'string' && init.body.length > 0) {
          requestBody = JSON.parse(init.body)
        }
        // The fake provider commits the approval, then loses the response.
        state.approved = true
        throw new Error('approve-response-lost-after-provider-commit')
      },
      input.provider,
    ),
  )
  expect(outcome.ok).toBe(false)
  expect(sends).toBe(1)
  expect(requestBody ?? {}).not.toHaveProperty('sha')
  expect(requestBody ?? {}).not.toHaveProperty('commit_id')
  expect(state.approved).toBe(true)

  // Drift happens strictly after the original request. Its current projection
  // cannot prove whether that exact old request applied.
  input.drift(state)
  expect(h.observer.outcomeUnknown()).toBe(true)
  expect(h.observer.settleTerminal(() => {})).toBe(true)

  const unresolved = h.db.select({ id: taskExecutionEffects.id }).from(taskExecutionEffects).get()!
  const owner = h.module.ownership.read(h.db, h.taskId)!
  h.module.effects.closeOutcomeUnknownAndRelease({
    db: h.db,
    token: h.context.token,
    intentId: `intent-${h.taskId}`,
    proof: createVerifiedOutcomeUnknownClosure({
      taskId: h.taskId,
      ownerRevision: owner.revision,
      epoch: owner.epoch,
      quiescenceDigest: `approve-drift-${input.taskId}`,
      unresolvedEffectIds: [unresolved.id],
      verifiedAt: 20,
    }),
    now: 20,
  })
  expect(
    h.db
      .select({ state: taskExecutionLineageOperationRecords.decisionState })
      .from(taskExecutionLineageOperationRecords)
      .where(eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'))
      .get()?.state,
  ).toBe('requires-actor')
  expect(sends).toBe(1) // actorless closure/recovery performs no second approval send.
  return { state, sends }
}

describe('RFC-328 code-host per-send attempt ledger', () => {
  test('all registry actions/providers/candidates have an exact recovery and transport profile', () => {
    const manifest = buildCodeHostRecoveryBindingManifest()
    expect(validateCodeHostRecoveryBindingManifest(manifest)).toEqual([])
    expect([...new Set(manifest.map((entry) => entry.action))].sort()).toEqual(
      [...CODE_HOST_ACTIONS].sort(),
    )
    expect(manifest.filter((entry) => entry.supported).length).toBeGreaterThan(50)
    expect(manifest.filter((entry) => !entry.supported).length).toBeGreaterThan(0)
    expect(manifest.filter((entry) => entry.action === 'custom')).toHaveLength(10)
    expect(
      manifest
        .filter((entry) => entry.action === 'mr.approve')
        .every((entry) => entry.recoveryClass === 'R-ACTOR'),
    ).toBe(true)

    const missing = structuredClone(manifest).slice(1)
    expect(validateCodeHostRecoveryBindingManifest(missing)).toContain(
      `missing code-host recovery binding '${manifest[0]!.id}'`,
    )
    const weakened = manifest.map((entry) =>
      entry.action === 'mr.approve' && entry.provider === 'gitlab'
        ? { ...entry, recoveryClass: 'R-STATE' as const }
        : entry,
    )
    const approve = weakened.find(
      (entry) => entry.action === 'mr.approve' && entry.provider === 'gitlab',
    )!
    expect(validateCodeHostRecoveryBindingManifest(weakened)).toContain(
      `mr.approve must remain actor-replay for ${approve.provider}`,
    )

    const githubDefaultStatus = buildCodeHostRecoveryDescriptor({
      provider: 'github',
      action: 'commit-status.set',
      candidateId: 'commit-status.set:c0',
      method: 'POST',
      pathname: '/repos/owner/repo/statuses/deadbeef',
      query: {},
      body: { state: 'success' },
      baseUrl: 'https://api.github.example',
    })
    expect(githubDefaultStatus.probe).toMatchObject({
      kind: 'commit-status-projection',
      pathname: '/repos/owner/repo/commits/deadbeef/statuses',
    })
    expect(
      classifyCodeHostProbeResponse({
        descriptor: githubDefaultStatus,
        status: 200,
        body: JSON.stringify([
          {
            state: 'success',
            context: 'default',
            description: null,
            target_url: null,
          },
        ]),
      }),
    ).toMatchObject({ kind: 'applied', proofCode: 'effective-commit-status-matched' })
  })

  test('deterministic postcondition mismatches keep convergent and run-retry capability', () => {
    const runRetry = buildCodeHostRecoveryDescriptor({
      provider: 'github',
      action: 'pipeline.retry',
      candidateId: 'pipeline.retry:c0',
      method: 'POST',
      pathname: '/repos/owner/repo/actions/runs/7/rerun-failed-jobs',
      query: {},
      baseUrl: 'https://api.github.example',
      preMutationResponse: { status: 200, body: '{"run_attempt":2}' },
    })
    expect(
      classifyCodeHostProbeResponse({
        descriptor: runRetry,
        status: 200,
        body: '{"run_attempt":2}',
      }).kind,
    ).toBe('definitely-not-applied')
    expect(
      classifyCodeHostProbeResponse({
        descriptor: runRetry,
        status: 200,
        body: '{"run_attempt":3}',
      }).kind,
    ).toBe('applied')

    const merge = buildCodeHostRecoveryDescriptor({
      provider: 'github',
      action: 'mr.merge',
      candidateId: 'mr.merge:c0',
      method: 'PUT',
      pathname: '/repos/owner/repo/pulls/17/merge',
      query: {},
      body: {},
      baseUrl: 'https://api.github.example',
      preMutationResponse: {
        status: 200,
        body: '{"head":{"sha":"head-a"}}',
      },
    })
    expect(
      classifyCodeHostProbeResponse({
        descriptor: merge,
        status: 200,
        body: '{"merged":false,"head":{"sha":"head-a"}}',
      }).kind,
    ).toBe('definitely-not-applied')
    expect(
      classifyCodeHostProbeResponse({
        descriptor: merge,
        status: 200,
        body: '{"merged":false,"head":{"sha":"head-b"}}',
      }).kind,
    ).toBe('unknown')

    const label = buildCodeHostRecoveryDescriptor({
      provider: 'github',
      action: 'label.add',
      candidateId: 'label.add:c0',
      method: 'POST',
      pathname: '/repos/owner/repo/issues/17/labels',
      query: {},
      body: { labels: ['bug'] },
      baseUrl: 'https://api.github.example',
    })
    expect(classifyCodeHostProbeResponse({ descriptor: label, status: 200, body: '[]' }).kind).toBe(
      'definitely-not-applied',
    )
  })

  test('ambiguous mr.approve pauses actorless replay but the existing manual command runs generation N+1', async () => {
    const h = fixture('task-approve-manual', 'mr.approve', 'gitlab')
    let ambiguousSends = 0
    const ambiguous = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'mr.approve',
        params: { project: 'group/repo', mr: '7' },
      },
      deps(
        h.observer,
        async () => {
          ambiguousSends += 1
          throw new Error('approve-response-lost-after-apply')
        },
        'gitlab',
      ),
    )
    expect(ambiguous.ok).toBe(false)
    expect(ambiguousSends).toBe(1) // POST keeps the existing no-network-retry contract.
    expect(h.observer.outcomeUnknown()).toBe(true)
    expect(h.observer.settleTerminal(() => {})).toBe(true)

    const unresolved = h.db
      .select({ id: taskExecutionEffects.id })
      .from(taskExecutionEffects)
      .get()!
    const owner = h.module.ownership.read(h.db, h.taskId)!
    h.module.effects.closeOutcomeUnknownAndRelease({
      db: h.db,
      token: h.context.token,
      intentId: `intent-${h.taskId}`,
      proof: createVerifiedOutcomeUnknownClosure({
        taskId: h.taskId,
        ownerRevision: owner.revision,
        epoch: owner.epoch,
        quiescenceDigest: 'approve-runtime-and-sibling-quiescence',
        unresolvedEffectIds: [unresolved.id],
        verifiedAt: 20,
      }),
      now: 20,
    })
    expect(
      h.db
        .select({ state: taskExecutionLineageOperationRecords.decisionState })
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'))
        .get()?.state,
    ).toBe('requires-actor')

    const manualIntentId = 'intent-approve-manual-generation-1'
    dbTxSync(h.db, (tx) =>
      submitTaskContinuationTx(tx, {
        taskId: h.taskId,
        intentId: manualIntentId,
        kind: 'resume',
        source: 'mcp',
        actorUserId: 'actor-2',
        payload: { v: 1 },
        now: 21,
        advanceOperationGeneration: true,
      }),
    )
    const claim = h.module.claim({ db: h.db, intentId: manualIntentId })
    h.module.claimGate.leave(claim.permit)
    const nextObserver = createCodeHostEffectAttemptObserver({
      db: h.db,
      context: createTaskExecutionContext({
        db: h.db,
        intentId: manualIntentId,
        token: claim.token,
      }),
      action: 'mr.approve',
      identity: { ...h.identity, operationGeneration: 1 },
    })
    let manualSends = 0
    const applied = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'mr.approve',
        params: { project: 'group/repo', mr: '7' },
      },
      deps(
        nextObserver,
        async () => {
          manualSends += 1
          return response(201)
        },
        'gitlab',
      ),
    )
    expect(applied.ok).toBe(true)
    expect(manualSends).toBe(1)
    expect(nextObserver.settleTerminal(() => {})).toBe(true)
    expect(
      h.db
        .select({ state: taskExecutionLineageOperationRecords.decisionState })
        .from(taskExecutionLineageOperationRecords)
        .where(eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'))
        .get()?.state,
    ).toBe('consumed')
    expect(
      h.db
        .select({ generation: taskExecutionEffects.operationGeneration })
        .from(taskExecutionEffects)
        .all()
        .map((row) => row.generation)
        .sort(),
    ).toEqual([0, 1])
  })

  test('mr.approve response loss followed by HEAD advance stays actor-replay', async () => {
    const result = await approveResponseLossDriftFixture({
      taskId: 'task-approve-head-advance',
      provider: 'gitlab',
      drift: (state) => {
        state.head = 'head-after-approve'
      },
    })
    expect(result.state).toMatchObject({
      head: 'head-after-approve',
      approved: true,
      approvalReset: false,
      reviewDismissed: false,
    })
  })

  test('GitLab approval reset after response loss cannot disprove the old approval', async () => {
    const result = await approveResponseLossDriftFixture({
      taskId: 'task-approve-gitlab-reset',
      provider: 'gitlab',
      drift: (state) => {
        state.approved = false
        state.approvalReset = true
      },
    })
    expect(result.state).toMatchObject({ approved: false, approvalReset: true })
  })

  test('GitHub review dismissal after response loss cannot disprove the old approval', async () => {
    const result = await approveResponseLossDriftFixture({
      taskId: 'task-approve-github-dismissal',
      provider: 'github',
      drift: (state) => {
        state.approved = false
        state.reviewDismissed = true
      },
    })
    expect(result.state).toMatchObject({ approved: false, reviewDismissed: true })
  })

  test('mr.approve keeps the existing 429 retry and normal success path', async () => {
    const h = fixture('task-approve-429', 'mr.approve', 'github')
    let sends = 0
    const outcome = await executeCodeHostCall(
      {
        provider: 'github',
        action: 'mr.approve',
        params: { project: 'owner/repo', mr: '11' },
      },
      deps(
        h.observer,
        async () => {
          sends += 1
          return sends === 1 ? response(429) : response(200)
        },
        'github',
      ),
    )
    expect(outcome.ok).toBe(true)
    expect(sends).toBe(2)
    expect(h.observer.settleTerminal(() => {})).toBe(true)
  })

  test('a response-lost pipeline cancel is adopted after one read-only state probe', async () => {
    const h = fixture('task-pipeline-cancel-probe', 'pipeline.cancel', 'gitlab')
    let mutationSends = 0
    let pipelineStatus = 'running'
    const callDeps = deps(
      h.observer,
      async (_url, init) => {
        expect(init?.method).toBe('POST')
        mutationSends += 1
        pipelineStatus = 'canceled'
        throw new Error('cancel-response-lost-after-provider-commit')
      },
      'gitlab',
    )
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'pipeline.cancel',
        params: { project: 'group/repo', pipeline: '31' },
      },
      callDeps,
    )
    expect(outcome.ok).toBe(false)
    expect(mutationSends).toBe(1)

    const descriptor = h.observer.terminalRecoveryDescriptor()
    expect(descriptor?.probe.kind).toBe('pipeline-terminal-state')
    let probeReads = 0
    const probe = await probeCodeHostMutation({
      descriptor: descriptor!,
      resolveConnection: () => callDeps.connection,
      fetchImpl: async (url, init) => {
        expect(init?.method).toBe('GET')
        expect(url).toBe('https://gitlab.example/api/v4/projects/group%2Frepo/pipelines/31')
        probeReads += 1
        return new Response(JSON.stringify({ status: pipelineStatus }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    expect(probe).toMatchObject({ kind: 'applied', proofCode: 'pipeline-canceled' })
    expect(h.observer.resolveTerminalProbe(probe)).toBe('applied')
    expect(
      h.observer.settleTerminal((tx) => {
        tx.update(tasks)
          .set({ errorSummary: 'pipeline-cancel-projected' })
          .where(eq(tasks.id, h.taskId))
          .run()
      }),
    ).toBe(true)
    expect(probeReads).toBe(1)
    expect(h.db.select().from(taskExecutionEffects).get()?.state).toBe('succeeded')
    expect(h.db.select().from(taskExecutionEffectAttempts).all()).toMatchObject([
      { state: 'succeeded', applicationEvidence: 'applied' },
    ])
  })

  test('a still-existing draft authorizes one same-generation delete retry', async () => {
    const h = fixture('task-draft-delete-probe', 'review.draft-discard', 'gitlab')
    let draftExists = true
    let mutationSends = 0
    const firstDeps = deps(
      h.observer,
      async (_url, init) => {
        expect(init?.method).toBe('DELETE')
        mutationSends += 1
        throw new Error('delete-request-did-not-reach-provider')
      },
      'gitlab',
    )
    const first = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'review.draft-discard',
        params: { project: 'group/repo', mr: '9', draft: '73' },
      },
      firstDeps,
    )
    expect(first.ok).toBe(false)
    expect(mutationSends).toBe(3) // Existing DELETE transport retry policy is unchanged.

    const descriptor = h.observer.terminalRecoveryDescriptor()
    expect(descriptor?.probe.kind).toBe('draft-existence-partial')
    const probe = await probeCodeHostMutation({
      descriptor: descriptor!,
      resolveConnection: () => firstDeps.connection,
      fetchImpl: async (_url, init) => {
        expect(init?.method).toBe('GET')
        return new Response(draftExists ? '{"id":73}' : '{}', {
          status: draftExists ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    expect(probe).toMatchObject({
      kind: 'definitely-not-applied',
      proofCode: 'exact-draft-still-exists',
    })
    expect(h.observer.resolveTerminalProbe(probe)).toBe('retry-authorized')

    const retried = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'review.draft-discard',
        params: { project: 'group/repo', mr: '9', draft: '73' },
      },
      deps(
        h.observer,
        async (_url, init) => {
          expect(init?.method).toBe('DELETE')
          mutationSends += 1
          draftExists = false
          return new Response(null, { status: 204 })
        },
        'gitlab',
      ),
    )
    expect(retried.ok).toBe(true)
    expect(h.observer.settleTerminal(() => {})).toBe(true)
    expect(mutationSends).toBe(4)
    expect(draftExists).toBe(false)
    expect(
      h.db
        .select({
          state: taskExecutionEffectAttempts.state,
          evidence: taskExecutionEffectAttempts.applicationEvidence,
        })
        .from(taskExecutionEffectAttempts)
        .orderBy(taskExecutionEffectAttempts.attemptNo)
        .all(),
    ).toEqual([
      { state: 'retry-authorized', evidence: 'ambiguous' },
      { state: 'retry-authorized', evidence: 'ambiguous' },
      { state: 'retry-authorized', evidence: 'definitely-not-applied' },
      { state: 'succeeded', evidence: 'applied' },
    ])
    expect(
      h.db
        .select({ generation: taskExecutionEffects.operationGeneration })
        .from(taskExecutionEffects)
        .all(),
    ).toEqual([{ generation: 0 }])
  })

  test('custom GET/PUT/PATCH/DELETE network, 5xx and every-method 429 retry stay unchanged', async () => {
    const methods = ['GET', 'PUT', 'PATCH', 'DELETE'] as const
    for (const method of methods) {
      const h = fixture(`task-custom-transport-${method.toLowerCase()}`)
      let sends = 0
      const outcome = await executeCodeHostCall(
        {
          provider: 'gitlab',
          action: 'custom',
          params: {},
          request: { method, path: '/probe' },
          allowDestructive: method === 'DELETE',
        },
        deps(h.observer, async () => {
          sends += 1
          if (sends === 1) throw new Error('network-before-response')
          return sends === 2 ? response(503) : response(200)
        }),
      )
      expect(outcome.ok, method).toBe(true)
      expect(sends, method).toBe(3)
      expect(
        h.observer.settleTerminal(() => {}),
        method,
      ).toBe(method !== 'GET')
    }

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const h = fixture(`task-custom-429-${method.toLowerCase()}`)
      let sends = 0
      const outcome = await executeCodeHostCall(
        {
          provider: 'gitlab',
          action: 'custom',
          params: {},
          request: { method, path: '/probe' },
          allowDestructive: method === 'DELETE',
        },
        deps(h.observer, async () => {
          sends += 1
          return sends === 1 ? response(429) : response(200)
        }),
      )
      expect(outcome.ok, method).toBe(true)
      expect(sends, method).toBe(2)
      expect(
        h.observer.settleTerminal(() => {}),
        method,
      ).toBe(method !== 'GET')
    }
  })

  test('custom PUT keeps the network retry and later applied result with prior ambiguity audit', async () => {
    const h = fixture('task-codehost-success')
    let sends = 0
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'custom',
        params: {},
        request: { method: 'PUT', path: '/probe' },
      },
      deps(h.observer, async () => {
        sends += 1
        if (sends === 1) throw new Error('response-lost-after-send')
        return response(200)
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(sends).toBe(2)
    expect(h.observer.outcomeUnknown()).toBe(false)
    expect(
      h.observer.settleTerminal((tx) => {
        tx.update(tasks).set({ errorSummary: 'projected' }).where(eq(tasks.id, h.taskId)).run()
      }),
    ).toBe(true)

    const attempts = h.db
      .select({ state: taskExecutionEffectAttempts.state })
      .from(taskExecutionEffectAttempts)
      .orderBy(taskExecutionEffectAttempts.attemptNo)
      .all()
    expect(attempts).toEqual([{ state: 'retry-authorized' }, { state: 'succeeded' }])
    const effect = h.db.select().from(taskExecutionEffects).get()!
    expect(effect.state).toBe('succeeded')
    expect(JSON.parse(effect.receiptJson ?? '{}')).toMatchObject({ priorAmbiguityCount: 1 })
    expect(
      h.db
        .select({ generation: taskExecutionLineageOperationRecords.highestSettledGeneration })
        .from(taskExecutionLineageOperationRecords)
        .get()?.generation,
    ).toBe(0)
  })

  test('later definite failure cannot erase the first ambiguous send', async () => {
    const h = fixture('task-codehost-unknown')
    let sends = 0
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'custom',
        params: {},
        request: { method: 'PUT', path: '/probe' },
      },
      deps(h.observer, async () => {
        sends += 1
        if (sends === 1) throw new Error('response-lost-after-send')
        return response(400)
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(sends).toBe(2)
    expect(h.observer.outcomeUnknown()).toBe(true)
    expect(h.observer.settleTerminal(() => {})).toBe(true)
    expect(
      h.db
        .select({ state: taskExecutionEffectAttempts.state })
        .from(taskExecutionEffectAttempts)
        .orderBy(taskExecutionEffectAttempts.attemptNo)
        .all(),
    ).toEqual([{ state: 'retry-authorized' }, { state: 'recovery-required' }])
    expect(
      h.db.select({ state: taskExecutionEffects.state }).from(taskExecutionEffects).get()?.state,
    ).toBe('open')
  })

  test('POST still retries 429, records both sends, and performs no new 5xx/network retry', async () => {
    const h = fixture('task-codehost-post')
    let sends = 0
    const outcome = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'custom',
        params: {},
        request: { method: 'POST', path: '/probe' },
      },
      deps(h.observer, async () => {
        sends += 1
        return sends === 1 ? response(429) : response(201)
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(sends).toBe(2)
    expect(h.observer.settleTerminal(() => {})).toBe(true)
    expect(h.db.select().from(taskExecutionEffectAttempts).all()).toHaveLength(2)

    const network = fixture('task-codehost-post-network')
    let networkSends = 0
    const failed = await executeCodeHostCall(
      {
        provider: 'gitlab',
        action: 'custom',
        params: {},
        request: { method: 'POST', path: '/probe' },
      },
      deps(network.observer, async () => {
        networkSends += 1
        throw new Error('post-response-lost')
      }),
    )
    expect(failed.ok).toBe(false)
    expect(networkSends).toBe(1)
    expect(network.observer.outcomeUnknown()).toBe(true)
    expect(network.observer.settleTerminal(() => {})).toBe(true)
  })
})
