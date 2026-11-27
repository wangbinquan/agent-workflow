// RFC-628 — a development digital employee run end to end on the real runtime, the real type
// package and the real platform work items, with an in-memory code host, workspace and approval
// system. The tests in tests/rfc628-reply-after-preemption-runtime.test.ts walk a case to the point
// where "reply with repair result" or "freeze the change" is next, let an event take the round
// (design §3.8), and check that the previous round still ends with the reply.
//
// The platform work items are the production ones on purpose: design §6 warns that a fake that does
// not write the review-resolution ledger like the real one (publish-mr marking it published,
// reply-feedback writing it replied) makes the new settlement loop between work items. Only the
// ports underneath them are doubles: the code host keeps review threads and stores every platform
// reply as a message carrying its self marker (as the real provider does), the workspace and the
// candidates live in memory, and a push moves the merge request head.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  composeDigitalEmployee,
  createEmployeeReactionRoundQueries,
} from '@/modules/digital-employee/composition'
import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  developmentEmployeeRuntimeCodec,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/application/employeeTypePackage'
import {
  composeDevelopmentEmployeePlatformWorkItemsFromPersistence,
  type DevelopmentEmployeePlatformWorkItemsCompositionInput,
} from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { canonicalDigest } from '@/modules/development-automation/domain/canonicalJson'
import { businessTreeSnapshotDigest } from '@/modules/development-automation/application/workspaceValidator'
import { businessTreeSnapshot } from '@/modules/development-automation/infrastructure/workspaceValidator'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { createFileRepositoryBaselineEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileRepositoryBaselineEffects'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'
import { composeEventCenter, standaloneEventCenterSelections } from './eventCenter'
import { standaloneDigitalEmployeeSelections } from './digitalEmployeeSelections'
import { legacyShapedReactionExecution } from './legacyShapedReactionExecution'
import {
  composeStandalonePlatformWorkItemEvidence,
  graphDeliveryWithoutDesign,
  unusedEmployeePlatformProviders,
} from './developmentAutomation'
import type { ProviderHarness } from './eachProvider'

export const RFC628_REPOSITORY = 'repo-1'
export const RFC628_MR_SUBJECT = `${RFC628_REPOSITORY}!42`
const INITIAL_HEAD = 'a'.repeat(40)
const TARGET = 'b'.repeat(40)
const APPROVAL_ADAPTER = { id: 'approval-adapter', revision: 1 } as const

/** Work items whose tools the job binds: the delivery spine plus the review, conflict and approval lanes. */
const BOUND_WORK_ITEMS = new Set([
  'analyze-implement',
  'repair-feedback',
  'repair-conflict',
  'prepare-approval',
])

/**
 * development@11 as the previous build registered it: the current package at the earlier revision
 * with the earlier observe-mr / observe-approval successors (the build no longer contains it).
 */
export function legacyDevelopmentElevenPackage(): EmployeeTypePackageRegistration {
  const descriptor = JSON.parse(developmentEmployeeTypePackage.descriptorJson) as {
    typeRef: { typeId: string; revision: number }
    authoringManifest: { workItems: Array<{ workItemRef: string; nextWorkItemRefs: string[] }> }
  }
  descriptor.typeRef = { typeId: 'development', revision: 11 }
  for (const item of descriptor.authoringManifest.workItems) {
    if (item.workItemRef === 'observe-mr')
      item.nextWorkItemRefs = [
        'classify-feedback',
        'collect-pipeline',
        'repair-conflict',
        'prepare-approval',
        'evaluate-ready',
      ]
    if (item.workItemRef === 'observe-approval') item.nextWorkItemRefs = ['observe-mr']
  }
  return { ...developmentEmployeeTypePackage, descriptorJson: JSON.stringify(descriptor) }
}

interface HostMessage {
  readonly messageRef: string
  readonly parentMessageRef: string | null
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly body: string
  readonly path: string | null
  readonly createdAt: string | null
}
interface HostThread {
  readonly threadRef: string
  revision: string
  resolved: boolean
  readonly body: string
  readonly path: string | null
  readonly messages: HostMessage[]
}

export interface Rfc628RuntimeOptions {
  /** The merge request needs an external approval (approval lane runs after each publication). */
  readonly approvalHold?: boolean
  /** Run on the reconstructed development@11 instead of the current package. */
  readonly legacy?: boolean
}

export interface Rfc628Round {
  readonly id: string
  readonly workItemRef: string
  readonly ruleId: string
  readonly state: string
}

export async function createRfc628Runtime(
  harness: ProviderHarness,
  appHome: string,
  options: Rfc628RuntimeOptions = {},
) {
  const db = harness.db
  let clock = 1_800_000_000_000
  const now = () => clock
  const tick = (ms = 1) => {
    clock += ms
  }
  let ordinal = 0
  const nextId = () => `rfc628-${String(++ordinal).padStart(6, '0')}`
  let shaOrdinal = 0
  const sha = (prefix: string, length = 40) => `${prefix}${++shaOrdinal}`.padEnd(length, '0')

  const typePackage = options.legacy
    ? legacyDevelopmentElevenPackage()
    : developmentEmployeeTypePackage
  const typeRef = (
    JSON.parse(typePackage.descriptorJson) as { typeRef: { typeId: string; revision: number } }
  ).typeRef

  // ---------------------------------------------------------------- code host
  const host = {
    state: 'opened' as 'opened' | 'merged' | 'closed',
    head: INITIAL_HEAD,
    mergeableState: 'mergeable' as 'mergeable' | 'conflict' | 'unknown',
    approvalHold: options.approvalHold === true,
    threads: [] as HostThread[],
    ensured: 0,
    replyAttempts: [] as Array<{ threadRef: string; body: string; selfMarker: string }>,
    failingReplies: new Set<string>(),
    mergeCommits: new Set<string>(),
    notes: 0,
  }
  const snapshotThreads = () =>
    host.threads.map((thread) => ({
      threadRef: thread.threadRef,
      revision: thread.revision,
      authorClass: 'human' as const,
      resolved: thread.resolved,
      body: thread.body,
      path: thread.path,
      messages: thread.messages.map((message) => ({ ...message })),
    }))
  const mrEffects: DevelopmentEmployeePlatformWorkItemsCompositionInput['mrEffects'] = {
    async reply(_repositoryId, request) {
      host.replyAttempts.push({
        threadRef: request.threadRef,
        body: request.body,
        selfMarker: request.selfMarker,
      })
      const thread = host.threads.find((candidate) => candidate.threadRef === request.threadRef)
      if (thread === undefined || host.failingReplies.has(request.threadRef)) {
        return {
          ok: false,
          code: 'mr-reply-failed',
          detail: `discussion ${request.threadRef} rejected the reply`,
        }
      }
      const noteRef = `note-${++host.notes}`
      thread.messages.push({
        messageRef: noteRef,
        parentMessageRef: thread.messages[0]?.messageRef ?? null,
        authorClass: 'self',
        body: `${request.body}\n\n<!-- aw-self:${request.selfMarker} -->`,
        path: thread.path,
        createdAt: null,
      })
      return { ok: true, noteRef }
    },
    async ensure() {
      host.ensured += 1
      return {
        ok: true,
        mr: {
          mrRef: '42',
          webUrl: 'https://code.example/repo-1/merge_requests/42',
          state: host.state,
          sourceSha: host.head,
          created: host.ensured === 1,
        },
      }
    },
    async observe() {
      return {
        ok: true,
        observation: {
          state: host.state,
          sourceSha: host.head,
          targetBranch: 'main',
          webUrl: 'https://code.example/repo-1/merge_requests/42',
        },
      }
    },
  }
  const mrFacts: DevelopmentEmployeePlatformWorkItemsCompositionInput['mrFacts'] = {
    async collect() {
      const reviewThreads = snapshotThreads()
      return {
        ok: true,
        snapshot: {
          state: host.state,
          headSha: host.head,
          targetSha: TARGET,
          targetBranch: 'main',
          draft: false,
          mergeableState: host.mergeableState,
          approvalHold: host.approvalHold,
          mergedCommitSha: host.state === 'merged' ? host.head : null,
          unresolvedReviewCount: reviewThreads.filter((thread) => !thread.resolved).length,
          reviewThreads,
        },
      }
    },
  }

  // ------------------------------------------------- workspace, candidates, approval sagas
  const workspaces = new Map<
    string,
    {
      caseId: string
      repositoryId: string
      cachedRepoId: string
      baselineSha: string
      targetBranch: string
      sourceBranch: string
      remoteHeadSha: string | null
      state: 'active' | 'published'
      createdAt: number
      updatedAt: number
    }
  >()
  const workspaceOf = (caseId: string) => {
    let row = workspaces.get(caseId)
    if (row === undefined) {
      row = {
        caseId,
        repositoryId: RFC628_REPOSITORY,
        cachedRepoId: RFC628_REPOSITORY,
        baselineSha: host.head,
        targetBranch: 'main',
        sourceBranch: 'feature/rfc628',
        remoteHeadSha: null,
        state: 'active',
        createdAt: now(),
        updatedAt: now(),
      }
      workspaces.set(caseId, row)
    }
    return row
  }
  const candidates = new Map<
    string,
    {
      candidateRef: string
      baselineSha: string
      treeOid: string
      receiptJson: string
      summarySource: string
      state: 'prepared' | 'committed' | 'published' | 'obsolete'
      commitSha: string | null
    }
  >()
  const sagas = new Map<string, Record<string, unknown>>()
  const workspaceRebuilds: string[] = []
  const conflictRoot = mkdtempSync(join(appHome, 'conflict-scene-'))
  mkdirSync(conflictRoot, { recursive: true })
  writeFileSync(join(conflictRoot, 'book.ts'), 'export const duplicateBooking = false\n')
  const conflictDigest = businessTreeSnapshotDigest(
    await businessTreeSnapshot(conflictRoot, createFileAutomationWorkspaceEffectsFactory()),
  )
  let approvalSubmits = 0
  let approvalStatus: 'pending' | 'approved' | 'rejected' = 'pending'

  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`unexpected RFC-628 fixture effect: ${name}`)
  }
  const platform = composeDevelopmentEmployeePlatformWorkItemsFromPersistence({
    ...unusedEmployeePlatformProviders(),
    automationWorkspaceEffects: createFileAutomationWorkspaceEffectsFactory(),
    repositoryBaselines: createFileRepositoryBaselineEffectsFactory(),
    appHome,
    evidenceArtifacts: composeStandalonePlatformWorkItemEvidence({ appHome }),
    directPublicationSubject: { kind: 'system' },
    graphDelivery: graphDeliveryWithoutDesign(),
    reactionRounds: createEmployeeReactionRoundQueries(db),
    now,
    persistence: {
      async currentWorkspace(caseId: string) {
        return { row: { ...workspaceOf(caseId) }, repositoryLocalPath: '/rfc628/baseline' }
      },
      async prepareApprovalSaga(input: Record<string, unknown> & { idempotencyKey: string }) {
        const existing = sagas.get(input.idempotencyKey)
        if (existing !== undefined) return existing
        sagas.set(input.idempotencyKey, { ...input })
        return { ...input }
      },
      async approvalSaga(idempotencyKey: string) {
        return sagas.get(idempotencyKey) ?? null
      },
      async recordApprovalSubmission(input: Record<string, unknown> & { idempotencyKey: string }) {
        const saga = sagas.get(input.idempotencyKey)!
        sagas.set(input.idempotencyKey, { ...saga, ...input, latestStatus: 'pending' })
      },
      async recordApprovalObservation(input: Record<string, unknown> & { idempotencyKey: string }) {
        const saga = sagas.get(input.idempotencyKey)!
        sagas.set(input.idempotencyKey, { ...saga, ...input })
      },
      async insertCandidate(input: {
        candidateRef: string
        baselineSha: string
        treeOid: string
        receiptJson: string
        summarySource: string
      }) {
        candidates.set(input.candidateRef, {
          candidateRef: input.candidateRef,
          baselineSha: input.baselineSha,
          treeOid: input.treeOid,
          receiptJson: input.receiptJson,
          summarySource: input.summarySource,
          state: 'prepared',
          commitSha: null,
        })
      },
      async candidate(candidateRef: string) {
        const found = candidates.get(candidateRef)
        if (found === undefined) return null
        // The persisted receipt carries the derive receipt's upload lineage (null without uploads).
        return {
          ...found,
          receiptJson: JSON.stringify({ uploadLineage: null, ...JSON.parse(found.receiptJson) }),
        }
      },
      async recordCandidateCommit(input: { candidateRef: string; commitSha: string }) {
        const found = candidates.get(input.candidateRef)!
        candidates.set(input.candidateRef, {
          ...found,
          state: 'committed',
          commitSha: input.commitSha,
        })
      },
      async publishCandidateAndWorkspace(input: {
        candidateRef: string
        caseId: string
        commitSha: string
      }) {
        const found = candidates.get(input.candidateRef)!
        candidates.set(input.candidateRef, { ...found, state: 'published' })
        const row = workspaceOf(input.caseId)
        workspaces.set(input.caseId, {
          ...row,
          state: 'published',
          baselineSha: input.commitSha,
          remoteHeadSha: input.commitSha,
          updatedAt: now(),
        })
      },
      async updateWorkspaceHead(input: {
        caseId: string
        baselineSha: string
        remoteHeadSha: string
      }) {
        const row = workspaceOf(input.caseId)
        workspaces.set(input.caseId, {
          ...row,
          baselineSha: input.baselineSha,
          remoteHeadSha: input.remoteHeadSha,
          updatedAt: now(),
        })
      },
      // Only publish-conflict reads a round validation: the platform-validated conflict scene.
      async latestRoundValidation() {
        return JSON.stringify({
          ok: true,
          changedPaths: ['book.ts'],
          postBusinessDigest: conflictDigest,
          conflict: {
            workspacePath: conflictRoot,
            sourceSha: host.head,
            targetSha: TARGET,
            conflictPaths: ['book.ts'],
          },
          inspection: { ok: true },
        })
      },
    },
    repoRemote: {
      resolve: () => ({ remoteUrl: 'https://code.example/repo-1.git', defaultBranch: 'main' }),
    },
    mrEffects,
    mrFacts,
    approvalGateway: {
      async lookupByIdempotencyKey() {
        return null
      },
      async submit(intent: Parameters<typeof canonicalDigest>[0]) {
        approvalSubmits += 1
        return {
          ok: true as const,
          receipt: {
            intentDigest: canonicalDigest(intent),
            correlationRef: `approval-correlation-${approvalSubmits}`,
            externalRequestRef: `APP-${approvalSubmits}`,
            submittedRevision: `submit-${approvalSubmits}`,
            submittedAt: new Date(now()).toISOString(),
          },
        }
      },
      async observe(input: { correlationRef: string }) {
        return {
          ok: true as const,
          receipt: {
            correlationRef: input.correlationRef,
            observedRevision: `observe-${now()}`,
            status: approvalStatus,
            evidenceRef: approvalStatus === 'approved' ? 'approval-evidence' : null,
            observedAt: new Date(now()).toISOString(),
          },
        }
      },
    },
    sourceControl: {
      async derive() {
        // A variable, not an inline literal: the port types only the fields the work item reads.
        const receipt = {
          candidateRef: sha('d', 64),
          treeOid: sha('7'),
          changed: { added: [], modified: ['src/book.ts'], deleted: [] },
          uploadLineage: null,
        }
        return { ok: true as const, receipt }
      },
      async commit() {
        return { ok: true as const, commitSha: sha('c'), localRef: 'local:commit', reused: false }
      },
      async push(request: { commitSha: string; branch: string; expectedRemoteSha: string | null }) {
        host.head = request.commitSha
        // Pushing the platform's merge commit resolves the conflict; an ordinary push does not.
        if (host.mergeCommits.has(request.commitSha)) host.mergeableState = 'mergeable'
        return {
          ok: true as const,
          receipt: {
            remoteRef: `refs/heads/${request.branch}`,
            oldSha: request.expectedRemoteSha,
            newSha: request.commitSha,
            reused: false,
          },
        }
      },
      checkpoint: () => ({ checkpointDigest: sha('9', 64) }),
      async restore() {
        return { workspacePath: '/rfc628/scene/workspace' }
      },
      materialize: unexpected('sourceControl.materialize'),
      async rematerialize(request: { baselineSha: string }) {
        workspaceRebuilds.push(request.baselineSha)
        return { workspacePath: '/rfc628/scene/workspace' }
      },
      async fetchRemoteHead(request: { expectedHeadSha: string }) {
        return { ok: true as const, headSha: request.expectedHeadSha }
      },
      async importCommit() {},
    },
    conflictMerge: {
      async finish() {
        const mergeCommitSha = sha('e')
        host.mergeCommits.add(mergeCommitSha)
        return { ok: true as const, mergeCommitSha, treeOid: sha('7') }
      },
    },
  } as unknown as DevelopmentEmployeePlatformWorkItemsCompositionInput)

  // ------------------------------------------------------------ agent executions
  let reviewMode: 'code' | 'reply-only' = 'code'
  const executed = new Map<string, { plan: ReactionExecutionPlan; outputJson: string }>()
  const agentRuns: string[] = []
  const contextsOf = (plan: ReactionExecutionPlan) =>
    JSON.parse(
      (JSON.parse(plan.inputEnvelopeJson) as { contextsJson: string }).contextsJson,
    ) as Array<{
      typeId: string
      stateJson: string
    }>
  const stateOf = <T>(plan: ReactionExecutionPlan, typeId: string): T => {
    const found = contextsOf(plan).find((candidate) => candidate.typeId === typeId)
    if (found === undefined) throw new Error(`${plan.workItemRef} plan has no ${typeId}`)
    return JSON.parse(found.stateJson) as T
  }
  const reactionExecution = legacyShapedReactionExecution(
    {
      async launch(plan) {
        agentRuns.push(plan.workItemRef)
        let output: Record<string, unknown>
        if (plan.workItemRef === 'analyze-implement') {
          output = {
            outcome: 'completed',
            commitMessage: 'feat: reject duplicate bookings',
            mergeRequestTitle: 'Reject duplicate bookings',
            mergeRequestDescription: 'Rejects a booking for an occupied slot.',
          }
        } else if (plan.workItemRef === 'repair-feedback') {
          const problemSet = stateOf<{
            problems: Array<{ reviewThread: { threadRef: string } }>
          }>(plan, 'development.problem-set')
          output = {
            outcome: 'completed',
            replies: problemSet.problems.map((problem) => ({
              threadRef: problem.reviewThread.threadRef,
              reply: `Handled ${problem.reviewThread.threadRef} as requested.`,
            })),
            ...(reviewMode === 'code' ? { commitMessage: 'fix: address the review feedback' } : {}),
          }
        } else if (plan.workItemRef === 'repair-conflict') {
          output = { outcome: 'completed', commitMessage: 'merge: resolve the target conflict' }
        } else if (plan.workItemRef === 'prepare-approval') {
          const mergeRequest = stateOf<{ mergeRequestRef: string; headSha: string }>(
            plan,
            'development.merge-request',
          )
          output = {
            outcome: 'completed',
            draft: `## 变更审批\n\nMR ${mergeRequest.mergeRequestRef} 当前版本 ${mergeRequest.headSha} 请审批。`,
          }
        } else {
          throw new Error(`unexpected RFC-628 agent work item: ${plan.workItemRef}`)
        }
        const executionRef = `rfc628-execution-${executed.size + 1}`
        executed.set(executionRef, { plan, outputJson: JSON.stringify(output) })
        return { executionRef }
      },
      async inspect(executionRef) {
        const done = executed.get(executionRef)
        if (done === undefined) return { kind: 'pending' as const, executionRef }
        return {
          kind: 'completed' as const,
          executionRef,
          outputJson: done.outputJson,
          metering: { sourceRef: executionRef, durationMs: 0, totalTokens: 0 },
        }
      },
      async cancel() {},
    },
    now,
  )

  // ------------------------------------------------------------ runtime composition
  const eventCenter = await composeEventCenter({
    ...standaloneEventCenterSelections(),
    db,
    typePackageDescriptorJsons: [
      typePackage.descriptorJson,
      digitalEmployeeLifecycleEventCatalogJson,
    ],
    automation: { kind: 'observation-only' },
    now,
    id: nextId,
  })
  const executionContracts = new ExecutionContractService({
    registrations: developmentExecutionContractRegistrations,
    resources: {
      async inspect({ implementation }) {
        return {
          kind: implementation.kind,
          name:
            implementation.kind === 'agent'
              ? implementation.agentRef.id
              : implementation.workflowRef.id,
          available: true,
          detail: 'RFC-628 runtime fixture executor',
          declaredContractRefs:
            implementation.kind === 'agent'
              ? developmentExecutionContractRegistrations.map(
                  (registration) => registration.contractRef,
                )
              : null,
        }
      },
    },
    programFixtures: {
      async run() {
        throw new Error('the RFC-628 runtime fixture never executes a program')
      },
    },
  })
  const module = composeDigitalEmployee({
    ...standaloneDigitalEmployeeSelections({ db, appHome }),
    db,
    appHome,
    typePackages: [typePackage],
    executionContracts,
    now,
    id: nextId,
    connectionCatalog: {
      async resolve(ref) {
        return {
          ref,
          purpose: 'approval-gateway',
          available: true,
          visible: true,
          contentDigest: '0'.repeat(64),
          closureSummary: 'RFC-628 approval gateway fixture',
        }
      },
    },
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      reactionExecution,
      platformWorkItems: {
        async execute(plan, executionContext) {
          // The prepare-materials program is not bound; its minimal result needs no material here.
          if (plan.workItemRef === 'prepare-materials')
            return JSON.stringify({ outcome: 'completed' })
          return await platform.execute(plan, executionContext)
        },
      },
    },
  })
  const runtime = module.runtime!

  // ------------------------------------------------------------ type, tools, job, employee
  const type = await module.queries.getType(typeRef)
  const bindings: Array<{
    workItemRef: string
    slotRef: string
    registrationRef: { id: string; revision: number }
  }> = []
  for (const item of type.authoringManifest.workItems) {
    if (!BOUND_WORK_ITEMS.has(item.workItemRef)) continue
    for (const role of item.toolRoleGroups) {
      for (const slot of role.bindingSlots) {
        // Optional slots (the implementation-plan writer) stay unbound, as in a default job.
        if (!slot.required) continue
        const contract = type.workContracts.find(
          (candidate) =>
            candidate.contractId === item.workContractRef.contractId &&
            candidate.version === item.workContractRef.version,
        )!
        const tool = await module.commands.createTool({
          typeRef,
          workItemRef: item.workItemRef,
          actorUserId: 'author',
          body: {
            displayName: `${item.workItemRef} tool`,
            description: 'RFC-628 runtime fixture tool',
            roleRef: role.roleRef,
            implementation: contract.allowedToolKinds.includes('agent')
              ? {
                  kind: 'agent' as const,
                  agentRef: { id: `agent-${item.workItemRef}`, revision: 1 },
                }
              : {
                  kind: 'workflow' as const,
                  workflowRef: { id: `workflow-${item.workItemRef}`, revision: 1 },
                },
          },
        })
        bindings.push({
          workItemRef: item.workItemRef,
          slotRef: slot.slotRef,
          registrationRef: await module.commands.publishTool({
            typeRef,
            workItemRef: item.workItemRef,
            toolId: tool.id,
            actorUserId: 'author',
          }),
        })
      }
    }
  }
  const job = await module.commands.createJobTemplate({
    typeRef,
    actorUserId: 'author',
    body: {
      name: 'RFC-628 MR care job',
      description: 'Delivery, review, conflict and approval lanes',
      defaultToolBindings: bindings,
      defaultAdapterBindings: [
        { laneId: 'care-approval', slotRef: 'primary', adapterRef: APPROVAL_ADAPTER },
      ],
    },
  })
  const jobRef = await module.commands.publishJobTemplate({ id: job.id, actorUserId: 'author' })
  const employee = await module.commands.createEmployee({
    typeRef,
    actorUserId: 'author',
    body: {
      name: 'RFC-628 development employee',
      jobTemplateRef: jobRef,
      workScope: { kind: 'repository', repositoryId: RFC628_REPOSITORY },
      toolOverrides: [],
    },
  })

  // ------------------------------------------------------------ reads
  const { employeeCases, employeeReactionRounds, employeeContextRecords } = tablesOf(db)
  let caseId: string | null = null
  const requireCase = () => {
    if (caseId === null) throw new Error('RFC-628 runtime fixture has no launched case')
    return caseId
  }
  const caseRow = async () => {
    const [row] = await db
      .select({
        state: employeeCases.state,
        currentWorkItemRef: employeeCases.currentWorkItemRef,
        activeRoundId: employeeCases.activeRoundId,
        terminalKind: employeeCases.terminalKind,
        blockReason: employeeCases.blockReason,
      })
      .from(employeeCases)
      .where(eq(employeeCases.id, requireCase()))
    return row!
  }
  const rounds = async (): Promise<Rfc628Round[]> =>
    (
      await db
        .select({
          id: employeeReactionRounds.id,
          workItemRef: employeeReactionRounds.workItemRef,
          ruleId: employeeReactionRounds.ruleId,
          state: employeeReactionRounds.state,
          createdAt: employeeReactionRounds.createdAt,
        })
        .from(employeeReactionRounds)
        .where(eq(employeeReactionRounds.caseId, requireCase()))
    )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(({ id, workItemRef, ruleId, state }) => ({ id, workItemRef, ruleId, state }))
  const contextState = async <T>(typeId: string): Promise<T | null> => {
    const rows = (
      await db
        .select({
          typeId: employeeContextRecords.typeId,
          stateJson: employeeContextRecords.stateJson,
          updatedAt: employeeContextRecords.updatedAt,
        })
        .from(employeeContextRecords)
        .where(eq(employeeContextRecords.caseId, requireCase()))
    )
      .filter((row) => row.typeId === typeId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const stateJson = rows[0]?.stateJson
    if (stateJson === undefined) return null
    return (typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson) as T
  }
  const ledger = () =>
    contextState<{
      status: string
      sourceHeadSha: string
      publishedHeadSha: string | null
      commitSha: string | null
      threads: Array<{ threadRef: string; finalReply: unknown }>
    }>('development.review-resolution')

  // ------------------------------------------------------------ driving
  const steps: ReadonlyArray<() => Promise<boolean>> = [
    async () => await runtime.worker.pumpOneDelivery(),
    async () => (await runtime.worker.planOneReaction()) !== null,
    async () => (await runtime.worker.runOneOutbox()) !== 'idle',
    async () => (await runtime.worker.dispatchOneReaction()) !== 'idle',
    async () => {
      const inspected = await runtime.worker.inspectOneExecution()
      return inspected !== 'idle' && inspected !== 'pending'
    },
    async () => (await runtime.worker.publishOneChannelResult()) !== 'idle',
  ]
  const diagnostics = async () =>
    JSON.stringify({ case: await caseRow(), rounds: (await rounds()).slice(-6) })
  /** Run worker steps until the predicate holds before the next step (stop before planning it). */
  async function stepUntil(predicate: () => Promise<boolean>, budget = 600): Promise<void> {
    for (let turn = 0; turn < budget; turn += 1) {
      let progress = false
      for (const step of steps) {
        if (await predicate()) return
        if (await step()) progress = true
      }
      tick()
      if (!progress) {
        if (await predicate()) return
        if ((await caseRow()).activeRoundId !== null) {
          tick(1_000)
          continue
        }
        throw new Error(`RFC-628 case went idle before the expected point: ${await diagnostics()}`)
      }
    }
    throw new Error(`RFC-628 case exceeded the step budget: ${await diagnostics()}`)
  }
  /** Run worker steps until nothing is left to do (no step progresses and no round is active). */
  async function driveUntilIdle(budget = 600): Promise<void> {
    for (let turn = 0; turn < budget; turn += 1) {
      let progress = false
      for (const step of steps) if (await step()) progress = true
      tick()
      if (!progress) {
        if (caseId !== null && (await caseRow()).activeRoundId !== null) {
          tick(1_000)
          continue
        }
        return
      }
    }
    throw new Error(`RFC-628 case exceeded the step budget: ${await diagnostics()}`)
  }

  const nextIs = (workItemRef: string) => async () => {
    const row = await caseRow()
    return (
      row.state === 'active' && row.currentWorkItemRef === workItemRef && row.activeRoundId === null
    )
  }

  async function observeMrEvent(
    eventTypeId:
      | 'development.lifecycle-updated'
      | 'development.review-updated'
      | 'development.conflict-updated',
    dedupeKey: string,
  ): Promise<void> {
    tick()
    await eventCenter.commands.observe({
      sourceRef: { id: 'code-host.activity', revision: 1 },
      eventTypeRef: { id: eventTypeId, revision: 2 },
      subject: { typeId: 'merge-request', subjectRef: RFC628_MR_SUBJECT },
      occurredAt: now(),
      dedupeKey,
      summary: eventTypeId,
      payloadArtifactRef: null,
    })
    for (let index = 0; index < 8; index += 1) await runtime.worker.pumpOneDelivery()
  }
  async function observeApprovalEvent(dedupeKey: string): Promise<void> {
    const approval = await contextState<{ subjectRef: string | null }>('development.approval')
    if (approval?.subjectRef == null) throw new Error('RFC-628 case has no submitted approval')
    tick()
    await eventCenter.commands.observe({
      sourceRef: { id: 'development.approval-state', revision: 1 },
      eventTypeRef: { id: 'development.approval-updated', revision: 1 },
      subject: { typeId: 'external-approval', subjectRef: approval.subjectRef },
      occurredAt: now(),
      dedupeKey,
      summary: 'approval observation',
      payloadArtifactRef: null,
    })
    for (let index = 0; index < 8; index += 1) await runtime.worker.pumpOneDelivery()
  }

  return {
    typeRef,
    employee,
    host: {
      get head() {
        return host.head
      },
      /** Someone else moved the source branch. */
      foreignPush() {
        host.head = sha('f')
        return host.head
      },
      setState(state: 'opened' | 'merged' | 'closed') {
        host.state = state
      },
      setConflict(conflict: boolean) {
        host.mergeableState = conflict ? 'conflict' : 'mergeable'
      },
      addThread(threadRef: string, revision: string) {
        host.threads.push({
          threadRef,
          revision,
          resolved: false,
          body: `Please repair ${threadRef}.`,
          path: 'src/book.ts',
          messages: [
            {
              messageRef: `root-${threadRef}`,
              parentMessageRef: null,
              authorClass: 'human',
              body: `Please repair ${threadRef}.`,
              path: 'src/book.ts',
              createdAt: null,
            },
          ],
        })
      },
      resolveThread(threadRef: string) {
        host.threads.find((thread) => thread.threadRef === threadRef)!.resolved = true
      },
      failReplies(threadRef: string, fail = true) {
        if (fail) host.failingReplies.add(threadRef)
        else host.failingReplies.delete(threadRef)
      },
      /** Final "handled in commit …" replies posted into a thread. */
      resolvedReplies(threadRef: string) {
        return (
          host.threads
            .find((thread) => thread.threadRef === threadRef)
            ?.messages.filter((message) => message.body.includes(':review-resolved:')) ?? []
        )
      },
      /** "Received" acknowledgements posted into a thread. */
      receivedReplies(threadRef: string) {
        return (
          host.threads
            .find((thread) => thread.threadRef === threadRef)
            ?.messages.filter((message) => message.body.includes(':review-received:')) ?? []
        )
      },
      replyAttempts: host.replyAttempts,
    },
    approvals: {
      get submits() {
        return approvalSubmits
      },
      setStatus(status: 'pending' | 'approved' | 'rejected') {
        approvalStatus = status
      },
    },
    workspaceRebuilds,
    agentRuns,
    setReviewMode(mode: 'code' | 'reply-only') {
      reviewMode = mode
    },
    async launch(): Promise<string> {
      const launched = await runtime.commands.launchWork({
        employeeId: employee.id,
        actorUserId: null,
        intake: {
          name: 'RFC-628 booking change',
          kind: 'body',
          target: { repositoryId: RFC628_REPOSITORY },
          body: 'Reject a booking for an occupied slot.',
          externalId: null,
          uploads: [],
          idempotencyKey: `rfc628-launch-${nextId()}`,
        },
      })
      caseId = launched.caseRef.id
      return caseId
    },
    async resume() {
      await runtime.commands.resume(requireCase())
    },
    caseRow,
    rounds,
    ledger,
    contextState,
    stepUntil,
    driveUntilIdle,
    nextIs,
    observeMrEvent,
    observeApprovalEvent,
  }
}

export type Rfc628Runtime = Awaited<ReturnType<typeof createRfc628Runtime>>
