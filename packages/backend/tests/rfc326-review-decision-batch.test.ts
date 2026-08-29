// RFC-326 — batched decisions: comments[] + selections[] on the decision
// (proposal AC-14 / AC-15; design §4.2, §6.1 prepare B/C/D).
//
// WHY THIS FILE EXISTS (regression intent):
//   - AC-15: a batched iterate archives the batch together with the comments
//     posted one by one (commentsJson + decisionReason), and the upstream
//     re-run prompt (`buildReviewPromptContext`) carries ALL of them.
//   - AC-15: starting from every item `unselected`, one request with
//     selections[] + `approved` curates the round: the `accepted` /
//     `approval_meta` output rows equal — byte for byte — the subset computed
//     from the POST-batch view (`effectiveDvs`, design §6.1), and the judged rows
//     have selectionStale cleared. Reading the pre-batch rows instead (mutation
//     evidence ⑧) makes the "accepted" subset empty and this file red.
//   - AC-14: every refusal class (bad anchor, illegal selection target,
//     incomplete multi-doc approve, duplicate docVersionId, stale iteration,
//     non-member actor, closed source fence, terminal task, unnamed document)
//     is a 4xx with ZERO writes: the six persisted surfaces
//     (doc_versions / review_comments / node_runs / node_run_outputs /
//     merge_state / memory_distill_jobs) and the WS event count are compared
//     byte-for-byte before and after.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { joinMarkdownDocs } from '@agent-workflow/shared'
import type { ReviewCommentAnchor, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  memoryDistillJobs,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import {
  addReviewComment,
  buildReviewPromptContext,
  dispatchReviewNode,
  submitReviewDecision,
  type SubmitReviewDecisionArgs,
} from '../src/services/review'
import { createApp } from '../src/server'
import { DomainError } from '../src/util/errors'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import { installCommittedEventProjectionHarness } from './helpers/committedEventHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const HEADERS = { Authorization: 'Bearer tok', 'content-type': 'application/json' }

// ---------------------------------------------------------------------------
// Six-surface snapshot + WS counter
// ---------------------------------------------------------------------------

interface Snapshot {
  docVersions: unknown[]
  reviewComments: unknown[]
  nodeRuns: unknown[]
  nodeRunOutputs: unknown[]
  mergeStates: unknown[]
  memoryDistillJobs: unknown[]
}

async function snapshot(db: DbClient): Promise<Snapshot> {
  const runs = await db.select().from(nodeRuns).orderBy(asc(nodeRuns.id))
  return {
    docVersions: await db.select().from(docVersions).orderBy(asc(docVersions.id)),
    reviewComments: await db.select().from(reviewComments).orderBy(asc(reviewComments.id)),
    nodeRuns: runs,
    nodeRunOutputs: await db
      .select()
      .from(nodeRunOutputs)
      .orderBy(asc(nodeRunOutputs.nodeRunId), asc(nodeRunOutputs.portName)),
    mergeStates: runs.map((r) => ({ id: r.id, mergeState: r.mergeState })),
    memoryDistillJobs: await db.select().from(memoryDistillJobs).orderBy(asc(memoryDistillJobs.id)),
  }
}

function countTaskEvents(taskId: string): {
  count: () => number
  types: string[]
  stop: () => void
} {
  const types: string[] = []
  const unsubscribe = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (msg) => {
    types.push((msg as { type: string }).type)
  })
  return { count: () => types.length, types, stop: unsubscribe }
}

interface Refusal {
  code: string
  status: number
  message: string
  details: unknown
}

async function refusalOf(fn: () => Promise<unknown>): Promise<Refusal> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof DomainError) {
      return { code: err.code, status: err.status, message: err.message, details: err.details }
    }
    throw err
  }
  throw new Error('expected the decision to be refused')
}

function actorFor(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_BODY = [
  '# Design v1',
  '',
  'The `order_status` enum should include partially_refunded.',
  '',
  '## Notes',
  '',
  'The export job reads the enum too.',
  '',
].join('\n')

interface SingleFixture {
  db: DbClient
  appHome: string
  taskId: string
  reviewRunId: string
  docRunId: string
  dvId: string
  ownerId: string
  memberId: string
  strangerId: string
  cleanup: () => void
}

async function buildSingle(
  taskStatus: 'awaiting_review' | 'running' = 'awaiting_review',
): Promise<SingleFixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc326-batch-'))
  const appHome = join(tmp, 'appHome')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const uninstallProjection = installCommittedEventProjectionHarness(db)

  const [ownerId, memberId, strangerId] = ['owner', 'member', 'stranger'].map(() => ulid())
  await db.insert(users).values(
    [ownerId!, memberId!, strangerId!].map((id, i) => ({
      id,
      username: `u-${i}-${id.slice(-6)}`,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: NOW,
      updatedAt: NOW,
    })),
  )
  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['docpath']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'wf', definition: JSON.stringify(definition) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: NOW,
    ownerUserId: ownerId!,
  })
  await db.insert(taskCollaborators).values([
    { taskId, userId: ownerId!, role: 'owner', addedBy: ownerId!, addedAt: NOW },
    { taskId, userId: memberId!, role: 'collaborator', addedBy: ownerId!, addedAt: NOW },
  ])
  const docRunId = ulid()
  await db.insert(nodeRuns).values({
    id: docRunId,
    taskId,
    nodeId: 'doc',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: NOW - 1000,
    finishedAt: NOW - 900,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: docRunId, portName: 'docpath', content: SINGLE_BODY })
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: NOW - 50,
  })
  const dvId = ulid()
  const bodyPath = `doc_versions/${dvId}.md`
  writeFileSync(join(appHome, bodyPath), SINGLE_BODY)
  await db.insert(docVersions).values({
    id: dvId,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath,
    decision: 'pending',
  })
  return {
    db,
    appHome,
    taskId,
    reviewRunId,
    docRunId,
    dvId,
    ownerId: ownerId!,
    memberId: memberId!,
    strangerId: strangerId!,
    cleanup: () => {
      uninstallProjection()
      db.$client.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const PATHS = ['cases/a.md', 'cases/b.md', 'cases/c.md']
const bodyFor = (p: string): string => `# Case ${p}\n\nsteps for ${p}\n`

interface MultiFixture {
  db: DbClient
  appHome: string
  worktree: string
  taskId: string
  reviewRunId: string
  /** Pending members in item order (a, b, c). */
  docs: (typeof docVersions.$inferSelect)[]
  cleanup: () => void
}

/** A real multi-document round produced by `dispatchReviewNode` (all items unselected). */
async function buildMulti(
  kind: 'list<path<md>>' | 'list<markdown>',
  taskStatus: 'awaiting_review' | 'running' = 'awaiting_review',
): Promise<MultiFixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc326-batch-multi-'))
  const appHome = join(tmp, 'appHome')
  const worktree = join(tmp, 'worktree')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const uninstallProjection = installCommittedEventProjectionHarness(db)
  const caseGenId = ulid()
  await db.insert(agentsTable).values({
    id: caseGenId,
    name: 'caseGen',
    description: '',
    outputs: JSON.stringify(['cases']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify({ outputKinds: { cases: kind } }),
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'src',
        kind: 'agent-single',
        agentId: caseGenId,
        agentName: 'caseGen',
        promptTemplate: '',
      } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'src', portName: 'cases' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'multidoc',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: worktree,
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: taskStatus,
    inputs: '{}',
    startedAt: NOW,
  })
  const srcRunId = ulid()
  await db.insert(nodeRuns).values({
    id: srcRunId,
    taskId,
    nodeId: 'src',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: null,
    startedAt: NOW,
    finishedAt: NOW,
  })
  const content =
    kind === 'list<path<md>>' ? PATHS.join('\n') : joinMarkdownDocs(PATHS.map(bodyFor))
  await db.insert(nodeRunOutputs).values({ nodeRunId: srcRunId, portName: 'cases', content })
  for (const p of PATHS) {
    const abs = join(worktree, p)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, bodyFor(p), 'utf8')
  }
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
  const r = await dispatchReviewNode({
    db,
    taskId,
    scopeRoot: task.worktreePath,
    appHome,
    definition,
    node: definition.nodes.find((n) => n.id === 'rev_1')!,
    iteration: 0,
  })
  if (r.kind !== 'awaiting_review') throw new Error(`dispatch → ${JSON.stringify(r)}`)
  const docs = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.taskId, taskId))
    .orderBy(asc(docVersions.itemIndex))
  if (docs.length !== 3) throw new Error(`expected 3 pending items, got ${docs.length}`)
  return {
    db,
    appHome,
    worktree,
    taskId,
    reviewRunId: docs[0]!.reviewNodeRunId,
    docs,
    cleanup: () => {
      uninstallProjection()
      db.$client.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

function webAnchor(body: string, quote: string, occurrence = 1): ReviewCommentAnchor {
  let offset = -1
  for (let i = 0; i < occurrence; i++) offset = body.indexOf(quote, offset + 1)
  if (offset < 0) throw new Error(`fixture: '${quote}' #${occurrence} not in body`)
  return {
    sectionPath: '',
    paragraphIdx: 0,
    offsetStart: offset,
    offsetEnd: offset + quote.length,
    selectedText: quote,
    contextBefore: body.slice(Math.max(0, offset - 30), offset),
    contextAfter: body.slice(offset + quote.length, offset + quote.length + 30),
    occurrenceIndex: occurrence,
  }
}

// ---------------------------------------------------------------------------
// AC-15 — batched iterate carries every comment into the archive + re-run prompt
// ---------------------------------------------------------------------------

describe('RFC-326 AC-15 — batched iterate', () => {
  let f: SingleFixture
  let events: ReturnType<typeof countTaskEvents>
  afterEach(() => {
    events?.stop()
    f?.cleanup()
  })

  test('batch comments join the earlier one-by-one comment in commentsJson / decisionReason / the re-run prompt', async () => {
    f = await buildSingle()
    events = countTaskEvents(f.taskId)
    const earlier = await addReviewComment({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      anchorRequest: { quote: 'partially_refunded' },
      commentText: 'ONE: name the state',
    })
    expect(earlier.warnings).toEqual([])

    const result = await submitReviewDecision({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'reviewer',
      comments: [
        { commentText: 'TWO: also the export job', anchorRequest: { quote: 'export job' } },
        { commentText: 'THREE: web form', anchor: webAnchor(SINGLE_BODY, 'Design v1') },
        // Exact duplicate of TWO inside the same batch → skipped, not double-posted.
        { commentText: 'TWO: also the export job', anchorRequest: { quote: 'export job' } },
      ],
    })
    expect(result.batch).toEqual({
      commentsAdded: 2,
      commentsSkippedAsDuplicate: 1,
      selectionsApplied: 0,
    })
    expect(result.reviewIteration).toBe(1)
    expect(result.resumeRequired).toBe(true)

    const dv = (await f.db.select().from(docVersions).where(eq(docVersions.id, f.dvId)))[0]!
    expect(dv.decision).toBe('iterated')
    const archived = JSON.parse(dv.commentsJson) as Array<{
      commentText: string
      anchor: ReviewCommentAnchor
    }>
    // Archive order is (anchorParagraphIdx, anchorOffsetStart) — the same order
    // the page lists comments in. No sorting on either side: reversing the
    // comparator must turn this red.
    const offsetOf = (text: string): number => SINGLE_BODY.indexOf(text)
    expect(offsetOf('Design v1')).toBeLessThan(offsetOf('partially_refunded'))
    expect(offsetOf('partially_refunded')).toBeLessThan(offsetOf('export job'))
    expect(archived.map((c) => [c.commentText, c.anchor.offsetStart])).toEqual([
      ['THREE: web form', offsetOf('Design v1')],
      ['ONE: name the state', offsetOf('partially_refunded')],
      ['TWO: also the export job', offsetOf('export job')],
    ])
    for (const text of ['ONE: name the state', 'TWO: also the export job', 'THREE: web form']) {
      expect(dv.decisionReason ?? '').toContain(text)
    }
    // Row-side comments are archived away; the review row re-opened at iteration 1.
    expect(await f.db.select().from(reviewComments)).toEqual([])
    const run = (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, f.reviewRunId)))[0]!
    expect(run.status).toBe('pending')
    expect(run.reviewIteration).toBe(1)

    // The upstream re-run prompt sees ALL comments.
    const ctx = await buildReviewPromptContext(f.db, f.appHome, 'doc', f.taskId, 0)
    expect(ctx?.comments ?? '').toContain('ONE: name the state')
    expect(ctx?.comments ?? '').toContain('TWO: also the export job')
    expect(ctx?.comments ?? '').toContain('THREE: web form')

    // Events: the one-by-one comment, the two batch comments, the decision.
    expect(events.types.filter((t) => t === 'review.comment_added').length).toBe(3)
    expect(events.types.at(-1)).toBe('review.decision_made')
  })

  test('a batch comment identical to an existing row is skipped, not duplicated', async () => {
    f = await buildSingle()
    await addReviewComment({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      anchorRequest: { quote: 'partially_refunded' },
      commentText: 'same',
    })
    const result = await submitReviewDecision({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      comments: [{ commentText: 'same', anchorRequest: { quote: 'partially_refunded' } }],
    })
    expect(result.batch).toEqual({
      commentsAdded: 0,
      commentsSkippedAsDuplicate: 1,
      selectionsApplied: 0,
    })
    const dv = (await f.db.select().from(docVersions).where(eq(docVersions.id, f.dvId)))[0]!
    expect((JSON.parse(dv.commentsJson) as unknown[]).length).toBe(1)
  })

  test('a plain decision (no batch) reports no batch counters', async () => {
    f = await buildSingle()
    const result = await submitReviewDecision({
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    expect(result.batch).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC-15 — selections[] + approved from an all-unselected round
// ---------------------------------------------------------------------------

describe('RFC-326 AC-15 — selections[] + approved curate the round in one request', () => {
  let m: MultiFixture
  let events: ReturnType<typeof countTaskEvents>
  afterEach(() => {
    events?.stop()
    m?.cleanup()
  })

  test('list<path<md>>: the accepted subset is computed from the batched view', async () => {
    m = await buildMulti('list<path<md>>')
    events = countTaskEvents(m.taskId)
    expect(m.docs.map((d) => d.selection)).toEqual(['unselected', 'unselected', 'unselected'])
    const [a, b, c] = m.docs as [
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
    ]

    const result = await submitReviewDecision({
      db: m.db,
      appHome: m.appHome,
      nodeRunId: m.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      selections: [
        { docVersionId: a.id, selection: 'accepted' },
        { docVersionId: b.id, selection: 'not_accepted' },
        { docVersionId: c.id, selection: 'accepted' },
      ],
    })
    expect(result.batch).toEqual({
      commentsAdded: 0,
      commentsSkippedAsDuplicate: 0,
      selectionsApplied: 3,
    })

    const outs = await m.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, m.reviewRunId))
    const byPort = new Map(outs.map((o) => [o.portName, o]))
    expect(byPort.get('accepted')?.content).toBe('cases/a.md\ncases/c.md')
    expect(byPort.get('accepted')?.kind).toBe('list<path<md>>')
    const meta = JSON.parse(byPort.get('approval_meta')!.content) as Record<string, unknown>
    expect(meta).toMatchObject({
      decision: 'approved',
      itemCount: 3,
      acceptedCount: 2,
      acceptedItemIndices: [0, 2],
      reviewIteration: 0,
    })

    const rows = await m.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.taskId, m.taskId))
      .orderBy(asc(docVersions.itemIndex))
    expect(rows.map((r) => [r.selection, r.selectionStale, r.decision])).toEqual([
      ['accepted', false, 'approved'],
      ['not_accepted', false, 'approved'],
      ['accepted', false, 'approved'],
    ])
    const run = (await m.db.select().from(nodeRuns).where(eq(nodeRuns.id, m.reviewRunId)))[0]!
    expect(run.status).toBe('done')
    expect(events.types.filter((t) => t === 'review.selection_changed').length).toBe(3)
    expect(events.types.at(-1)).toBe('review.decision_made')
  })

  test('list<markdown>: the accepted bodies are joined in item order', async () => {
    m = await buildMulti('list<markdown>')
    const [a, b, c] = m.docs as [
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
    ]
    await submitReviewDecision({
      db: m.db,
      appHome: m.appHome,
      nodeRunId: m.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      selections: [
        { docVersionId: c.id, selection: 'accepted' },
        { docVersionId: a.id, selection: 'not_accepted' },
        { docVersionId: b.id, selection: 'accepted' },
      ],
    })
    const outs = await m.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, m.reviewRunId))
    const accepted = outs.find((o) => o.portName === 'accepted')!
    expect(accepted.kind).toBe('list<markdown>')
    expect(accepted.content).toBe(joinMarkdownDocs([bodyFor('cases/b.md'), bodyFor('cases/c.md')]))
    const meta = JSON.parse(outs.find((o) => o.portName === 'approval_meta')!.content) as {
      acceptedItemIndices: number[]
    }
    expect(meta.acceptedItemIndices).toEqual([1, 2])
  })

  test('a stale inherited selection re-judged in the batch is no longer stale', async () => {
    m = await buildMulti('list<path<md>>')
    const [a, b, c] = m.docs as [
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
    ]
    await m.db
      .update(docVersions)
      .set({ selection: 'accepted', selectionStale: true })
      .where(eq(docVersions.id, a.id))
    await submitReviewDecision({
      db: m.db,
      appHome: m.appHome,
      nodeRunId: m.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      selections: [
        { docVersionId: a.id, selection: 'accepted' },
        { docVersionId: b.id, selection: 'not_accepted' },
        { docVersionId: c.id, selection: 'not_accepted' },
      ],
    })
    const rowA = (await m.db.select().from(docVersions).where(eq(docVersions.id, a.id)))[0]!
    expect(rowA.selectionStale).toBe(false)
    const accepted = (
      await m.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, m.reviewRunId))
    ).find((o) => o.portName === 'accepted')!
    expect(accepted.content).toBe('cases/a.md')
  })
})

// ---------------------------------------------------------------------------
// AC-14 — every refusal is a 4xx with zero writes
// ---------------------------------------------------------------------------

describe('RFC-326 AC-14 — refusals write nothing (six surfaces + WS count)', () => {
  let f: SingleFixture
  let m: MultiFixture
  let events: ReturnType<typeof countTaskEvents>
  afterEach(() => {
    events?.stop()
    f?.cleanup()
    m?.cleanup()
  })

  async function expectZeroWrites(
    db: DbClient,
    ev: ReturnType<typeof countTaskEvents>,
    run: () => Promise<unknown>,
  ): Promise<Refusal> {
    const before = await snapshot(db)
    const eventsBefore = ev.count()
    const refusal = await refusalOf(run)
    expect(await snapshot(db)).toEqual(before)
    expect(ev.count()).toBe(eventsBefore)
    return refusal
  }

  test('single-document: bad anchors, stale iteration, non-member, fence, terminal task', async () => {
    f = await buildSingle()
    events = countTaskEvents(f.taskId)
    const base: SubmitReviewDecisionArgs = {
      db: f.db,
      appHome: f.appHome,
      nodeRunId: f.reviewRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    }
    const run = (extra: Partial<SubmitReviewDecisionArgs>) => () =>
      submitReviewDecision({ ...base, ...extra })

    const notFound = await expectZeroWrites(
      f.db,
      events,
      run({
        comments: [
          { commentText: 'ok', anchorRequest: { quote: 'export job' } },
          { commentText: 'bad', anchorRequest: { quote: 'never in the document' } },
        ],
      }),
    )
    expect(notFound.status).toBe(422)
    expect(notFound.code).toBe('review-anchor-not-found')
    expect(notFound.message.startsWith('comments[1]: ')).toBe(true)
    expect((notFound.details as { index: number }).index).toBe(1)

    const ambiguous = await expectZeroWrites(
      f.db,
      events,
      run({
        comments: [{ commentText: 'x', anchorRequest: { quote: 'enum' } }],
      }),
    )
    expect(ambiguous.code).toBe('review-anchor-ambiguous')
    expect((ambiguous.details as { candidates: unknown[] }).candidates.length).toBe(2)

    const both = await expectZeroWrites(
      f.db,
      events,
      run({
        comments: [
          {
            commentText: 'x',
            anchor: webAnchor(SINGLE_BODY, 'enum'),
            anchorRequest: { quote: 'enum' },
          },
        ],
      }),
    )
    expect(both.code).toBe('review-comment-invalid')
    expect(both.status).toBe(422)

    const webMissing = await expectZeroWrites(
      f.db,
      events,
      run({
        comments: [
          {
            commentText: 'x',
            anchor: { ...webAnchor(SINGLE_BODY, 'enum'), selectedText: 'nope-nope' },
          },
        ],
      }),
    )
    expect(webMissing.code).toBe('anchor-selection-not-found')
    expect(webMissing.status).toBe(422)

    const selectionOnSingle = await expectZeroWrites(
      f.db,
      events,
      run({
        selections: [{ docVersionId: f.dvId, selection: 'accepted' }],
      }),
    )
    expect(selectionOnSingle.code).toBe('review-not-multi-doc')
    expect(selectionOnSingle.status).toBe(409)

    const unknownTarget = await expectZeroWrites(
      f.db,
      events,
      run({
        selections: [{ docVersionId: 'nope', selection: 'accepted' }],
      }),
    )
    expect(unknownTarget.code).toBe('doc-version-not-found')
    expect(unknownTarget.status).toBe(404)

    const stale = await expectZeroWrites(f.db, events, run({ expectedReviewIteration: 7 }))
    expect(stale.code).toBe('review-iteration-mismatch')
    expect(stale.status).toBe(409)

    const stranger = await expectZeroWrites(f.db, events, run({ actor: actorFor(f.strangerId) }))
    expect(stranger.code).toBe('not-task-member')
    expect(stranger.status).toBe(403)

    await f.db.update(tasks).set({ sourceTerminationFence: 'closed' }).where(eq(tasks.id, f.taskId))
    const fenced = await expectZeroWrites(f.db, events, run({}))
    expect(fenced.code).toBe('task-source-terminal-closed')
    expect(fenced.status).toBe(409)
    await f.db.update(tasks).set({ sourceTerminationFence: null }).where(eq(tasks.id, f.taskId))

    await f.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, f.taskId))
    const terminal = await expectZeroWrites(f.db, events, run({}))
    expect(terminal.code).toBe('task-terminal')
    expect(terminal.status).toBe(409)
    await f.db.update(tasks).set({ status: 'awaiting_review' }).where(eq(tasks.id, f.taskId))

    // The fixture is still decidable afterwards — the refusals really were dry.
    const ok = await submitReviewDecision({
      ...base,
      actor: actorFor(f.memberId),
      comments: [{ commentText: 'fine', anchorRequest: { quote: 'export job' } }],
    })
    expect(ok.batch?.commentsAdded).toBe(1)
  })

  test('multi-document: unnamed document, foreign / decided target, incomplete approve', async () => {
    m = await buildMulti('list<path<md>>')
    events = countTaskEvents(m.taskId)
    const [a, b, c] = m.docs as [
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
    ]
    const base: SubmitReviewDecisionArgs = {
      db: m.db,
      appHome: m.appHome,
      nodeRunId: m.reviewRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    }
    const run = (extra: Partial<SubmitReviewDecisionArgs>) => () =>
      submitReviewDecision({ ...base, ...extra })

    const unnamed = await expectZeroWrites(
      m.db,
      events,
      run({
        selections: [
          { docVersionId: a.id, selection: 'accepted' },
          { docVersionId: b.id, selection: 'accepted' },
          { docVersionId: c.id, selection: 'accepted' },
        ],
        comments: [{ commentText: 'which doc?', anchorRequest: { quote: 'steps' } }],
      }),
    )
    expect(unnamed.code).toBe('review-doc-version-required')
    expect(unnamed.status).toBe(422)
    expect((unnamed.details as { index: number }).index).toBe(0)

    const incomplete = await expectZeroWrites(
      m.db,
      events,
      run({
        selections: [
          { docVersionId: a.id, selection: 'accepted' },
          { docVersionId: b.id, selection: 'not_accepted' },
        ],
      }),
    )
    expect(incomplete.code).toBe('review-selection-incomplete')
    expect(incomplete.status).toBe(409)

    const foreign = await expectZeroWrites(
      m.db,
      events,
      run({
        selections: [{ docVersionId: 'not-a-member', selection: 'accepted' }],
      }),
    )
    expect(foreign.code).toBe('doc-version-not-found')

    // A refusal AFTER a valid selection in the same batch still writes nothing.
    const mixed = await expectZeroWrites(
      m.db,
      events,
      run({
        selections: [
          { docVersionId: a.id, selection: 'accepted' },
          { docVersionId: b.id, selection: 'accepted' },
          { docVersionId: c.id, selection: 'accepted' },
        ],
        comments: [
          { docVersionId: c.id, commentText: 'bad', anchorRequest: { quote: 'absent text' } },
        ],
      }),
    )
    expect(mixed.code).toBe('review-anchor-not-found')
    expect(m.docs.map((d) => d.selection)).toEqual(['unselected', 'unselected', 'unselected'])
  })
})

// ---------------------------------------------------------------------------
// AC-14 over REST — the wire shape and the schema-level refusals
// ---------------------------------------------------------------------------

describe('RFC-326 AC-14 — POST /api/reviews/:id/decision with a batch', () => {
  let m: MultiFixture
  let f: SingleFixture
  let events: ReturnType<typeof countTaskEvents>
  let previousAppHome: string | undefined
  beforeEach(() => {
    previousAppHome = process.env.AGENT_WORKFLOW_HOME
  })
  afterEach(() => {
    events?.stop()
    m?.cleanup()
    f?.cleanup()
    if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousAppHome
  })

  async function post(db: DbClient, path: string, body: unknown) {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db,
    })
    const res = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
      }),
    )
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  test('selections + comments land in one request; the response carries the counters', async () => {
    // The HTTP route returns the durable continuation receipt; the scheduler
    // wake itself remains outside this response contract.
    m = await buildMulti('list<path<md>>', 'running')
    process.env.AGENT_WORKFLOW_HOME = m.appHome
    events = countTaskEvents(m.taskId)
    const [a, b, c] = m.docs as [
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
      typeof docVersions.$inferSelect,
    ]
    const { status, json } = await post(m.db, `/api/reviews/${m.reviewRunId}/decision`, {
      decision: 'approved',
      reviewIteration: 0,
      selections: [
        { docVersionId: a.id, selection: 'accepted' },
        { docVersionId: b.id, selection: 'not_accepted' },
        { docVersionId: c.id, selection: 'not_accepted' },
      ],
      comments: [
        { docVersionId: b.id, quote: 'steps for cases/b.md', commentText: 'why b is out' },
        { docVersionId: b.id, quote: 'steps for cases/b.md', commentText: 'why b is out' },
      ],
    })
    expect(status).toBe(200)
    expect(json).toMatchObject({
      ok: true,
      taskId: m.taskId,
      reviewIteration: 0,
      receipt: {
        gate: { kind: 'review', ref: `review:${m.reviewRunId}` },
        gateRevision: 2,
        replayed: false,
      },
      commentsAdded: 1,
      commentsSkippedAsDuplicate: 1,
      selectionsApplied: 3,
    })
    expect(json.resume).toBeUndefined()
    expect(json.resumeRequired).toBeUndefined()
    const accepted = (
      await m.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, m.reviewRunId))
    ).find((o) => o.portName === 'accepted')!
    expect(accepted.content).toBe('cases/a.md')
    const rowB = (await m.db.select().from(docVersions).where(eq(docVersions.id, b.id)))[0]!
    expect(
      (JSON.parse(rowB.commentsJson) as Array<{ commentText: string }>).map((x) => x.commentText),
    ).toEqual(['why b is out'])
  })

  test('schema refusals (duplicate docVersionId / oversized batch / both anchor forms) are 422 with zero writes', async () => {
    m = await buildMulti('list<path<md>>', 'running')
    process.env.AGENT_WORKFLOW_HOME = m.appHome
    events = countTaskEvents(m.taskId)
    const a = m.docs[0]!
    const before = await snapshot(m.db)
    const bodies: unknown[] = [
      {
        decision: 'approved',
        reviewIteration: 0,
        selections: [
          { docVersionId: a.id, selection: 'accepted' },
          { docVersionId: a.id, selection: 'not_accepted' },
        ],
      },
      {
        decision: 'approved',
        reviewIteration: 0,
        comments: Array.from({ length: 201 }, () => ({
          docVersionId: a.id,
          quote: 'steps',
          commentText: 'x',
        })),
      },
      {
        decision: 'approved',
        reviewIteration: 0,
        selections: Array.from({ length: 501 }, () => ({
          docVersionId: a.id,
          selection: 'accepted',
        })),
      },
      {
        decision: 'iterated',
        reviewIteration: 0,
        comments: [
          {
            docVersionId: a.id,
            quote: 'steps',
            anchor: webAnchor(bodyFor('cases/a.md'), 'steps'),
            commentText: 'both',
          },
        ],
      },
      { decision: 'rejected', reviewIteration: 0 },
    ]
    for (const body of bodies) {
      const { status, json } = await post(m.db, `/api/reviews/${m.reviewRunId}/decision`, body)
      expect(status).toBe(422)
      expect(json.code).toBe('review-decision-invalid')
    }
    expect(await snapshot(m.db)).toEqual(before)
    expect(events.count()).toBe(0)
  })

  test('service-level refusals surface with their own code over REST (single-document)', async () => {
    f = await buildSingle('running')
    process.env.AGENT_WORKFLOW_HOME = f.appHome
    events = countTaskEvents(f.taskId)
    const before = await snapshot(f.db)
    const { status, json } = await post(f.db, `/api/reviews/${f.reviewRunId}/decision`, {
      decision: 'iterated',
      reviewIteration: 0,
      comments: [{ quote: 'enum', commentText: 'ambiguous on purpose' }],
    })
    expect(status).toBe(422)
    expect(json.code).toBe('review-anchor-ambiguous')
    expect(String(json.message)).toContain('comments[0]:')
    expect(await snapshot(f.db)).toEqual(before)
    expect(events.count()).toBe(0)
  })
})
