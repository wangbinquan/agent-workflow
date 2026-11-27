// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the case was resumed, an event that declares preemption
// took the round instead and the prepared reply was never posted. RFC-628 lets "observe merge
// request" come back to the reply later, so the platform work items have to make that late reply
// correct (design §3.5):
// - publish-mr marks the ledger published only when this candidate grew from the ledger's source
//   head (otherwise the review repair may have been lost with a rebuilt workspace);
// - reply-feedback names the published commit, not the head at reply time, so a retry after the head
//   moved derives the same marker and does not post twice; it skips a deleted thread instead of
//   blocking forever; and it posts nothing once the MR is merged or closed.
// development@11 (and an unpinned plan) keep the previous behaviour. This file locks design §6 E2–E6
// against the real platform work items with a light in-memory code host (the shape of
// tests/rfc396-mr-lifecycle.test.ts:433-635).
import { describe, expect, test } from 'bun:test'
import { createDevelopmentMrFacts } from '@/modules/development-automation/application/developmentMrFacts'
import {
  composeDevelopmentEmployeePlatformWorkItemsFromPersistence,
  type DevelopmentEmployeePlatformWorkItemsCompositionInput,
} from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { createFileAutomationWorkspaceEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileAutomationWorkspaceEffects'
import { createFileRepositoryBaselineEffectsFactory } from '@/modules/development-automation/infrastructure/local/fileRepositoryBaselineEffects'
import {
  composeStandalonePlatformWorkItemEvidence,
  graphDeliveryWithoutDesign,
  unusedEmployeePlatformProviders,
} from './helpers/developmentAutomation'

const REVIEWED_HEAD = 'a'.repeat(40)
const TARGET = 'b'.repeat(40)
const PUBLISHED_COMMIT = 'd'.repeat(40)
const FOREIGN_HEAD = 'e'.repeat(40)
const NEW_COMMIT = '9'.repeat(40)
const TREE = 'c'.repeat(40)
const CANDIDATE = '7'.repeat(64)
const NONCE = '8'.repeat(64)
const CASE_ID = 'case-628'

type TypeRef = { readonly typeId: string; readonly revision: number } | null
const DEVELOPMENT_NEW = { typeId: 'development', revision: 12 }
const DEVELOPMENT_OLD = { typeId: 'development', revision: 11 }
const GRAPH_NEW = { typeId: 'graph-development', revision: 3 }
const GRAPH_OLD = { typeId: 'graph-development', revision: 2 }

function context(typeId: string, state: unknown, lifecycleState = 'active') {
  return {
    id: `${typeId}-context`,
    revision: 3,
    schemaVersion: 1,
    typeId,
    lifecycleState,
    stateJson: JSON.stringify(state),
    artifactRefs: [] as string[],
  }
}
type Context = ReturnType<typeof context>

const deliveryContent = {
  commitMessage: 'fix: reject an occupied booking slot',
  mergeRequestTitle: 'Reject occupied booking slots',
  mergeRequestDescription: 'Rejects a booking for a slot that is already taken.',
}
const issue = () =>
  context('development.issue-handling', {
    status: 'active',
    subjectRef: `case:${CASE_ID}`,
    repositoryRef: 'repo',
    request: { kind: 'body', body: 'Avoid duplicate bookings', externalId: null, uploads: [] },
    materialArtifactRefs: [],
    deliveryContent,
  })
const mergeRequest = (headSha: string) =>
  context('development.merge-request', {
    status: 'active',
    mergeRequestRef: 'repo!42',
    headSha,
    targetSha: TARGET,
    issueHandlingContextRef: 'development.issue-handling-context',
    readyToMerge: false,
    mergeableState: 'mergeable',
    approvalHold: false,
    unresolvedReviewCount: 0,
    reviewThreads: [],
    repositoryRef: 'repo',
    providerMrRef: '42',
    sourceBranch: 'feature/booking',
    targetBranch: 'main',
  })

interface Row {
  readonly threadRef: string
  readonly revision: string
  readonly acknowledgement: { readonly marker: string; readonly noteRef: string } | null
  readonly disposition: 'addressed' | 'needs-human' | null
  readonly replyBody: string | null
  readonly finalReply: { readonly marker: string; readonly noteRef: string } | null
}
const row = (threadRef: string, revision: string): Row => ({
  threadRef,
  revision,
  acknowledgement: {
    marker: `${CASE_ID}:review-received:${threadRef}`,
    noteRef: `ack-${threadRef}`,
  },
  disposition: 'addressed',
  replyBody: `Repaired ${threadRef}.`,
  finalReply: null,
})
function ledgerState(input: {
  readonly status?: 'acknowledged' | 'prepared' | 'replied'
  readonly publishedHeadSha?: string | null
  readonly rows?: readonly Row[]
}) {
  const status = input.status ?? 'prepared'
  return {
    status,
    mergeRequestRef: 'repo!42',
    sourceHeadSha: REVIEWED_HEAD,
    publishedHeadSha: input.publishedHeadSha ?? null,
    commitSha: status === 'replied' ? (input.publishedHeadSha ?? null) : null,
    threads: input.rows ?? [row('review-1', '1:4')],
  }
}

function plan(workItemRef: string, typeRef: TypeRef, contexts: readonly Context[]) {
  return {
    roundRef: `round-${workItemRef}`,
    executionNonce: NONCE,
    caseRef: { id: CASE_ID },
    employeeTypeRef: typeRef,
    triggeringEventRef: `continuation:${workItemRef}`,
    workItemRef,
    externalWaitDeadlineMs: 60_000,
    inputEnvelopeJson: JSON.stringify({ contextsJson: JSON.stringify(contexts) }),
  }
}

interface Output {
  readonly status: string
  readonly summary: string
  readonly contextPatches: ReadonlyArray<{
    contextId: string | null
    contextTypeId: string
    expectedRevision: number | null
    lifecycleState: string
    stateJson: string
  }>
  readonly effectSuggestions: readonly string[]
}
const ledgerPatch = (output: Output) =>
  output.contextPatches.find((patch) => patch.contextTypeId === 'development.review-resolution')

/**
 * A stateful code host: posted replies become thread messages carrying the self marker, exactly as
 * the real provider stores them (modules/integration/application/mrFacts.ts reads the marker back).
 */
function codeHost(threadRefs: readonly { threadRef: string; revision: string }[]) {
  let state: 'opened' | 'merged' | 'closed' = 'opened'
  // 'incomplete' / 'unmarked-empty': the list read came back truncated or unparseable. The collector
  // then yields an empty thread list (modules/integration/application/mrFacts.ts); 'incomplete'
  // carries the RFC-628 mark, 'unmarked-empty' is the same read as it looked before the mark existed.
  let listing: 'complete' | 'incomplete' | 'unmarked-empty' = 'complete'
  let notes = 0
  const failing = new Set<string>()
  const attempts: Array<{ threadRef: string; body: string; selfMarker: string }> = []
  const threads = threadRefs.map((thread) => ({
    threadRef: thread.threadRef,
    revision: thread.revision,
    authorClass: 'human' as const,
    resolved: false,
    body: `Please repair ${thread.threadRef}.`,
    path: 'src/book.ts',
    messages: [
      {
        messageRef: `root-${thread.threadRef}`,
        parentMessageRef: null as string | null,
        authorClass: 'human' as 'human' | 'bot' | 'self',
        body: `Please repair ${thread.threadRef}.`,
        path: 'src/book.ts' as string | null,
        createdAt: null as string | null,
      },
    ],
  }))
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected code host call')
  }
  return {
    attempts,
    setState(next: 'opened' | 'merged' | 'closed') {
      state = next
    },
    setListing(next: 'complete' | 'incomplete' | 'unmarked-empty') {
      listing = next
    },
    failReplies(threadRef: string, fail = true) {
      if (fail) failing.add(threadRef)
      else failing.delete(threadRef)
    },
    resolvedReplies(threadRef: string) {
      return (
        threads
          .find((thread) => thread.threadRef === threadRef)
          ?.messages.filter((message) => message.body.includes(`:review-resolved:`)) ?? []
      )
    },
    mrEffects: {
      async reply(
        _repositoryId: string,
        request: {
          readonly mrRef: string
          readonly threadRef: string
          readonly body: string
          readonly selfMarker: string
        },
      ) {
        attempts.push({
          threadRef: request.threadRef,
          body: request.body,
          selfMarker: request.selfMarker,
        })
        const thread = threads.find((candidate) => candidate.threadRef === request.threadRef)
        if (thread === undefined || failing.has(request.threadRef)) {
          return {
            ok: false as const,
            code: 'mr-reply-failed',
            detail: `discussion ${request.threadRef} rejected the reply`,
          }
        }
        const noteRef = `note-${++notes}`
        thread.messages.push({
          messageRef: noteRef,
          parentMessageRef: `root-${thread.threadRef}`,
          authorClass: 'self',
          body: `${request.body}\n\n<!-- aw-self:${request.selfMarker} -->`,
          path: thread.path,
          createdAt: null,
        })
        return { ok: true as const, noteRef }
      },
      observe: unexpected,
      ensure: unexpected,
    },
    mrFacts: {
      async collect() {
        const listed = listing === 'complete' ? threads : []
        return {
          ok: true as const,
          snapshot: {
            state,
            headSha: REVIEWED_HEAD,
            targetSha: TARGET,
            targetBranch: 'main',
            draft: false,
            mergeableState: 'mergeable' as const,
            approvalHold: false,
            mergedCommitSha: null,
            unresolvedReviewCount: listed.length,
            reviewThreads: listed.map((thread) => ({
              ...thread,
              messages: thread.messages.map((message) => ({ ...message })),
            })),
            ...(listing === 'incomplete' ? { reviewThreadsIncomplete: true as const } : {}),
          },
        }
      },
    },
  }
}

function replyRunner(host: ReturnType<typeof codeHost>) {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected platform effect')
  }
  const runner = composeDevelopmentEmployeePlatformWorkItemsFromPersistence({
    ...unusedEmployeePlatformProviders(),
    automationWorkspaceEffects: createFileAutomationWorkspaceEffectsFactory(),
    repositoryBaselines: createFileRepositoryBaselineEffectsFactory(),
    appHome: '/tmp/rfc628-reply-fixture',
    evidenceArtifacts: composeStandalonePlatformWorkItemEvidence({
      appHome: '/tmp/rfc628-reply-fixture',
    }),
    directPublicationSubject: { kind: 'system' },
    graphDelivery: graphDeliveryWithoutDesign(),
    persistence: {
      currentWorkspace: unexpected,
      prepareApprovalSaga: unexpected,
      approvalSaga: unexpected,
      recordApprovalSubmission: unexpected,
      recordApprovalObservation: unexpected,
      insertCandidate: unexpected,
      candidate: unexpected,
      recordCandidateCommit: unexpected,
      publishCandidateAndWorkspace: unexpected,
      updateWorkspaceHead: unexpected,
      latestRoundValidation: unexpected,
    },
    reactionRounds: { frozenPlan: () => null, lastSettledRound: () => null },
    repoRemote: { resolve: unexpected },
    mrEffects: host.mrEffects,
    mrFacts: host.mrFacts,
    sourceControl: {},
    conflictMerge: {},
  } as unknown as DevelopmentEmployeePlatformWorkItemsCompositionInput)
  return async (
    typeRef: TypeRef,
    input: { readonly mrHead: string; readonly ledger: ReturnType<typeof ledgerState> },
  ) => {
    const resolution = context('development.review-resolution', input.ledger)
    return JSON.parse(
      await runner.execute(
        plan('reply-feedback', typeRef, [issue(), mergeRequest(input.mrHead), resolution]),
      ),
    ) as Output
  }
}

describe('RFC-628 E3 the reply names the published commit, so a retry never posts twice', () => {
  for (const typeRef of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    test(`${typeRef.typeId}@${typeRef.revision}: body, marker and replied record use publishedHeadSha`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        // Someone pushed after the repair was published: the MR head is no longer the commit.
        mrHead: FOREIGN_HEAD,
        ledger: ledgerState({ publishedHeadSha: PUBLISHED_COMMIT }),
      })
      expect(output.status).toBe('ok')
      expect(host.attempts).toHaveLength(1)
      expect(host.attempts[0]!.body).toStartWith(
        `已在提交 ${PUBLISHED_COMMIT.slice(0, 12)} 中处理。`,
      )
      expect(host.attempts[0]!.body).not.toContain(FOREIGN_HEAD.slice(0, 12))
      const replied = JSON.parse(ledgerPatch(output)!.stateJson)
      expect(replied).toMatchObject({
        status: 'replied',
        publishedHeadSha: PUBLISHED_COMMIT,
        commitSha: PUBLISHED_COMMIT,
      })
      expect(replied.threads[0].finalReply).toEqual({
        marker: host.attempts[0]!.selfMarker,
        noteRef: 'note-1',
      })
    })

    test(`${typeRef.typeId}@${typeRef.revision}: a partial send, then a retry after the head moved, posts each thread once`, async () => {
      const host = codeHost([
        { threadRef: 'review-1', revision: '1:4' },
        { threadRef: 'review-2', revision: '2:3' },
      ])
      const reply = replyRunner(host)
      const ledger = ledgerState({
        publishedHeadSha: PUBLISHED_COMMIT,
        rows: [row('review-1', '1:4'), row('review-2', '2:3')],
      })
      host.failReplies('review-2')
      const blocked = await reply(typeRef, { mrHead: PUBLISHED_COMMIT, ledger })
      expect(blocked.status).toBe('blocked')
      expect(blocked.contextPatches).toEqual([])
      expect(host.resolvedReplies('review-1')).toHaveLength(1)
      // The case resumes later (possibly via observe-mr after a preemption); the head moved meanwhile.
      host.failReplies('review-2', false)
      const resumed = await reply(typeRef, { mrHead: FOREIGN_HEAD, ledger })
      expect(resumed.status).toBe('ok')
      expect(host.attempts.map((attempt) => attempt.threadRef)).toEqual([
        'review-1',
        'review-2',
        'review-2',
      ])
      expect(host.resolvedReplies('review-1')).toHaveLength(1)
      expect(host.resolvedReplies('review-2')).toHaveLength(1)
      const replied = JSON.parse(ledgerPatch(resumed)!.stateJson)
      expect(replied.status).toBe('replied')
      expect(replied.threads.map((thread: Row) => thread.finalReply?.noteRef)).toEqual([
        'note-1',
        'note-2',
      ])
    })
  }
})

describe('RFC-628 E4 a deleted thread is dropped with a note instead of blocking the case', () => {
  for (const typeRef of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    test(`${typeRef.typeId}@${typeRef.revision}: the deleted row is removed and named, the rest is posted`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({
          publishedHeadSha: PUBLISHED_COMMIT,
          rows: [row('review-1', '1:4'), row('review-gone', '5:1')],
        }),
      })
      expect(output.status).toBe('ok')
      expect(host.attempts.map((attempt) => attempt.threadRef)).toEqual(['review-1'])
      expect(output.summary).toContain('另有 1 条线程已删除')
      expect(output.summary).toContain('review-gone')
      const replied = JSON.parse(ledgerPatch(output)!.stateJson)
      expect(replied.status).toBe('replied')
      expect(replied.threads.map((thread: Row) => thread.threadRef)).toEqual(['review-1'])
    })

    test(`${typeRef.typeId}@${typeRef.revision}: a send failure on a live thread still blocks and leaves the ledger alone`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      host.failReplies('review-1')
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({
          publishedHeadSha: PUBLISHED_COMMIT,
          rows: [row('review-gone', '5:1'), row('review-1', '1:4')],
        }),
      })
      expect(output.status).toBe('blocked')
      expect(output.contextPatches).toEqual([])
    })

    test(`${typeRef.typeId}@${typeRef.revision}: when every unanswered row was deleted the ledger becomes an empty collected one`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({
          publishedHeadSha: PUBLISHED_COMMIT,
          rows: [row('review-gone', '5:1'), row('review-lost', '6:2')],
        }),
      })
      expect(output.status).toBe('ok')
      expect(host.attempts).toEqual([])
      expect(output.summary).toContain('线程已删除')
      const patch = ledgerPatch(output)!
      expect(patch.lifecycleState).toBe('terminal')
      expect(JSON.parse(patch.stateJson)).toEqual({
        status: 'collected',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: REVIEWED_HEAD,
        publishedHeadSha: null,
        commitSha: null,
        threads: [],
      })
    })

    test(`${typeRef.typeId}@${typeRef.revision}: rows that already have a final reply stay when the other rows were deleted`, async () => {
      const host = codeHost([{ threadRef: 'review-done', revision: '3:2' }])
      const reply = replyRunner(host)
      const done = {
        ...row('review-done', '3:2'),
        finalReply: { marker: `${CASE_ID}:review-resolved:review-done`, noteRef: 'note-done' },
      }
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({
          publishedHeadSha: PUBLISHED_COMMIT,
          rows: [done, row('review-gone', '5:1')],
        }),
      })
      expect(output.status).toBe('ok')
      expect(host.attempts).toEqual([])
      expect(output.summary).toContain('另有 1 条线程已删除')
      expect(output.summary).toContain('review-gone')
      const patch = ledgerPatch(output)!
      expect(patch.lifecycleState).toBe('terminal')
      expect(JSON.parse(patch.stateJson)).toEqual({
        status: 'replied',
        mergeRequestRef: 'repo!42',
        sourceHeadSha: REVIEWED_HEAD,
        publishedHeadSha: PUBLISHED_COMMIT,
        commitSha: PUBLISHED_COMMIT,
        threads: [done],
      })
    })

    test(`${typeRef.typeId}@${typeRef.revision}: an incomplete thread list is replied to as a frozen revision would; nothing is removed`, async () => {
      // Implementation gate P2-1, coordinator ruling: waiting for the next MR facts would never
      // reply on an MR whose list is always too long; the new revision must not do worse than
      // development@11, which posts every unanswered row whatever the list looked like.
      const legacyRevision: TypeRef = typeRef.typeId === 'development' ? DEVELOPMENT_OLD : GRAPH_OLD
      const prepared = ledgerState({
        publishedHeadSha: PUBLISHED_COMMIT,
        rows: [row('review-1', '1:4'), row('review-2', '2:3')],
      })
      const runs = []
      for (const revision of [typeRef, legacyRevision]) {
        const host = codeHost([
          { threadRef: 'review-1', revision: '1:4' },
          { threadRef: 'review-2', revision: '2:3' },
        ])
        host.setListing('incomplete')
        const reply = replyRunner(host)
        // The MR head is still the published commit, so both revisions name the same commit.
        runs.push({
          host,
          reply,
          output: await reply(revision, { mrHead: PUBLISHED_COMMIT, ledger: prepared }),
        })
      }
      const [current, legacy] = runs
      expect(current!.output.status).toBe('ok')
      expect(current!.output.summary).toContain('没有读全')
      expect(current!.output.summary).toContain('没有核对线程是否已被删除')
      expect(current!.output.summary).toContain('共回复 2 条')
      expect(current!.output.summary).not.toContain('另有')
      expect(current!.host.attempts.map((attempt) => attempt.threadRef)).toEqual([
        'review-1',
        'review-2',
      ])
      // Exactly the frozen revision's replies and ledger for these rows.
      expect(current!.host.attempts).toEqual(legacy!.host.attempts)
      const replied = JSON.parse(ledgerPatch(current!.output)!.stateJson)
      expect(replied).toEqual(JSON.parse(ledgerPatch(legacy!.output)!.stateJson))
      expect(replied).toMatchObject({
        status: 'replied',
        publishedHeadSha: PUBLISHED_COMMIT,
        commitSha: PUBLISHED_COMMIT,
      })
      expect(replied.threads.map((thread: Row) => thread.finalReply?.noteRef)).toEqual([
        'note-1',
        'note-2',
      ])
      // A retry of the same round that reads the complete list finds the posted replies by marker
      // and only records them: no thread is answered twice.
      current!.host.setListing('complete')
      const retried = await current!.reply(typeRef, { mrHead: PUBLISHED_COMMIT, ledger: prepared })
      expect(retried.status).toBe('ok')
      expect(current!.host.attempts).toHaveLength(2)
      expect(current!.host.resolvedReplies('review-1')).toHaveLength(1)
      expect(current!.host.resolvedReplies('review-2')).toHaveLength(1)
      expect(JSON.parse(ledgerPatch(retried)!.stateJson)).toEqual(replied)
    })
  }
})

describe('RFC-628 E4 an incomplete thread list changes nothing for frozen revisions', () => {
  // Before the mark existed the same read looked like an empty, unmarked list; a frozen revision
  // must produce exactly that output whether or not the collector marks the list incomplete.
  for (const typeRef of [DEVELOPMENT_OLD, GRAPH_OLD, null]) {
    const label = typeRef === null ? 'no pinned revision' : `${typeRef.typeId}@${typeRef.revision}`
    test(`${label}: marked and unmarked incomplete reads reply identically`, async () => {
      const outputs = []
      const attempts = []
      for (const listing of ['incomplete', 'unmarked-empty'] as const) {
        const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
        host.setListing(listing)
        const reply = replyRunner(host)
        outputs.push(
          await reply(typeRef, {
            mrHead: PUBLISHED_COMMIT,
            ledger: ledgerState({ rows: [row('review-1', '1:4')] }),
          }),
        )
        attempts.push(host.attempts)
      }
      expect(outputs[0]).toEqual(outputs[1]!)
      expect(attempts[0]).toEqual(attempts[1]!)
      // The frozen behaviour itself: the reply is posted and the ledger is replied at the MR head.
      expect(outputs[0]!.status).toBe('ok')
      expect(attempts[0]!.map((attempt) => attempt.threadRef)).toEqual(['review-1'])
      expect(JSON.parse(ledgerPatch(outputs[0]!)!.stateJson)).toMatchObject({
        status: 'replied',
        publishedHeadSha: PUBLISHED_COMMIT,
        commitSha: PUBLISHED_COMMIT,
      })
    })
  }
})

describe('RFC-628 E4 the incomplete-list mark reaches the platform work items', () => {
  const integrationSnapshot = {
    mrRef: '42',
    headSha: REVIEWED_HEAD,
    targetSha: TARGET,
    targetBranch: 'main',
    state: 'opened' as const,
    draft: false,
    mergeableState: 'mergeable' as const,
    approvalHold: null,
    mergedCommitSha: null,
    mergedAt: null,
    threads: [],
  }
  test('a marked read carries reviewThreadsIncomplete; an unmarked read keeps its exact shape', async () => {
    const results = [
      { ok: true as const, snapshot: integrationSnapshot, threadsIncomplete: true as const },
      { ok: true as const, snapshot: integrationSnapshot },
    ]
    const mapped = []
    for (const result of results) {
      const facts = createDevelopmentMrFacts({ mrFacts: { collect: async () => result } })
      mapped.push(await facts.collect('repo', '42', CASE_ID))
    }
    const marked = mapped[0]!
    const unmarked = mapped[1]!
    expect(marked.ok && unmarked.ok).toBe(true)
    if (!marked.ok || !unmarked.ok) return
    expect(marked.snapshot).toEqual({ ...unmarked.snapshot, reviewThreadsIncomplete: true })
    expect('reviewThreadsIncomplete' in unmarked.snapshot).toBe(false)
    expect(unmarked.snapshot.reviewThreads).toEqual([])
  })
})

describe('RFC-628 E5 development@11 and unpinned plans reply exactly as before', () => {
  for (const typeRef of [DEVELOPMENT_OLD, GRAPH_OLD, null]) {
    const label = typeRef === null ? 'no pinned revision' : `${typeRef.typeId}@${typeRef.revision}`

    test(`${label}: the body and marker use the MR head, so a retry after the head moved posts again`, async () => {
      const host = codeHost([
        { threadRef: 'review-1', revision: '1:4' },
        { threadRef: 'review-2', revision: '2:3' },
      ])
      const reply = replyRunner(host)
      const ledger = ledgerState({
        publishedHeadSha: PUBLISHED_COMMIT,
        rows: [row('review-1', '1:4'), row('review-2', '2:3')],
      })
      host.failReplies('review-2')
      expect((await reply(typeRef, { mrHead: PUBLISHED_COMMIT, ledger })).status).toBe('blocked')
      host.failReplies('review-2', false)
      const resumed = await reply(typeRef, { mrHead: FOREIGN_HEAD, ledger })
      expect(resumed.status).toBe('ok')
      expect(host.attempts[2]!.body).toStartWith(`已在提交 ${FOREIGN_HEAD.slice(0, 12)} 中处理。`)
      expect(host.resolvedReplies('review-1')).toHaveLength(2)
      expect(JSON.parse(ledgerPatch(resumed)!.stateJson)).toMatchObject({
        status: 'replied',
        publishedHeadSha: FOREIGN_HEAD,
        commitSha: FOREIGN_HEAD,
      })
    })

    test(`${label}: a deleted thread still blocks the reply`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({ rows: [row('review-gone', '5:1')] }),
      })
      expect(output.status).toBe('blocked')
      expect(output.contextPatches).toEqual([])
      expect(host.attempts.map((attempt) => attempt.threadRef)).toEqual(['review-gone'])
    })

    test(`${label}: a merged MR is not checked; the reply is still posted`, async () => {
      const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
      host.setState('merged')
      const reply = replyRunner(host)
      const output = await reply(typeRef, {
        mrHead: PUBLISHED_COMMIT,
        ledger: ledgerState({}),
      })
      expect(output.status).toBe('ok')
      expect(host.attempts).toHaveLength(1)
      expect(host.attempts[0]!.body).toStartWith(
        `已在提交 ${PUBLISHED_COMMIT.slice(0, 12)} 中处理。`,
      )
      expect(JSON.parse(ledgerPatch(output)!.stateJson).status).toBe('replied')
    })
  }
})

describe('RFC-628 E6 a reply that finds the MR merged or closed posts nothing', () => {
  for (const typeRef of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    for (const state of ['merged', 'closed'] as const) {
      test(`${typeRef.typeId}@${typeRef.revision}: ${state} → ok, no reply, no patch, no effect`, async () => {
        const host = codeHost([{ threadRef: 'review-1', revision: '1:4' }])
        host.setState(state)
        const reply = replyRunner(host)
        const output = await reply(typeRef, {
          mrHead: PUBLISHED_COMMIT,
          ledger: ledgerState({ publishedHeadSha: PUBLISHED_COMMIT }),
        })
        expect(output.status).toBe('ok')
        expect(host.attempts).toEqual([])
        expect(output.contextPatches).toEqual([])
        expect(output.effectSuggestions).toEqual([])
        expect(output.summary).toContain('不再回复修复结果')
        expect(output.summary).toContain(state === 'merged' ? '合入' : '关闭')
      })
    }
  }
})

/** publish-mr over a light persistence (tests/rfc396-mr-lifecycle.test.ts:433-635). */
function publishFixture(options: { readonly candidateBaselineSha: string }) {
  const calls: string[] = []
  let workspace = {
    caseId: CASE_ID,
    repositoryId: 'repo',
    cachedRepoId: 'cached',
    baselineSha: options.candidateBaselineSha,
    targetBranch: 'main',
    sourceBranch: 'feature/booking',
    remoteHeadSha: options.candidateBaselineSha as string | null,
    state: 'published' as 'active' | 'published',
    createdAt: 1,
    updatedAt: 1,
  }
  let candidate = {
    candidateRef: CANDIDATE,
    baselineSha: options.candidateBaselineSha,
    treeOid: TREE,
    receiptJson: JSON.stringify({ treeOid: TREE, uploadPlan: null, uploadLineage: null }),
    summarySource: deliveryContent.commitMessage,
    state: 'prepared' as 'prepared' | 'committed' | 'published',
    commitSha: null as string | null,
  }
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected fixture effect')
  }
  const runner = composeDevelopmentEmployeePlatformWorkItemsFromPersistence({
    ...unusedEmployeePlatformProviders(),
    automationWorkspaceEffects: createFileAutomationWorkspaceEffectsFactory(),
    repositoryBaselines: createFileRepositoryBaselineEffectsFactory(),
    appHome: '/tmp/rfc628-publish-fixture',
    evidenceArtifacts: composeStandalonePlatformWorkItemEvidence({
      appHome: '/tmp/rfc628-publish-fixture',
    }),
    directPublicationSubject: { kind: 'system' },
    graphDelivery: graphDeliveryWithoutDesign(),
    persistence: {
      currentWorkspace: async () => ({ row: workspace, repositoryLocalPath: '/repo-baseline' }),
      prepareApprovalSaga: unexpected,
      approvalSaga: unexpected,
      recordApprovalSubmission: unexpected,
      recordApprovalObservation: unexpected,
      insertCandidate: unexpected,
      candidate: async () => candidate,
      recordCandidateCommit: async ({ commitSha }: { commitSha: string }) => {
        candidate = { ...candidate, commitSha, state: 'committed' }
      },
      publishCandidateAndWorkspace: async ({ commitSha }: { commitSha: string }) => {
        calls.push('publication.persist')
        candidate = { ...candidate, state: 'published' }
        workspace = {
          ...workspace,
          state: 'published',
          baselineSha: commitSha,
          remoteHeadSha: commitSha,
        }
      },
      updateWorkspaceHead: unexpected,
      latestRoundValidation: unexpected,
    },
    reactionRounds: { frozenPlan: () => null, lastSettledRound: () => null },
    repoRemote: {
      resolve: async () => ({
        remoteUrl: 'https://example.invalid/repo.git',
        defaultBranch: 'main',
      }),
    },
    mrEffects: {
      reply: unexpected,
      observe: unexpected,
      ensure: async () => ({
        ok: true as const,
        mr: {
          mrRef: '42',
          webUrl: 'https://example.invalid/repo/merge_requests/42',
          state: 'opened' as const,
          sourceSha: NEW_COMMIT,
          created: false,
        },
      }),
    },
    sourceControl: {
      commit: async () => {
        calls.push('commit')
        return { ok: true, commitSha: NEW_COMMIT, localRef: 'local:commit', reused: false }
      },
      push: async (request: {
        expectedRemoteSha: string | null
        commitSha: string
        branch: string
      }) => {
        calls.push('push')
        return {
          ok: true,
          receipt: {
            remoteRef: `refs/heads/${request.branch}`,
            oldSha: request.expectedRemoteSha,
            newSha: request.commitSha,
            reused: false,
          },
        }
      },
      checkpoint: async () => ({ checkpointDigest: NONCE }),
      restore: async () => ({ workspacePath: '/scene/workspace' }),
    },
    conflictMerge: {},
  } as unknown as DevelopmentEmployeePlatformWorkItemsCompositionInput)
  const candidateContext = () =>
    context('development.change-candidate', {
      status: 'prepared',
      candidateRef: CANDIDATE,
      baselineSha: candidate.baselineSha,
      treeOid: TREE,
      summarySource: candidate.summarySource,
      changedPaths: ['src/book.ts'],
      commitSha: null,
    })
  return {
    calls,
    async publish(typeRef: TypeRef, ledger: ReturnType<typeof ledgerState> | null) {
      const contexts = [
        issue(),
        candidateContext(),
        mergeRequest(options.candidateBaselineSha),
        ...(ledger === null ? [] : [context('development.review-resolution', ledger)]),
      ]
      return JSON.parse(await runner.execute(plan('publish-mr', typeRef, contexts))) as Output
    },
  }
}

describe('RFC-628 E2 publish-mr marks the ledger published only when the candidate contains the repair', () => {
  for (const typeRef of [DEVELOPMENT_NEW, GRAPH_NEW]) {
    const label = `${typeRef.typeId}@${typeRef.revision}`

    test(`${label}: candidate grew from the ledger's source head → publishedHeadSha is the new commit`, async () => {
      const fixture = publishFixture({ candidateBaselineSha: REVIEWED_HEAD })
      const prepared = ledgerState({})
      const output = await fixture.publish(typeRef, prepared)
      expect(output.status).toBe('ok')
      expect(fixture.calls).toEqual(['commit', 'push', 'publication.persist'])
      const patch = ledgerPatch(output)
      expect(patch).toMatchObject({
        contextId: 'development.review-resolution-context',
        expectedRevision: 3,
        lifecycleState: 'active',
      })
      expect(JSON.parse(patch!.stateJson)).toEqual({ ...prepared, publishedHeadSha: NEW_COMMIT })
    })

    test(`${label}: candidate grew from another head (workspace rebuilt) → the ledger is not touched`, async () => {
      const fixture = publishFixture({ candidateBaselineSha: FOREIGN_HEAD })
      const output = await fixture.publish(typeRef, ledgerState({}))
      expect(output.status).toBe('ok')
      expect(ledgerPatch(output)).toBeUndefined()
    })

    test(`${label}: an already published ledger keeps the commit it recorded`, async () => {
      const fixture = publishFixture({ candidateBaselineSha: REVIEWED_HEAD })
      const published = ledgerState({ publishedHeadSha: PUBLISHED_COMMIT })
      const output = await fixture.publish(typeRef, published)
      expect(output.status).toBe('ok')
      const patch = ledgerPatch(output)
      expect(patch === undefined ? published : JSON.parse(patch.stateJson)).toEqual(published)
    })

    test(`${label}: a ledger that is not prepared, or no ledger at all, is not marked`, async () => {
      for (const ledger of [
        ledgerState({
          status: 'acknowledged',
          rows: [{ ...row('review-1', '1:4'), disposition: null, replyBody: null }],
        }),
        ledgerState({
          status: 'replied',
          publishedHeadSha: PUBLISHED_COMMIT,
          rows: [{ ...row('review-1', '1:4'), finalReply: { marker: 'm', noteRef: 'n' } }],
        }),
        null,
      ]) {
        const fixture = publishFixture({ candidateBaselineSha: REVIEWED_HEAD })
        const output = await fixture.publish(typeRef, ledger)
        expect(output.status).toBe('ok')
        expect(ledgerPatch(output)).toBeUndefined()
      }
    })
  }

  for (const typeRef of [DEVELOPMENT_OLD, GRAPH_OLD, null]) {
    const label = typeRef === null ? 'no pinned revision' : `${typeRef.typeId}@${typeRef.revision}`
    test(`${label}: publish-mr never writes the ledger`, async () => {
      const fixture = publishFixture({ candidateBaselineSha: REVIEWED_HEAD })
      const output = await fixture.publish(typeRef, ledgerState({}))
      expect(output.status).toBe('ok')
      expect(ledgerPatch(output)).toBeUndefined()
    })
  }
})
