// RFC-310 PR-11/12 — executable business-control-flow regressions.
//
// The employee definition, not array fall-through or an Agent, owns the next
// step. These cases lock exact success/failure branches, durable joins, problem
// producer fallback, problem priority and configured verification.

import { describe, expect, test } from 'bun:test'

import {
  buildFactSnapshot,
  type FactCellValue,
} from '../src/modules/development-automation/domain/facts'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import type { DigitalEmployeeContent } from '../src/modules/development-automation/domain/digitalEmployee'
import {
  handleApprovalObserveDecision,
  handleApprovalSubmitDecision,
  handleChildMissionDecision,
  selectPlaybookStepDecision,
} from '../src/modules/development-automation/application/playbookStepCoordinator'
import { createSqlitePlaybookSagaStore } from '../src/modules/development-automation/infrastructure/sqlitePlaybookSagaStore'
import type { PlaybookSagaStore } from '../src/modules/development-automation/application/ports/playbookSagaStore'
import type { ReconcilerPorts } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import type { ReconcileDeps } from '../src/modules/development-automation/application/missionReconciler'
import { canonicalDigest } from '../src/modules/development-automation/domain/canonicalJson'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'

const ref = (id: string, revision = 1) => ({ id, revision })
type EmployeeStep = NonNullable<DigitalEmployeeContent['steps']>[number]

const known = (value: FactCellValue): FactCell<FactCellValue> => ({
  state: 'known',
  value,
  sourceRevision: 'test-evidence',
})

function actionTemplate(capabilityId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capabilityId,
    capabilityContractVersion: 1,
    labels: [],
    compatibility: [],
    executor: { kind: 'agent', agentRef: 'agent-1@1' },
    runtimeProfileRef: 'default',
    promptSupplement: '',
    skillRefs: [],
    mcpRefs: [],
    readOnlyResourceRefs: [],
    contextProfileRef: null,
    writablePathPolicyRef: null,
    additionalProtectedPathClasses: [],
    verificationProfileRef: 'default',
    retryDefaults: { sameSession: 1, freshSession: 1 },
  }
}

function failure(onExhausted: string): EmployeeStep['onFailure'] {
  return {
    retry: { sameScene: 0, freshScene: 0 },
    onExhausted,
    onRejected: null,
    onExpired: null,
  }
}

function platformStep(
  stepId: string,
  onSuccess: string,
  join: EmployeeStep['join'] = null,
): EmployeeStep {
  return {
    stepId,
    displayName: stepId,
    description: '',
    when: [],
    producer: { kind: 'platform', capabilityId: 'repository.inspect' },
    input: { kind: 'mission-requirement' },
    onSuccess,
    join,
    onFailure: failure('block'),
  }
}

function agentStep(stepId: string, onSuccess: string, onExhausted: string): EmployeeStep {
  return {
    stepId,
    displayName: stepId,
    description: '',
    when: [],
    producer: { kind: 'agent', implementationRef: ref('tpl-action') },
    input: { kind: 'mission-requirement' },
    onSuccess,
    join: null,
    onFailure: failure(onExhausted),
  }
}

async function setup(
  patch:
    | Partial<DigitalEmployeeContent>
    | ((context: {
        employeeId: string
        employeeRevision: number
      }) => Partial<DigitalEmployeeContent>),
  cells: Record<string, FactCell<FactCellValue>> = {},
  extraPorts: Omit<
    ReconcilerPorts,
    'requirementMaterialize' | 'playbookSaga' | 'actionTemplates'
  > = {},
): Promise<{
  deps: ReconcileDeps
  mission: NonNullable<ReturnType<ReconcileDeps['store']['getMission']>>
  saga: PlaybookSagaStore
  snapshot: ReturnType<typeof buildFactSnapshot>
  launchSibling(idempotencyKey: string): Promise<string>
  reopenSaga(): PlaybookSagaStore
}> {
  const fx = await buildPr3Fixture()
  const missionId = await fx.launchDirect(`playbook-${crypto.randomUUID()}`)
  const mission = fx.store.getMission(missionId)!
  const contentPatch =
    typeof patch === 'function'
      ? patch({
          employeeId: mission.employeeId!,
          employeeRevision: mission.employeeRevision!,
        })
      : patch
  const content: DigitalEmployeeContent = {
    schemaVersion: 1,
    description: 'coordinator test employee',
    businessStatus: 'enabled',
    supportedRepositoryFacts: [],
    steps: [],
    problemTypes: [],
    problemProducers: [],
    problemHandlers: [],
    capabilityRoutes: [],
    requirementSources: [],
    pipelineProviders: [],
    defaultPolicyRef: ref(fx.policyId),
    ...contentPatch,
  }
  const saga = createSqlitePlaybookSagaStore(fx.db)
  const base = fx.deps({
    ...extraPorts,
    playbookSaga: saga,
    actionTemplates: {
      content(id) {
        if (id === 'tpl-classifier') return actionTemplate('problem.classify')
        if (id === 'tpl-handler') return actionTemplate('change.implement')
        if (id === 'tpl-action') return actionTemplate('change.implement')
        if (id === 'tpl-approval') return actionTemplate('approval.prepare')
        return null
      },
    },
  })
  const deps: ReconcileDeps = {
    ...base,
    lookup: {
      ...base.lookup,
      async getEmployeeRevisionContent() {
        return content
      },
    },
  }
  return {
    deps,
    mission,
    saga,
    snapshot: buildFactSnapshot({
      missionRevision: mission.revision,
      capturedAt: new Date().toISOString(),
      cells,
    }),
    launchSibling: (idempotencyKey) => fx.launchDirect(idempotencyKey),
    reopenSaga: () => createSqlitePlaybookSagaStore(fx.db),
  }
}

function settle(
  saga: PlaybookSagaStore,
  id: string,
  state: 'succeeded' | 'failed' | 'waiting',
  failureCode: string | null = null,
): void {
  expect(
    saga.updateStepRun({
      id,
      from: ['claimed', 'running', 'waiting'],
      state,
      outputRef: state === 'succeeded' ? `output:${id}` : null,
      outputRevision: state === 'succeeded' ? '1' : null,
      ...(failureCode === null ? {} : { failureCategory: 'business-failure', failureCode }),
      now: Date.now(),
    }),
  ).toBe(true)
}

describe('employee step routing', () => {
  test('success does not fall through into a failure-only target', async () => {
    const env = await setup({
      steps: [agentStep('attempt', 'complete', 'recover'), platformStep('recover', 'reconcile')],
    })
    const first = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    expect(first).toMatchObject({ kind: 'run-agent-action' })
    if (first?.kind !== 'run-agent-action') return
    settle(env.saga, first.stepRunRef!, 'succeeded')

    expect(await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)).toBeNull()
    expect(env.saga.listStepRuns(env.mission.id).map((run) => run.stepId)).toEqual(['attempt'])
  })

  test('exhaustion follows the configured recovery step without blocking the Mission', async () => {
    const env = await setup({
      steps: [agentStep('attempt', 'complete', 'recover'), platformStep('recover', 'reconcile')],
    })
    const first = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (first?.kind !== 'run-agent-action') throw new Error('expected root action')
    settle(env.saga, first.stepRunRef!, 'failed', 'agent-contract-exhausted')

    const recovery = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    expect(recovery).toMatchObject({ kind: 'collect-repository-facts' })
    if (recovery?.kind !== 'collect-repository-facts') return
    expect(env.saga.getStepRun(recovery.stepRunRef!)?.stepId).toBe('recover')
    expect(env.deps.store.getMission(env.mission.id)?.status).not.toBe('blocked')
  })

  test('any join settles durably and leaves the unfinished member observation-only', async () => {
    const env = await setup({
      steps: [
        platformStep('owner', 'complete', {
          groupId: 'parallel-checks',
          mode: 'any',
          quorum: null,
          memberStepIds: ['check-a', 'check-b'],
          deadlineMs: 60_000,
          onDeadline: 'handoff',
          onPartial: 'block',
        }),
        platformStep('check-a', 'reconcile'),
        platformStep('check-b', 'reconcile'),
      ],
    })
    const owner = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (owner?.kind !== 'collect-repository-facts') throw new Error('expected owner')
    settle(env.saga, owner.stepRunRef!, 'succeeded')

    const memberA = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (memberA?.kind !== 'collect-repository-facts') throw new Error('expected first member')
    settle(env.saga, memberA.stepRunRef!, 'succeeded')
    const memberARow = env.saga.getStepRun(memberA.stepRunRef!)!
    const memberB = env.saga.claimStepRun({
      id: 'join-member-b',
      missionId: env.mission.id,
      employeeId: env.mission.employeeId!,
      employeeRevision: env.mission.employeeRevision!,
      stepId: 'check-b',
      attempt: 0,
      inputDigest: memberARow.inputDigest,
      producerKind: 'platform',
      deadlineAt: null,
      now: Date.now(),
    }).row
    settle(env.saga, memberB.id, 'waiting')

    expect(await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)).toBeNull()
    expect(env.saga.getStepRun(memberB.id)?.state).toBe('observation-only')
    expect(
      env.saga
        .listJoinMembers(env.mission.id, 'parallel-checks')
        .every((member) => member.settledResult === 'satisfied'),
    ).toBe(true)
  })
})

describe('problem production and handling', () => {
  const pipelineCells = {
    '__pipeline.headSha': known('a'.repeat(40)),
    '__pipeline.manifestDigest': known('b'.repeat(64)),
    'pipeline.failingRequiredGateKeys': known(['compile']),
  }

  test('uses the declared producer fallback after the primary is exhausted', async () => {
    const env = await setup(
      {
        problemTypes: [
          {
            typeId: 'compile',
            displayName: 'Compile',
            evidenceDomain: 'pipeline',
            repairable: true,
            priority: 1,
            unknownFallback: false,
          },
        ],
        problemProducers: [
          {
            producerId: 'primary',
            displayName: 'Primary',
            kind: 'agent',
            implementationRef: ref('tpl-classifier'),
            evidenceDomains: ['pipeline'],
            allowedTypeIds: ['compile'],
            when: [],
            retry: { sameScene: 0, freshScene: 0 },
            fallbackProducerId: 'fallback',
          },
          {
            producerId: 'fallback',
            displayName: 'Fallback',
            kind: 'script',
            implementationRef: ref('tpl-classifier'),
            evidenceDomains: ['pipeline'],
            allowedTypeIds: ['compile'],
            when: [],
            retry: { sameScene: 0, freshScene: 0 },
            fallbackProducerId: null,
          },
        ],
      },
      pipelineCells,
    )
    const primary = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    expect(primary).toMatchObject({
      kind: 'run-agent-action',
      problemInput: { producerId: 'primary' },
    })
    if (primary?.kind !== 'run-agent-action') return
    settle(env.saga, primary.stepRunRef!, 'failed', 'producer-contract-exhausted')

    expect(await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)).toMatchObject({
      kind: 'run-agent-action',
      problemInput: { producerId: 'fallback' },
    })
  })

  test('handles lower numeric priority first and runs its configured verification step', async () => {
    const env = await setup(
      {
        steps: [
          {
            ...platformStep('verify', 'reconcile'),
            input: { kind: 'selected-problems' },
          },
        ] as DigitalEmployeeContent['steps'],
        problemTypes: [
          {
            typeId: 'low',
            displayName: 'Low',
            evidenceDomain: 'pipeline',
            repairable: true,
            priority: 10,
            unknownFallback: false,
          },
          {
            typeId: 'high',
            displayName: 'High',
            evidenceDomain: 'pipeline',
            repairable: true,
            priority: 1,
            unknownFallback: false,
          },
        ],
        problemHandlers: [
          {
            ruleId: 'handle-low',
            typeId: 'low',
            when: [],
            handler: { kind: 'agent', implementationRef: ref('tpl-handler') },
            verifyStepIds: [],
            retry: { sameScene: 0, freshScene: 0 },
            fallbackRuleId: null,
          },
          {
            ruleId: 'handle-high',
            typeId: 'high',
            when: [],
            handler: { kind: 'agent', implementationRef: ref('tpl-handler') },
            verifyStepIds: ['verify'],
            retry: { sameScene: 0, freshScene: 0 },
            fallbackRuleId: null,
          },
        ],
      },
      {
        '__problem.setRef': known('problem-set-1'),
        '__problem.evidenceDigest': known('c'.repeat(64)),
        '__problem.typeIds': known(['low', 'high']),
      },
    )
    const handler = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (handler?.kind !== 'run-agent-action') throw new Error('expected high-priority handler')
    expect(env.saga.getStepRun(handler.stepRunRef!)?.stepId).toBe('problem-handler:handle-high')
    settle(env.saga, handler.stepRunRef!, 'succeeded')

    const verification = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    expect(verification).toMatchObject({ kind: 'collect-repository-facts' })
    if (verification?.kind !== 'collect-repository-facts') return
    expect(env.saga.getStepRun(verification.stepRunRef!)?.stepId).toBe('verify')
  })
})

describe('cross-repository employee and approval saga', () => {
  test('handoff and terminal settlement retain dispatched child and approval receipts', async () => {
    const env = await setup({})
    const now = Date.now()
    const childMissionId = await env.launchSibling(`retained-child-${crypto.randomUUID()}`)
    const childStep = env.saga.claimStepRun({
      id: 'retained-child-step',
      missionId: env.mission.id,
      employeeId: env.mission.employeeId!,
      employeeRevision: env.mission.employeeRevision!,
      stepId: 'delegate-retained-child',
      attempt: 0,
      inputDigest: '4'.repeat(64),
      producerKind: 'digital-employee',
      deadlineAt: now + 60_000,
      now,
    }).row
    const childLink = env.saga.claimMissionLink({
      id: 'retained-child-link',
      parentMissionId: env.mission.id,
      parentStepRunId: childStep.id,
      targetRepositoryId: 'retained-child-repository',
      targetEmployeeId: 'retained-child-employee',
      targetEmployeeRevision: 2,
      inputDigest: '5'.repeat(64),
      idempotencyKey: '6'.repeat(64),
      completion: 'ready-to-merge',
      now,
    }).row
    env.saga.observeMissionLink({
      id: childLink.id,
      childMissionId,
      childRevision: 7,
      status: 'ready-to-merge',
      completionSatisfied: true,
      outputRef: 'child-ready-receipt',
      observedAt: now + 1,
    })

    const approvalStep = env.saga.claimStepRun({
      id: 'retained-approval-step',
      missionId: env.mission.id,
      employeeId: env.mission.employeeId!,
      employeeRevision: env.mission.employeeRevision!,
      stepId: 'wait-retained-approval',
      attempt: 0,
      inputDigest: '7'.repeat(64),
      producerKind: 'approval-observe',
      deadlineAt: now + 120_000,
      now,
    }).row
    const approval = env.saga.claimApprovalSaga({
      id: 'retained-approval-saga',
      missionId: env.mission.id,
      stepRunId: approvalStep.id,
      adapterId: 'retained-approval-system',
      adapterRevision: 3,
      draftRef: 'retained-approval-draft',
      submitIntentDigest: '8'.repeat(64),
      idempotencyKey: '9'.repeat(64),
      deadlineAt: now + 120_000,
      now,
    }).row
    env.saga.recordApprovalSubmitted({
      id: approval.id,
      correlationRef: 'retained-correlation',
      externalRequestRef: 'APP-RETAINED',
      submittedRevision: 'submit-retained',
      now: now + 2,
    })
    env.saga.recordApprovalObservation({
      id: approval.id,
      status: 'approved',
      observedRevision: 'approved-retained',
      evidenceRef: 'approval-evidence-retained',
      nextObserveAt: null,
      now: now + 3,
    })

    const handedOff = env.deps.store.bumpEpoch(env.mission.id, env.mission.revision, {
      automationMode: 'tracking-only',
    })
    expect(handedOff.ok).toBe(true)
    const tracking = env.deps.store.getMission(env.mission.id)!
    const terminal = env.deps.store.occUpdate(tracking.id, tracking.revision, tracking.epoch, {
      status: 'merged',
      terminalKind: 'merged',
      terminalAt: now + 4,
    })
    expect(terminal.ok).toBe(true)

    expect(env.saga.listMissionLinks(env.mission.id)).toMatchObject([
      {
        childMissionId,
        latestStatus: 'ready-to-merge',
        completionSatisfied: true,
        outputRef: 'child-ready-receipt',
      },
    ])
    expect(env.saga.listApprovalSagas(env.mission.id)).toMatchObject([
      {
        externalRequestRef: 'APP-RETAINED',
        latestStatus: 'approved',
        evidenceRef: 'approval-evidence-retained',
      },
    ])
  })

  test('blocks a recursive employee identity even when the requested revision differs', async () => {
    const env = await setup(({ employeeId, employeeRevision }) => ({
      steps: [
        {
          stepId: 'recursive-call',
          displayName: 'Recursive call',
          description: '',
          when: [],
          producer: {
            kind: 'digital-employee',
            employeeRef: ref(employeeId, employeeRevision + 1),
            repository: { kind: 'fixed', repositoryId: 'another-repository' },
            completion: 'ready-to-merge',
            deadlineMs: 60_000,
          },
          input: { kind: 'mission-requirement' },
          onSuccess: 'complete',
          join: null,
          onFailure: failure('block'),
        },
      ],
    }))
    expect(await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)).toEqual({
      kind: 'block',
      reason: 'child-mission-cycle',
    })
    expect(env.saga.listMissionLinks(env.mission.id)).toEqual([])
  })

  test('resumes the published parent chain after child readiness and a pending-to-approved receipt', async () => {
    let childCreates = 0
    let childObserves = 0
    let approvalSubmits = 0
    let approvalObserves = 0
    let childMissionRef = ''
    const env = await setup(
      {
        steps: [
          {
            stepId: 'delegate-gate-config',
            displayName: 'Delegate gate configuration',
            description: '',
            when: [],
            producer: {
              kind: 'digital-employee',
              employeeRef: ref('gate-employee'),
              repository: { kind: 'fixed', repositoryId: 'gate-repository' },
              completion: 'ready-to-merge',
              deadlineMs: 60_000,
            },
            input: { kind: 'mission-requirement' },
            onSuccess: 'prepare-approval',
            join: null,
            onFailure: failure('block'),
          },
          {
            stepId: 'prepare-approval',
            displayName: 'Prepare approval',
            description: '',
            when: [],
            producer: {
              kind: 'approval-prepare',
              executor: 'agent',
              implementationRef: ref('tpl-approval'),
              approvalType: 'gate-rollout',
            },
            input: { kind: 'step-output', stepId: 'delegate-gate-config' },
            onSuccess: 'submit-approval',
            join: null,
            onFailure: failure('block'),
          },
          {
            stepId: 'submit-approval',
            displayName: 'Submit approval',
            description: '',
            when: [],
            producer: { kind: 'approval-submit', adapterRef: ref('approval-system') },
            input: { kind: 'step-output', stepId: 'prepare-approval' },
            onSuccess: 'observe-approval',
            join: null,
            onFailure: failure('block'),
          },
          {
            stepId: 'observe-approval',
            displayName: 'Wait for approval',
            description: '',
            when: [],
            producer: {
              kind: 'approval-observe',
              adapterRef: ref('approval-system'),
              pollIntervalMs: 5_000,
              deadlineMs: 60_000,
              webhookSourceKey: 'gate-approval',
            },
            input: { kind: 'step-output', stepId: 'submit-approval' },
            onSuccess: 'continue-parent',
            join: null,
            onFailure: {
              retry: { sameScene: 0, freshScene: 0 },
              onExhausted: 'block',
              onRejected: 'handoff',
              onExpired: 'block',
            },
          },
          platformStep('continue-parent', 'complete'),
        ],
      },
      {},
      {
        childMissions: {
          async createOrAdopt(input) {
            childCreates += 1
            return {
              intentDigest: canonicalDigest(input),
              childMissionRef,
              childRevision: 1,
              observedStatus: 'running',
              completionSatisfied: false,
              outputEnvelopeRef: null,
              observedAt: '2026-08-19T00:00:01+00:00',
            }
          },
          async observe(input) {
            childObserves += 1
            return {
              intentDigest: input.intentDigest,
              childMissionRef: input.childMissionRef,
              childRevision: 2,
              observedStatus: 'ready-to-merge',
              completionSatisfied: true,
              outputEnvelopeRef: 'child-ready-receipt',
              observedAt: '2026-08-19T00:00:02+00:00',
            }
          },
        },
        approvalGateway: {
          async submit(input) {
            approvalSubmits += 1
            return {
              ok: true,
              receipt: {
                intentDigest: canonicalDigest(input),
                correlationRef: 'approval-correlation-1',
                externalRequestRef: 'APP-1',
                submittedRevision: 'submit-1',
                submittedAt: '2026-08-19T00:00:03+00:00',
              },
            }
          },
          async lookupByIdempotencyKey() {
            return null
          },
          async observe(input) {
            approvalObserves += 1
            const approved = approvalObserves > 1
            return {
              ok: true,
              receipt: {
                correlationRef: input.correlationRef,
                observedRevision: `observe-${approvalObserves}`,
                status: approved ? 'approved' : 'pending',
                evidenceRef: approved ? 'approval-evidence-1' : null,
                observedAt: `2026-08-19T00:00:0${3 + approvalObserves}+00:00`,
              },
            }
          },
        },
      },
    )
    childMissionRef = await env.launchSibling(`child-${crypto.randomUUID()}`)

    const launchChild = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (launchChild?.kind !== 'invoke-child-mission') throw new Error('expected child launch')
    expect(
      await handleChildMissionDecision(env.deps, env.mission, launchChild, 'decision-child-1'),
    ).toBe('wake-armed')

    const observeChild = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (observeChild?.kind !== 'invoke-child-mission') throw new Error('expected child observe')
    expect(
      await handleChildMissionDecision(env.deps, env.mission, observeChild, 'decision-child-2'),
    ).toBe('collected')

    const prepare = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (prepare?.kind !== 'run-agent-action') throw new Error('expected approval preparation')
    expect(prepare).toMatchObject({
      capabilityId: 'approval.prepare',
      approvalInput: { approvalType: 'gate-rollout' },
    })
    settle(env.saga, prepare.stepRunRef!, 'succeeded')

    const submit = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (submit?.kind !== 'submit-approval') throw new Error('expected approval submit')
    expect(
      await handleApprovalSubmitDecision(env.deps, env.mission, submit, 'decision-submit'),
    ).toBe('collected')

    const observePending = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (observePending?.kind !== 'observe-approval') throw new Error('expected approval observe')
    expect(
      await handleApprovalObserveDecision(
        env.deps,
        env.mission,
        observePending,
        'decision-observe-1',
      ),
    ).toBe('wake-armed')

    // A daemon restart creates fresh ports over the same SQLite rows. No
    // process-local object is allowed to own the pending approval ordinal.
    const restartedSaga = env.reopenSaga()
    const restartedDeps: ReconcileDeps = {
      ...env.deps,
      ports: { ...env.deps.ports, playbookSaga: restartedSaga },
    }
    expect(restartedSaga.listApprovalSagas(env.mission.id)).toMatchObject([
      {
        externalRequestRef: 'APP-1',
        latestStatus: 'pending',
        attemptOrdinal: 1,
      },
    ])

    const observeApproved = await selectPlaybookStepDecision(
      restartedDeps,
      env.mission,
      env.snapshot,
    )
    if (observeApproved?.kind !== 'observe-approval')
      throw new Error('expected approval re-observe')
    expect(
      await handleApprovalObserveDecision(
        restartedDeps,
        env.mission,
        observeApproved,
        'decision-observe-2',
      ),
    ).toBe('collected')

    const resumed = await selectPlaybookStepDecision(restartedDeps, env.mission, env.snapshot)
    expect(resumed).toMatchObject({ kind: 'collect-repository-facts' })
    if (resumed?.kind !== 'collect-repository-facts') return
    settle(restartedSaga, resumed.stepRunRef!, 'succeeded')
    expect(await selectPlaybookStepDecision(restartedDeps, env.mission, env.snapshot)).toBeNull()

    expect({ childCreates, childObserves, approvalSubmits, approvalObserves }).toEqual({
      childCreates: 1,
      childObserves: 1,
      approvalSubmits: 1,
      approvalObserves: 2,
    })
  })

  test('rejects a child receipt that does not belong to the frozen intent', async () => {
    const env = await setup(
      {
        steps: [
          {
            stepId: 'delegate',
            displayName: 'Delegate',
            description: '',
            when: [],
            producer: {
              kind: 'digital-employee',
              employeeRef: ref('child-employee'),
              repository: { kind: 'fixed', repositoryId: 'child-repository' },
              completion: 'ready-to-merge',
              deadlineMs: 60_000,
            },
            input: { kind: 'mission-requirement' },
            onSuccess: 'complete',
            join: null,
            onFailure: failure('block'),
          },
        ],
      },
      {},
      {
        childMissions: {
          async createOrAdopt() {
            return {
              intentDigest: '0'.repeat(64),
              childMissionRef: 'foreign-child',
              childRevision: 1,
              observedStatus: 'ready-to-merge',
              completionSatisfied: true,
              outputEnvelopeRef: 'foreign-output',
              observedAt: '2026-08-19T00:00:00+00:00',
            }
          },
          async observe() {
            throw new Error('not reached')
          },
        },
      },
    )
    const selected = await selectPlaybookStepDecision(env.deps, env.mission, env.snapshot)
    if (selected?.kind !== 'invoke-child-mission') throw new Error('expected child launch')
    expect(
      await handleChildMissionDecision(env.deps, env.mission, selected, 'decision-foreign-child'),
    ).toBe('collected')
    expect(env.saga.getStepRun(selected.stepRunRef)).toMatchObject({
      state: 'failed',
      failureCategory: 'contract-violation',
      failureCode: 'child-intent-digest-mismatch',
    })
  })

  test('turns a still-pending approval into expired at its durable deadline', async () => {
    const env = await setup(
      {},
      {},
      {
        approvalGateway: {
          async submit() {
            throw new Error('not reached')
          },
          async lookupByIdempotencyKey() {
            return null
          },
          async observe(input) {
            return {
              ok: true,
              receipt: {
                correlationRef: input.correlationRef,
                observedRevision: 'observe-after-deadline',
                status: 'pending',
                evidenceRef: null,
                observedAt: '2026-08-19T00:00:00+00:00',
              },
            }
          },
        },
      },
    )
    const now = Date.now()
    const run = env.saga.claimStepRun({
      id: 'observe-expired-step',
      missionId: env.mission.id,
      employeeId: env.mission.employeeId!,
      employeeRevision: env.mission.employeeRevision!,
      stepId: 'observe-expired',
      attempt: 0,
      inputDigest: '1'.repeat(64),
      producerKind: 'approval-observe',
      deadlineAt: now - 1,
      now,
    }).row
    const saga = env.saga.claimApprovalSaga({
      id: 'approval-expired-saga',
      missionId: env.mission.id,
      stepRunId: run.id,
      adapterId: 'approval-system',
      adapterRevision: 1,
      draftRef: 'approval-draft',
      submitIntentDigest: '2'.repeat(64),
      idempotencyKey: '3'.repeat(64),
      deadlineAt: now - 1,
      now,
    }).row
    env.saga.recordApprovalSubmitted({
      id: saga.id,
      correlationRef: 'approval-correlation-expired',
      externalRequestRef: 'APP-EXPIRED',
      submittedRevision: 'submit-expired',
      now,
    })

    expect(
      await handleApprovalObserveDecision(
        env.deps,
        env.mission,
        {
          kind: 'observe-approval',
          stepRunRef: run.id,
          approvalSagaRef: saga.id,
          pollIntervalMs: 5_000,
        },
        'decision-observe-expired',
      ),
    ).toBe('collected')
    expect(env.saga.getStepRun(run.id)).toMatchObject({
      state: 'failed',
      failureCode: 'approval-expired',
    })
    expect(env.saga.getApprovalSaga(saga.id)?.latestStatus).toBe('expired')
  })
})
