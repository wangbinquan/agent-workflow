// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the case was resumed, an event that declares preemption
// (the lifecycle update caused by the employee's own push) took the round instead. "Observe merge
// request" then went on to approval or readiness, its frozen successors did not even contain the
// reply, and the reply prepared in the review-resolution ledger was never posted.
//
// RFC-628 (design §3.3, §3.4) lets the settlement finish the previous round from the ledger first:
// terminal → freeze the uncommitted repair again → repair a real conflict → reply → collect new
// feedback (on any trigger) → the original fallback; observe-approval does the same two follow-ups
// while the approval is pending; publish-mr replies only when the ledger was marked published; a
// reply-only repair records its judged head as published. Every new branch is gated on the frozen
// successor list or the type revision, so development@11 and graph-development@2 settle exactly as
// before. This file locks design §6 B1–B8, C1, D1, D2 and the settlement half of E6, each run
// against the new successor lists (development@12, graph-development@3) and the old ones written out
// explicitly (development@11, graph-development@2).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { developmentEmployeeRuntimeCodec } from '@/modules/development-automation/application/employeeTypePackage'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { composeGraphDeliveryLifecycleRuntimeCodec } from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import { MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS } from '@/modules/development-automation/domain/mergeRequestLifecycle'

const graph = composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec)

/** The head the review feedback was collected against (the ledger's source head). */
const REVIEWED_HEAD = 'a'.repeat(40)
const TARGET = 'b'.repeat(40)
/** The commit the employee pushed its review repair in. */
const PUSHED_HEAD = 'd'.repeat(40)
/** Someone else moved the source branch: the platform rebuilt the workspace. */
const FOREIGN_HEAD = 'e'.repeat(40)
const NONCE = 'c'.repeat(64)

// design §3.2: the successors before and after the revision bump, written out so that a frozen
// historical revision is tested with the exact list it was frozen with.
const OBSERVE_MR_OLD = [
  'classify-feedback',
  'collect-pipeline',
  'repair-conflict',
  'prepare-approval',
  'evaluate-ready',
]
const OBSERVE_MR_NEW = [...OBSERVE_MR_OLD, 'reply-feedback', 'prepare-change']
const OBSERVE_APPROVAL_OLD = ['observe-mr']
const OBSERVE_APPROVAL_NEW = ['observe-mr', 'reply-feedback', 'prepare-change']
const PUBLISH_MR = ['observe-mr', 'reply-feedback']
const REPLY_FEEDBACK = ['observe-mr']
const REVIEW_LANE = [
  'classify-feedback',
  'acknowledge-feedback',
  'repair-feedback',
  'reply-feedback',
]

interface Flavor {
  readonly name: string
  readonly codec: typeof developmentEmployeeRuntimeCodec | typeof graph
  readonly typeRef: { readonly typeId: string; readonly revision: number }
  readonly successors: Readonly<Record<string, readonly string[]>>
}
const flavor = (
  name: string,
  codec: Flavor['codec'],
  typeRef: Flavor['typeRef'],
  modern: boolean,
): Flavor => ({
  name,
  codec,
  typeRef,
  successors: {
    'observe-mr': modern ? OBSERVE_MR_NEW : OBSERVE_MR_OLD,
    'observe-approval': modern ? OBSERVE_APPROVAL_NEW : OBSERVE_APPROVAL_OLD,
    'publish-mr': PUBLISH_MR,
    'reply-feedback': REPLY_FEEDBACK,
  },
})
const DEVELOPMENT_NEW = flavor(
  'development@12',
  developmentEmployeeRuntimeCodec,
  { typeId: 'development', revision: 12 },
  true,
)
const DEVELOPMENT_OLD = flavor(
  'development@11',
  developmentEmployeeRuntimeCodec,
  { typeId: 'development', revision: 11 },
  false,
)
const GRAPH_NEW = flavor(
  'graph-development@3',
  graph,
  { typeId: 'graph-development', revision: 3 },
  true,
)
const GRAPH_OLD = flavor(
  'graph-development@2',
  graph,
  { typeId: 'graph-development', revision: 2 },
  false,
)

function context(typeId: string, state: unknown, id = `${typeId}-context`) {
  return {
    id,
    revision: 1,
    schemaVersion: 1,
    typeId,
    lifecycleState: 'active',
    stateJson: JSON.stringify(state),
    artifactRefs: [] as string[],
  }
}
type Context = ReturnType<typeof context>

interface Thread {
  readonly threadRef: string
  readonly revision: string
  readonly authorClass: 'human' | 'bot' | 'self'
  readonly resolved: boolean
  readonly body: string
  readonly path: string | null
  readonly messages: readonly never[]
}
/** The thread revision the ledger already records. */
const knownThread: Thread = {
  threadRef: 'review-1',
  revision: '1:4',
  authorClass: 'human',
  resolved: false,
  body: 'Does an occupied time slot reject a duplicate booking?',
  path: 'src/book.ts',
  messages: [],
}
/** A thread revision the ledger has never recorded: new feedback. */
const newThread: Thread = {
  threadRef: 'review-2',
  revision: '2:7',
  authorClass: 'human',
  resolved: false,
  body: 'Please also cover cancelled bookings.',
  path: 'src/cancel.ts',
  messages: [],
}
const NO_NEW = [knownThread]
/** The reviewer only resolved the thread: a review event without new feedback. */
const ONLY_RESOLVED = [{ ...knownThread, resolved: true }]
const WITH_NEW = [knownThread, newThread]

function mergeRequest(input: {
  readonly headSha: string
  readonly threads?: readonly Thread[]
  readonly mergeableState?: 'mergeable' | 'conflict' | 'unknown'
  readonly status?: 'active' | 'merged' | 'closed'
}): Context {
  const threads = input.threads ?? NO_NEW
  return context('development.merge-request', {
    status: input.status ?? 'active',
    mergeRequestRef: 'repo!42',
    headSha: input.headSha,
    targetSha: TARGET,
    issueHandlingContextRef: 'development.issue-handling-context',
    readyToMerge: false,
    mergeableState: input.mergeableState ?? 'mergeable',
    // No external approval is required, so the original fallback is always evaluate-ready.
    approvalHold: false,
    unresolvedReviewCount: threads.filter(
      (thread) => !thread.resolved && thread.authorClass !== 'self',
    ).length,
    reviewThreads: threads,
    repositoryRef: 'repo',
    providerMrRef: '42',
  })
}

const preparedRow = {
  threadRef: knownThread.threadRef,
  revision: knownThread.revision,
  acknowledgement: { marker: 'case-1:review-received:known', noteRef: 'note-5' },
  disposition: 'addressed',
  replyBody: 'The booking rule now rejects an occupied slot.',
  finalReply: null,
}
type LedgerKind = 'reply-pending' | 'commit-pending' | 'replied'
function ledgerState(kind: LedgerKind) {
  return kind === 'reply-pending'
    ? {
        status: 'prepared',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: REVIEWED_HEAD,
        publishedHeadSha: PUSHED_HEAD,
        commitSha: null,
        threads: [preparedRow],
      }
    : kind === 'commit-pending'
      ? {
          status: 'prepared',
          mergeRequestRef: 'repo!42',
          sourceHeadSha: REVIEWED_HEAD,
          publishedHeadSha: null,
          commitSha: null,
          threads: [preparedRow],
        }
      : {
          status: 'replied',
          mergeRequestRef: 'repo!42',
          sourceHeadSha: REVIEWED_HEAD,
          publishedHeadSha: PUSHED_HEAD,
          commitSha: PUSHED_HEAD,
          threads: [
            {
              ...preparedRow,
              finalReply: { marker: 'case-1:review-resolved:known', noteRef: 'note-9' },
            },
          ],
        }
}
const ledger = (kind: LedgerKind) => context('development.review-resolution', ledgerState(kind))

const approval = () =>
  context('development.approval', {
    status: 'pending',
    mergeRequestRef: 'repo!42',
    headSha: PUSHED_HEAD,
    approvalType: 'gate-change',
    adapterRef: { id: 'approval-adapter', revision: 1 },
    validatedDraftRef: 'approval-draft:1',
    draft: 'Please approve the gate change.',
    subjectRef: 'approval-subject-1',
    deadlineAt: '2026-12-31T00:00:00.000Z',
    idempotencyKey: 'f'.repeat(64),
    correlationRef: 'approval-correlation-1',
    externalRequestRef: 'APP-1',
    submittedRevision: 'submit-1',
    observedRevision: null,
    evidenceRef: null,
  })

/** 'continuation' is the event a continuation round carries (runtimeService.ts:3247-3253). */
type Trigger =
  | 'continuation'
  | 'development.lifecycle-updated'
  | 'development.review-updated'
  | 'development.conflict-updated'
  | 'development.approval-updated'
function eventJson(trigger: Trigger, workItemRef: string): string {
  return JSON.stringify(
    trigger === 'continuation'
      ? { kind: 'work-item-continuation', caseId: 'case-1', workItemRef }
      : {
          id: 'inbox-1',
          eventTypeRef: {
            id: trigger,
            revision: trigger === 'development.approval-updated' ? 1 : 2,
          },
          state: 'pending',
        },
  )
}

interface Settled {
  readonly caseState: string
  readonly nextWorkItemRef: string | null
  readonly terminalKind: string | null
  readonly contextPatches: ReadonlyArray<{ contextTypeId: string; stateJson: string }>
}
function settle(
  target: Flavor,
  input: {
    readonly workItemRef: string
    readonly contexts: readonly Context[]
    readonly trigger?: Trigger
    readonly status?: 'ok' | 'needs-input' | 'blocked'
    readonly summary?: string
    readonly contextPatches?: readonly object[]
    readonly enabled?: readonly string[]
  },
): Settled {
  const contextsJson = JSON.stringify(input.contexts)
  return JSON.parse(
    target.codec.resolveReactionSettlementJson(
      JSON.stringify({
        schemaVersion: 1,
        employeeTypeRef: target.typeRef,
        workItemRef: input.workItemRef,
        toolSlotRef: 'system',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          roundRef: `round-${input.workItemRef}`,
          executionNonce: NONCE,
          status: input.status ?? 'ok',
          summary: input.summary ?? `${input.workItemRef} completed`,
          contextPatches: input.contextPatches ?? [],
          effectSuggestions: [],
          artifactRefs: [],
        }),
        contextsJson,
        inputEnvelopeJson: JSON.stringify({
          contextsJson,
          contractInput: {},
          eventJson: eventJson(input.trigger ?? 'continuation', input.workItemRef),
        }),
        enabledWorkItemRefsJson: JSON.stringify(
          input.enabled ?? MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS,
        ),
        allowedNextWorkItemRefs: target.successors[input.workItemRef] ?? [],
      }),
    ),
  ) as Settled
}

interface Expectation {
  readonly caseState: string
  readonly nextWorkItemRef: string | null
  readonly terminalKind?: string | null
}
const next = (workItemRef: string): Expectation => ({
  caseState: 'active',
  nextWorkItemRef: workItemRef,
})
const WAITING: Expectation = { caseState: 'waiting', nextWorkItemRef: null }
const BLOCKED: Expectation = { caseState: 'blocked', nextWorkItemRef: null }
const terminal = (kind: 'merged' | 'closed'): Expectation => ({
  caseState: 'terminal',
  nextWorkItemRef: null,
  terminalKind: kind,
})

interface Case {
  readonly name: string
  readonly workItemRef: string
  readonly contexts: () => readonly Context[]
  readonly trigger?: Trigger
  readonly status?: 'ok' | 'needs-input' | 'blocked'
  readonly summary?: string
  readonly contextPatches?: () => readonly object[]
  /** The new successor list / revision (development@12, graph-development@3). */
  readonly modern: Expectation
  /** The frozen list / revision (development@11, graph-development@2): the pre-fix result. */
  readonly frozen: Expectation
}

const replyPendingMr = (threads: readonly Thread[] = NO_NEW, mergeableState?: 'conflict') =>
  mergeRequest({ headSha: PUSHED_HEAD, threads, ...(mergeableState ? { mergeableState } : {}) })
const commitPendingMr = (threads: readonly Thread[] = NO_NEW, mergeableState?: 'conflict') =>
  mergeRequest({
    headSha: REVIEWED_HEAD,
    threads,
    ...(mergeableState ? { mergeableState } : {}),
  })
const movedMr = (threads: readonly Thread[] = NO_NEW, mergeableState?: 'conflict') =>
  mergeRequest({ headSha: FOREIGN_HEAD, threads, ...(mergeableState ? { mergeableState } : {}) })

// B1: the reply is pending (prepared and published) when the event takes the round.
const B1: readonly Case[] = [
  {
    name: 'reply pending × lifecycle update → reply',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [replyPendingMr(), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'reply pending × review update without new feedback → reply',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [replyPendingMr(ONLY_RESOLVED), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'reply pending × review update with new feedback → reply first (step 4 before step 5)',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [replyPendingMr(WITH_NEW), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('classify-feedback'),
  },
  {
    name: 'reply pending × conflict update without a conflict → reply',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [replyPendingMr(), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'reply pending × continuation → reply',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [replyPendingMr(), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'reply pending × continuation with new feedback → reply before collecting',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [replyPendingMr(WITH_NEW), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'reply pending × conflict update with a real conflict → repair the conflict first (step 3 before step 4)',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [replyPendingMr(NO_NEW, 'conflict'), ledger('reply-pending')],
    modern: next('repair-conflict'),
    frozen: next('repair-conflict'),
  },
]

// B2: the repair is prepared but not committed when the event takes the round.
const B2: readonly Case[] = [
  {
    name: 'commit pending, head unchanged × lifecycle update → freeze the change again',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [commitPendingMr(), ledger('commit-pending')],
    modern: next('prepare-change'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'commit pending, head unchanged × review update without new feedback → freeze again',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [commitPendingMr(ONLY_RESOLVED), ledger('commit-pending')],
    modern: next('prepare-change'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'commit pending, head unchanged × review update with new feedback → freeze again first',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [commitPendingMr(WITH_NEW), ledger('commit-pending')],
    modern: next('prepare-change'),
    frozen: next('classify-feedback'),
  },
  {
    name: 'commit pending, head unchanged × real conflict → freeze again before repairing it (step 2 before step 3)',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [commitPendingMr(NO_NEW, 'conflict'), ledger('commit-pending')],
    modern: next('prepare-change'),
    frozen: next('repair-conflict'),
  },
  {
    name: 'commit pending, head unchanged × continuation → freeze again',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [commitPendingMr(), ledger('commit-pending')],
    modern: next('prepare-change'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'commit pending, head moved × lifecycle update → no follow-up, original fallback',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [movedMr(), ledger('commit-pending')],
    modern: next('evaluate-ready'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'commit pending, head moved × review update with new feedback → collect it',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [movedMr(WITH_NEW), ledger('commit-pending')],
    modern: next('classify-feedback'),
    frozen: next('classify-feedback'),
  },
  {
    name: 'commit pending, head moved × real conflict → repair the conflict',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [movedMr(NO_NEW, 'conflict'), ledger('commit-pending')],
    modern: next('repair-conflict'),
    frozen: next('repair-conflict'),
  },
  {
    name: 'commit pending, head moved × continuation with new feedback → collect it (new revision only)',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [movedMr(WITH_NEW), ledger('commit-pending')],
    modern: next('classify-feedback'),
    frozen: next('evaluate-ready'),
  },
]

// B3: a merged or closed MR ends the case before any follow-up, for both kinds of ledger.
const B3: readonly Case[] = [
  {
    name: 'reply pending × lifecycle update showing merged → terminal',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [
      mergeRequest({ headSha: PUSHED_HEAD, status: 'merged' }),
      ledger('reply-pending'),
    ],
    modern: terminal('merged'),
    frozen: terminal('merged'),
  },
  {
    name: 'reply pending × lifecycle update showing closed → terminal',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [
      mergeRequest({ headSha: PUSHED_HEAD, status: 'closed' }),
      ledger('reply-pending'),
    ],
    modern: terminal('closed'),
    frozen: terminal('closed'),
  },
  {
    name: 'commit pending × lifecycle update showing merged → terminal',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [
      mergeRequest({ headSha: REVIEWED_HEAD, status: 'merged' }),
      ledger('commit-pending'),
    ],
    modern: terminal('merged'),
    frozen: terminal('merged'),
  },
  {
    name: 'commit pending × lifecycle update showing closed → terminal',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [
      mergeRequest({ headSha: REVIEWED_HEAD, status: 'closed' }),
      ledger('commit-pending'),
    ],
    modern: terminal('closed'),
    frozen: terminal('closed'),
  },
]

// B4: step 5 does not look at the trigger in the new revision, and does not loop.
const repliedMr = (threads: readonly Thread[] = NO_NEW, mergeableState?: 'conflict') =>
  mergeRequest({ headSha: PUSHED_HEAD, threads, ...(mergeableState ? { mergeableState } : {}) })
const B4: readonly Case[] = [
  {
    name: 'replied ledger, unrecorded open thread × continuation → collect it',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [repliedMr(WITH_NEW), ledger('replied')],
    modern: next('classify-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'replied ledger, unrecorded open thread × lifecycle update → collect it',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [repliedMr(WITH_NEW), ledger('replied')],
    modern: next('classify-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'replied ledger, unrecorded open thread × conflict update without a conflict → collect it',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [repliedMr(WITH_NEW), ledger('replied')],
    modern: next('classify-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'replied ledger, unrecorded open thread × review update → collect it (unchanged)',
    workItemRef: 'observe-mr',
    trigger: 'development.review-updated',
    contexts: () => [repliedMr(WITH_NEW), ledger('replied')],
    modern: next('classify-feedback'),
    frozen: next('classify-feedback'),
  },
  {
    name: 'no ledger yet, open thread × continuation → collect it',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [repliedMr([newThread])],
    modern: next('classify-feedback'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'replied ledger, every open thread already recorded × continuation → fallback (no loop)',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [repliedMr(NO_NEW), ledger('replied')],
    modern: next('evaluate-ready'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'replied ledger, every open thread already recorded × lifecycle update → fallback (no loop)',
    workItemRef: 'observe-mr',
    trigger: 'development.lifecycle-updated',
    contexts: () => [repliedMr(NO_NEW), ledger('replied')],
    modern: next('evaluate-ready'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'continuation round, real conflict, nothing pending → fallback (step 3 stays event-bound)',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [repliedMr(NO_NEW, 'conflict'), ledger('replied')],
    modern: next('evaluate-ready'),
    frozen: next('evaluate-ready'),
  },
  {
    name: 'conflict update with a real conflict and new feedback → repair the conflict first (step 3 before step 5)',
    workItemRef: 'observe-mr',
    trigger: 'development.conflict-updated',
    contexts: () => [repliedMr(WITH_NEW, 'conflict'), ledger('replied')],
    modern: next('repair-conflict'),
    frozen: next('repair-conflict'),
  },
]

// B7: observe-approval finishes the previous round while the approval is still pending.
const approvalContexts = (mr: Context, kind?: LedgerKind) => [
  mr,
  ...(kind === undefined ? [] : [ledger(kind)]),
  approval(),
]
const B7: readonly Case[] = [
  {
    name: 'approval pending × reply pending → active, reply',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    summary: '外部审批仍在进行中',
    contexts: () => approvalContexts(replyPendingMr(), 'reply-pending'),
    modern: next('reply-feedback'),
    frozen: WAITING,
  },
  {
    name: 'approval pending × commit pending → active, freeze the change again',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    summary: '外部审批仍在进行中',
    contexts: () => approvalContexts(commitPendingMr(), 'commit-pending'),
    modern: next('prepare-change'),
    frozen: WAITING,
  },
  {
    name: 'approval temporarily unobservable × reply pending → active, reply',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    summary: '外部审批暂时无法观察：approval-unavailable · retry later',
    contexts: () => approvalContexts(replyPendingMr(), 'reply-pending'),
    modern: next('reply-feedback'),
    frozen: WAITING,
  },
  {
    name: 'approval temporarily unobservable × commit pending → active, freeze again',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    summary: '外部审批暂时无法观察：approval-unavailable · retry later',
    contexts: () => approvalContexts(commitPendingMr(), 'commit-pending'),
    modern: next('prepare-change'),
    frozen: WAITING,
  },
  {
    name: 'approval pending, replied ledger → wait',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    contexts: () => approvalContexts(repliedMr(), 'replied'),
    modern: WAITING,
    frozen: WAITING,
  },
  {
    name: 'approval pending, no ledger → wait',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    contexts: () => approvalContexts(replyPendingMr()),
    modern: WAITING,
    frozen: WAITING,
  },
  {
    name: 'approval pending, commit pending but the head moved → wait',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'needs-input',
    contexts: () => approvalContexts(movedMr(), 'commit-pending'),
    modern: WAITING,
    frozen: WAITING,
  },
  {
    name: 'approval approved (ok) × reply pending → observe-mr (explicit branch, both lists)',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'ok',
    contexts: () => approvalContexts(replyPendingMr(), 'reply-pending'),
    modern: next('observe-mr'),
    frozen: next('observe-mr'),
  },
  {
    name: 'approval approved (ok) × commit pending → observe-mr',
    workItemRef: 'observe-approval',
    trigger: 'continuation',
    status: 'ok',
    contexts: () => approvalContexts(commitPendingMr(), 'commit-pending'),
    modern: next('observe-mr'),
    frozen: next('observe-mr'),
  },
  {
    name: 'approval rejected, expired or unavailable (blocked) × reply pending → blocked',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'blocked',
    summary: '外部审批已驳回',
    contexts: () => approvalContexts(replyPendingMr(), 'reply-pending'),
    modern: BLOCKED,
    frozen: BLOCKED,
  },
  {
    name: 'approval blocked × commit pending → blocked',
    workItemRef: 'observe-approval',
    trigger: 'development.approval-updated',
    status: 'blocked',
    summary: '外部审批已过期',
    contexts: () => approvalContexts(commitPendingMr(), 'commit-pending'),
    modern: BLOCKED,
    frozen: BLOCKED,
  },
]

// B8: publish-mr replies only when the ledger was marked published (new revision).
const markPublished = () => {
  const current = ledger('commit-pending')
  return [
    {
      contextId: current.id,
      contextTypeId: 'development.review-resolution',
      schemaVersion: 1,
      expectedRevision: current.revision,
      lifecycleState: 'active',
      stateJson: JSON.stringify({
        ...ledgerState('commit-pending'),
        publishedHeadSha: PUSHED_HEAD,
      }),
      artifactRefs: [],
    },
  ]
}
const B8: readonly Case[] = [
  {
    name: 'prepared ledger not marked published → observe-mr (revision 11: reply)',
    workItemRef: 'publish-mr',
    contexts: () => [mergeRequest({ headSha: PUSHED_HEAD }), ledger('commit-pending')],
    modern: next('observe-mr'),
    frozen: next('reply-feedback'),
  },
  {
    name: 'prepared ledger already marked published → reply',
    workItemRef: 'publish-mr',
    contexts: () => [mergeRequest({ headSha: PUSHED_HEAD }), ledger('reply-pending')],
    modern: next('reply-feedback'),
    frozen: next('reply-feedback'),
  },
  {
    name: 'prepared ledger marked published by this round’s patch → reply',
    workItemRef: 'publish-mr',
    contexts: () => [mergeRequest({ headSha: PUSHED_HEAD }), ledger('commit-pending')],
    contextPatches: markPublished,
    modern: next('reply-feedback'),
    frozen: next('reply-feedback'),
  },
  {
    name: 'no ledger → observe-mr',
    workItemRef: 'publish-mr',
    contexts: () => [mergeRequest({ headSha: PUSHED_HEAD })],
    modern: next('observe-mr'),
    frozen: next('observe-mr'),
  },
  {
    name: 'replied ledger → observe-mr',
    workItemRef: 'publish-mr',
    contexts: () => [mergeRequest({ headSha: PUSHED_HEAD }), ledger('replied')],
    modern: next('observe-mr'),
    frozen: next('observe-mr'),
  },
]

// E6 (settlement half): a reply that finds the MR merged completes without posting; its only
// successor observe-mr then ends the case.
const E6: readonly Case[] = [
  {
    name: 'reply-feedback that skipped posting on a merged MR → observe-mr',
    workItemRef: 'reply-feedback',
    summary: 'MR 已合入，不再回复修复结果',
    contexts: () => [
      mergeRequest({ headSha: PUSHED_HEAD, status: 'merged' }),
      ledger('reply-pending'),
    ],
    modern: next('observe-mr'),
    frozen: next('observe-mr'),
  },
  {
    name: 'the continuation observe-mr after it sees the merged MR → terminal, no reply',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [
      mergeRequest({ headSha: PUSHED_HEAD, status: 'merged' }),
      ledger('reply-pending'),
    ],
    modern: terminal('merged'),
    frozen: terminal('merged'),
  },
  {
    name: 'the continuation observe-mr after it sees the closed MR → terminal, no reply',
    workItemRef: 'observe-mr',
    trigger: 'continuation',
    contexts: () => [
      mergeRequest({ headSha: PUSHED_HEAD, status: 'closed' }),
      ledger('reply-pending'),
    ],
    modern: terminal('closed'),
    frozen: terminal('closed'),
  },
]

function run(target: Flavor, item: Case, expected: Expectation) {
  const settled = settle(target, {
    workItemRef: item.workItemRef,
    contexts: item.contexts(),
    ...(item.trigger === undefined ? {} : { trigger: item.trigger }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.contextPatches === undefined ? {} : { contextPatches: item.contextPatches() }),
  })
  expect(settled).toMatchObject({
    caseState: expected.caseState,
    nextWorkItemRef: expected.nextWorkItemRef,
    ...(expected.terminalKind === undefined ? {} : { terminalKind: expected.terminalKind }),
  })
}

const groups: ReadonlyArray<readonly [string, readonly Case[]]> = [
  ['B1 reply pending', B1],
  ['B2 commit pending', B2],
  ['B3 merged or closed', B3],
  ['B4 step 5', B4],
  ['B7 observe-approval', B7],
  ['B8 publish-mr', B8],
  ['E6 reply on a merged MR', E6],
]

describe('RFC-628 settlement with the new successor lists (development@12)', () => {
  for (const [group, cases] of groups) {
    describe(group, () => {
      for (const item of cases) {
        test(item.name, () => run(DEVELOPMENT_NEW, item, item.modern))
      }
    })
  }
})

describe('RFC-628 B5 development@11 with its frozen lists settles exactly as before the fix', () => {
  for (const [group, cases] of groups) {
    describe(group, () => {
      for (const item of cases) {
        test(item.name, () => run(DEVELOPMENT_OLD, item, item.frozen))
      }
    })
  }
})

describe('RFC-628 C1 graph-development@3 shares the same care settlement', () => {
  for (const [group, cases] of groups) {
    describe(group, () => {
      for (const item of cases) {
        test(item.name, () => run(GRAPH_NEW, item, item.modern))
      }
    })
  }
})

describe('RFC-628 C1 graph-development@2 with its frozen lists settles exactly as before the fix', () => {
  for (const [group, cases] of groups) {
    describe(group, () => {
      for (const item of cases) {
        test(item.name, () => run(GRAPH_OLD, item, item.frozen))
      }
    })
  }
})

describe('RFC-628 B6 a disabled review lane takes none of the follow-ups', () => {
  const enabled = MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS.filter(
    (workItemRef) => !REVIEW_LANE.includes(workItemRef),
  )
  for (const target of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    test(`${target.name}: steps 2, 4 and 5 stay off; the conflict step still works`, () => {
      const observe = (contexts: readonly Context[], trigger: Trigger) =>
        settle(target, { workItemRef: 'observe-mr', contexts, trigger, enabled })
      expect(
        observe([replyPendingMr(), ledger('reply-pending')], 'development.lifecycle-updated'),
      ).toMatchObject(next('evaluate-ready'))
      expect(observe([replyPendingMr(), ledger('reply-pending')], 'continuation')).toMatchObject(
        next('evaluate-ready'),
      )
      expect(
        observe([commitPendingMr(), ledger('commit-pending')], 'development.lifecycle-updated'),
      ).toMatchObject(next('evaluate-ready'))
      expect(observe([commitPendingMr(), ledger('commit-pending')], 'continuation')).toMatchObject(
        next('evaluate-ready'),
      )
      expect(observe([repliedMr(WITH_NEW), ledger('replied')], 'continuation')).toMatchObject(
        next('evaluate-ready'),
      )
      expect(
        observe([repliedMr(WITH_NEW), ledger('replied')], 'development.review-updated'),
      ).toMatchObject(next('evaluate-ready'))
      expect(
        observe(
          [commitPendingMr(NO_NEW, 'conflict'), ledger('commit-pending')],
          'development.conflict-updated',
        ),
      ).toMatchObject(next('repair-conflict'))
      for (const kind of ['reply-pending', 'commit-pending'] as const) {
        expect(
          settle(target, {
            workItemRef: 'observe-approval',
            trigger: 'development.approval-updated',
            status: 'needs-input',
            contexts: approvalContexts(
              kind === 'reply-pending' ? replyPendingMr() : commitPendingMr(),
              kind,
            ),
            enabled,
          }),
        ).toMatchObject(WAITING)
      }
    })
  }
})

// D1 / D2: the repair-feedback output validation records the published head of a reply-only round.
describe('RFC-628 D1/D2 repair-feedback validation records what a reply-only round published', () => {
  const deliveryContent = {
    commitMessage: 'fix: keep the reviewed booking rule',
    mergeRequestTitle: 'Apply the reviewed booking rule',
    mergeRequestDescription: 'Implements the reviewed booking rule.',
  }
  const issue = () =>
    context('development.issue-handling', {
      status: 'active',
      subjectRef: 'case:case-1',
      repositoryRef: 'repo',
      request: { kind: 'body', body: 'Avoid duplicate bookings', externalId: null, uploads: [] },
      materialArtifactRefs: [],
      deliveryContent,
    })
  const selectedThread = { ...knownThread, messages: [] }
  const problemSet = () =>
    context('development.problem-set', {
      status: 'active',
      source: 'review',
      headSha: REVIEWED_HEAD,
      remainingTypes: ['review'],
      problems: [
        {
          problemId: selectedThread.threadRef,
          type: 'review',
          summary: selectedThread.body,
          evidenceArtifactRefs: [],
          reviewThread: selectedThread,
        },
      ],
    })
  // An earlier round's replied row is kept; an unfinished row that is not in this round's
  // problem set is removed (unchanged by RFC-628, employeeTypePackage.ts:4760).
  const repliedEarlier = {
    threadRef: 'review-0',
    revision: '0:2',
    acknowledgement: { marker: 'case-1:review-received:old', noteRef: 'note-1' },
    disposition: 'addressed',
    replyBody: 'Handled in an earlier round.',
    finalReply: { marker: 'case-1:review-resolved:old', noteRef: 'note-2' },
  }
  const unfinishedStale = {
    threadRef: 'review-9',
    revision: '9:1',
    acknowledgement: { marker: 'case-1:review-received:stale', noteRef: 'note-3' },
    disposition: null,
    replyBody: null,
    finalReply: null,
  }
  const acknowledgedSelected = {
    threadRef: selectedThread.threadRef,
    revision: selectedThread.revision,
    acknowledgement: { marker: 'case-1:review-received:known', noteRef: 'note-5' },
    disposition: null,
    replyBody: null,
    finalReply: null,
  }
  const acknowledgedLedger = () =>
    context('development.review-resolution', {
      status: 'acknowledged',
      mergeRequestRef: 'repo!42',
      sourceHeadSha: REVIEWED_HEAD,
      publishedHeadSha: null,
      commitSha: null,
      threads: [repliedEarlier, unfinishedStale, acknowledgedSelected],
    })
  const replyText = 'The existing booking rule already rejects an occupied slot.'
  function validate(
    target: Flavor,
    options: { readonly commitMessage?: string; readonly withMergeRequest?: boolean } = {},
  ) {
    const contexts = [
      issue(),
      ...(options.withMergeRequest === false ? [] : [mergeRequest({ headSha: REVIEWED_HEAD })]),
      problemSet(),
      acknowledgedLedger(),
    ]
    const validated = JSON.parse(
      target.codec.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: target.typeRef,
          workItemRef: 'repair-feedback',
          toolSlotRef: 'default',
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify(contexts),
            contractInput: {},
            platformPaths: {
              requirementDirectory: '.agent-workflow/inputs/requirements/case-1',
              externalMaterialDirectory: '.agent-workflow/inputs/requirements/case-1/external',
              pipelineDirectory: '.agent-workflow/pipeline/case-1',
              implementationPlanPath: '.agent-workflow/inputs/requirements/case-1/plan.md',
            },
          }),
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-repair',
            executionNonce: NONCE,
            directResult: {
              outcome: 'completed',
              ...(options.commitMessage === undefined
                ? {}
                : { commitMessage: options.commitMessage }),
              replies: [{ threadRef: selectedThread.threadRef, reply: replyText }],
            },
          }),
        }),
      ),
    ) as { contextPatches: Array<{ contextTypeId: string; stateJson: string }> }
    const patch = validated.contextPatches.find(
      (candidate) => candidate.contextTypeId === 'development.review-resolution',
    )
    if (patch === undefined) throw new Error('repair-feedback produced no review-resolution patch')
    return JSON.parse(patch.stateJson) as {
      status: string
      mergeRequestRef: string
      sourceHeadSha: string
      publishedHeadSha: string | null
      commitSha: string | null
      threads: Array<{ threadRef: string; finalReply: unknown; replyBody: string | null }>
    }
  }
  const expectedThreads = [
    repliedEarlier,
    { ...acknowledgedSelected, disposition: 'addressed', replyBody: replyText, finalReply: null },
  ]

  for (const target of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    test(`D1 ${target.name}: a reply-only round records the judged MR head as published`, () => {
      expect(validate(target)).toEqual({
        status: 'prepared',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: REVIEWED_HEAD,
        publishedHeadSha: REVIEWED_HEAD,
        commitSha: null,
        threads: expectedThreads,
      })
    })

    test(`D1 ${target.name}: a round that changed code stays unpublished until publish-mr marks it`, () => {
      expect(validate(target, { commitMessage: 'fix: reject an occupied slot' })).toEqual({
        status: 'prepared',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: REVIEWED_HEAD,
        publishedHeadSha: null,
        commitSha: null,
        threads: expectedThreads,
      })
    })

    test(`D1 ${target.name}: a reply-only round without an MR context records nothing as published`, () => {
      expect(validate(target, { withMergeRequest: false }).publishedHeadSha).toBeNull()
    })
  }

  for (const target of [DEVELOPMENT_OLD, GRAPH_OLD]) {
    test(`D2 ${target.name}: the same inputs keep publishedHeadSha empty`, () => {
      for (const options of [{}, { commitMessage: 'fix: reject an occupied slot' }]) {
        expect(validate(target, options)).toEqual({
          status: 'prepared',
          mergeRequestRef: 'repo!42',
          sourceHeadSha: REVIEWED_HEAD,
          publishedHeadSha: null,
          commitSha: null,
          threads: expectedThreads,
        })
      }
    })
  }

  // The second validation pass re-checks the platform's own ledger patch (design §3.4: the
  // published head must equal the value the first pass computed, not merely be empty). The patch
  // is written by the platform itself and a tool cannot submit one (it is rejected up front), so
  // the rejection branch has no black-box input; this source assertion keeps the comparison from
  // silently reverting to "must be empty", which would reject every reply-only round above.
  test('D1 the re-check compares publishedHeadSha with the expected value, not with null', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '../src/modules/development-automation/application/employeeTypePackage.ts',
      ),
      'utf8',
    )
    expect(source).not.toContain('proposed.publishedHeadSha !== null')
    expect(source).toMatch(/proposed\.publishedHeadSha !== (?!null\b)[A-Za-z_$][\w$.]*/)
  })
})
