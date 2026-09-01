// RFC-326 — the review gate over MCP (proposal AC-21 / 22 / 23 / 24 / 25 / 27;
// design §8).
//
// WHY THIS FILE EXISTS (regression intent):
//   - AC-21: the gate tool table carries the seven review tools plus the widened
//     `submit_review` (its `decision` enum is the SHARED one — `iterate` used to
//     be accepted by the tool and refused by the route, so iterate-over-MCP was
//     impossible); reads need no point, writes need `tasks:execute`.
//   - AC-22: every tool really dispatches through the route table (no service
//     shortcut): each one is exercised against a review fixture through the same
//     dispatcher the daemon uses, and `submit_review` lands all three decisions
//     with comments / selections.
//   - AC-23: a read-only token is not shown the write tools and a hard call is
//     the SDK's unknown-tool error, not a 403 (D8 unchanged).
//   - AC-24: an ambiguous / unknown quote comes back as a refusal whose text keeps
//     the candidate keys (occurrence numbers) after the D9 redactor.
//   - AC-25: audit rows name the tool AND the review (`reviews` / nodeRunId);
//     `list_pending_gates` names `human-gates`; a tool without an identity hook
//     falls back to its `kind` / `id` arguments.
//   - AC-27: every id is path-encoded before it reaches the dispatcher.
//   - The decision route hands the acting user to the service (P16) — pinned by
//     source text, since the service-level re-check is only observable in races.

import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { DEFAULT_CONFIG, SubmitReviewDecisionSchema, type Permission } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  workflows,
} from '../src/db/schema'
import { createCollaborationCommandContext } from '../src/modules/collaboration/composition'
import { createSqliteReviewDecisionCommand } from '../src/modules/collaboration/composition/legacySqliteDecisionCommands'
import { composeTaskExecutionTestRuntime } from './helpers/taskExecutionTestTopology'
import {
  ALL_TOOLS,
  McpCallError,
  describeCapabilities,
  toolsFor,
  type McpToolContext,
  type McpToolDef,
} from '../src/mcp/tools'
import { createApp } from '../src/server'
import { createBoundOperationInvoker } from '../src/platform/operations/boundOperationInvoker'
import type { OperationInvoker } from '../src/platform/operations/contracts'
import { listTokenAuditForUser } from '../src/services/tokenAudit'
import { createUser } from '../src/services/users'
import {
  operationHandlesForInvoker,
  mcpTestOperationActor,
  recordingOperationHandles,
  type RecordedOperationCall,
} from './helpers/mcpOperationRecording'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)
const NOW = 1_700_000_000_000

const READ_TOOLS = ['list_reviews', 'get_review', 'get_review_document', 'list_review_history']
const WRITE_TOOLS = [
  'add_review_comment',
  'update_review_comment',
  'delete_review_comment',
  'set_review_document_selection',
  'submit_review',
]

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

function toolNamed(name: string): McpToolDef {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool
}

// ---------------------------------------------------------------------------
// Harness: real dispatcher + review fixture owned by the PAT user
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  configPath: string
  userId: string
  invokeFor: (actor: Actor) => OperationInvoker
  cleanup: () => void
}

let previousAppHome: string | undefined

async function harness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc326-mcp-'))
  const appHome = join(tmp, 'appHome')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  previousAppHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  const configPath = join(tmp, 'config.json')
  writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, mcpSurfaceEnabled: true }))
  const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'ready' })
  const user = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    password: 'pw12345678',
  })
  const taskExecutionRuntime = composeTaskExecutionTestRuntime(db)
  const deps = {
    token: DAEMON_TOKEN,
    configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
    schedulerDriver: taskExecutionRuntime.schedulerDriver,
    taskExecutionReadModels: taskExecutionRuntime.readModels,
    collaborationContext: createCollaborationCommandContext({
      db,
      appHome,
      taskExecutionReadModels: taskExecutionRuntime.readModels,
      reviewDecisions: createSqliteReviewDecisionCommand({ db, appHome }),
    }),
  }
  const app = createApp(deps)
  return {
    db,
    appHome,
    configPath,
    userId: user.id,
    invokeFor: (actor) => createBoundOperationInvoker(app, mcpTestOperationActor(actor)),
    cleanup: () => {
      db.$client.close()
      rmSync(tmp, { recursive: true, force: true })
      if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousAppHome
    },
  }
}

function patActor(h: Harness, scopes: ReadonlyArray<Permission>): Actor {
  return buildActor({
    user: { id: h.userId, username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
    source: 'pat',
    patScopes: scopes,
    patPurpose: 'mcp_only',
  })
}

interface ReviewFixture {
  taskId: string
  reviewRunId: string
  docIds: string[]
}

/** A pending review on a task the PAT user owns. */
async function seedReview(
  h: Harness,
  mode: 'single' | 'multi-path',
  bodies: string[] = [SINGLE_BODY],
): Promise<ReviewFixture> {
  const workflowId = ulid()
  const definition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' },
      { id: 'rev_1', kind: 'review', inputSource: { nodeId: 'doc', portName: 'docpath' } },
    ],
    edges: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await h.db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.appHome,
    worktreePath: h.appHome,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: NOW,
    ownerUserId: h.userId,
  })
  await h.db.insert(taskCollaborators).values({
    taskId,
    userId: h.userId,
    role: 'owner',
    addedBy: h.userId,
    addedAt: NOW,
  })
  const docRunId = ulid()
  await h.db.insert(nodeRuns).values({
    id: docRunId,
    taskId,
    nodeId: 'doc',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: NOW - 1000,
    finishedAt: NOW - 900,
  })
  await h.db.insert(nodeRunOutputs).values({
    nodeRunId: docRunId,
    portName: 'docpath',
    content: mode === 'single' ? SINGLE_BODY : bodies.map((_, i) => `cases/${i}.md`).join('\n'),
  })
  const reviewRunId = ulid()
  await h.db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: NOW - 50,
  })
  const docIds: string[] = []
  for (const [i, body] of bodies.entries()) {
    const id = ulid()
    const bodyPath = `doc_versions/${id}.md`
    writeFileSync(join(h.appHome, bodyPath), body)
    await h.db.insert(docVersions).values({
      id,
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath,
      decision: 'pending',
      ...(mode === 'single'
        ? {}
        : { itemIndex: i, itemPath: `cases/${i}.md`, selection: 'unselected' as const }),
    })
    docIds.push(id)
  }
  return { taskId, reviewRunId, docIds }
}

function ctxFor(h: Harness, actor: Actor, toolName: string): McpToolContext {
  return {
    actor,
    operations: operationHandlesForInvoker(toolName, h.invokeFor(actor)),
    progress: async () => {},
    signal: new AbortController().signal,
  }
}

async function call(
  h: Harness,
  actor: Actor,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return toolNamed(name).handler(args, ctxFor(h, actor, name))
}

async function refusalOf(fn: () => Promise<unknown>): Promise<McpCallError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof McpCallError) return err
    throw err
  }
  throw new Error('expected an McpCallError')
}

// ---------------------------------------------------------------------------
// AC-21 — the tool table
// ---------------------------------------------------------------------------

describe('RFC-326 AC-21 — the review tools and their tiers', () => {
  test('all nine review tools exist; reads need no point, writes need tasks:execute', () => {
    for (const name of READ_TOOLS) expect(toolNamed(name).permissions).toEqual([])
    for (const name of WRITE_TOOLS) expect(toolNamed(name).permissions).toEqual(['tasks:execute'])
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(toolNamed(name).description.length, name).toBeGreaterThan(40)
      expect(toolNamed(name).audit?.({ nodeRunId: 'r1' })).toEqual(
        name === 'list_reviews' ? { kind: 'reviews' } : { kind: 'reviews', id: 'r1' },
      )
    }
    expect(toolNamed('list_pending_gates').audit?.({})).toEqual({ kind: 'human-gates' })
  })

  test('submit_review takes the SHARED decision enum and mirrors the wire keys', () => {
    const schema = z.object(toolNamed('submit_review').inputSchema)
    const base = { nodeRunId: 'r1', reviewIteration: 0 }
    expect(schema.safeParse({ ...base, decision: 'iterated' }).success).toBe(true)
    expect(schema.safeParse({ ...base, decision: 'approved' }).success).toBe(true)
    expect(schema.safeParse({ ...base, decision: 'rejected', rejectReason: 'x' }).success).toBe(
      true,
    )
    // The value the pre-RFC-326 tool advertised and the route never accepted.
    expect(schema.safeParse({ ...base, decision: 'iterate' }).success).toBe(false)
    // The shared schema is refined (twice); unwrap to the object underneath.
    type Wrapped = { shape?: Record<string, unknown>; innerType?: () => Wrapped }
    let wire = SubmitReviewDecisionSchema as unknown as Wrapped
    while (wire.shape === undefined && wire.innerType !== undefined) wire = wire.innerType()
    const wireKeys = Object.keys(wire.shape ?? {}).sort()
    expect(wireKeys.length).toBeGreaterThan(0)
    expect(Object.keys(toolNamed('submit_review').inputSchema).sort()).toEqual(
      [...wireKeys, 'nodeRunId'].sort(),
    )
    expect(
      schema.safeParse({
        ...base,
        decision: 'approved',
        comments: [{ commentText: 'x', quote: 'enum', occurrence: 1 }],
        selections: [{ docVersionId: 'd', selection: 'accepted' }],
      }).success,
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC-22 — every tool through the real route table
// ---------------------------------------------------------------------------

describe('RFC-326 AC-22 — each review tool dispatches through the route table', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('reads: list_reviews / get_review / list_review_history / get_review_document', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const reader = patActor(h, [])

    const pending = (await call(h, reader, 'list_reviews', {})) as Array<{ nodeRunId: string }>
    expect(pending.map((r) => r.nodeRunId)).toContain(fx.reviewRunId)
    const byTask = (await call(h, reader, 'list_reviews', {
      taskId: fx.taskId,
      status: 'all',
      limit: 5,
    })) as Array<{ nodeRunId: string }>
    expect(byTask.map((r) => r.nodeRunId)).toEqual([fx.reviewRunId])
    const none = (await call(h, reader, 'list_reviews', { taskId: 'no-such-task' })) as unknown[]
    expect(none).toEqual([])

    const detail = (await call(h, reader, 'get_review', { nodeRunId: fx.reviewRunId })) as {
      currentBody: string
      summary: { reviewIteration: number }
      comments: unknown[]
    }
    expect(detail.currentBody).toBe(SINGLE_BODY)
    expect(detail.summary.reviewIteration).toBe(0)

    const history = (await call(h, reader, 'list_review_history', {
      nodeRunId: fx.reviewRunId,
    })) as { versions: Array<{ id: string }>; rounds: unknown[] }
    expect(history.versions.map((v) => v.id)).toEqual(fx.docIds)
    expect(Array.isArray(history.rounds)).toBe(true)

    const doc = (await call(h, reader, 'get_review_document', {
      nodeRunId: fx.reviewRunId,
      docVersionId: fx.docIds[0],
    })) as { body: string }
    expect(doc.body).toBe(SINGLE_BODY)
  })

  test('writes: add → update → delete a comment; iterate with a batch', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const writer = patActor(h, ['tasks:execute'])

    const created = (await call(h, writer, 'add_review_comment', {
      nodeRunId: fx.reviewRunId,
      quote: 'partially_refunded',
      commentText: 'name the state',
    })) as {
      id: string
      anchor: { occurrenceIndex: number; offsetStart: number }
      warnings: string[]
    }
    expect(created.anchor.occurrenceIndex).toBe(1)
    expect(created.anchor.offsetStart).toBe(SINGLE_BODY.indexOf('partially_refunded'))
    expect(created.warnings).toEqual([])

    const updated = (await call(h, writer, 'update_review_comment', {
      nodeRunId: fx.reviewRunId,
      commentId: created.id,
      commentText: 'name the state explicitly',
    })) as { commentText: string }
    expect(updated.commentText).toBe('name the state explicitly')

    await call(h, writer, 'delete_review_comment', {
      nodeRunId: fx.reviewRunId,
      commentId: created.id,
    })
    expect(await h.db.select().from(reviewComments)).toEqual([])

    const decided = (await call(h, writer, 'submit_review', {
      nodeRunId: fx.reviewRunId,
      decision: 'iterated',
      reviewIteration: 0,
      comments: [
        { commentText: 'first', quote: 'export job' },
        { commentText: 'second', quote: 'enum', section: 'Notes' },
      ],
    })) as { ok: boolean; reviewIteration: number; commentsAdded: number }
    expect(decided.ok).toBe(true)
    expect(decided.reviewIteration).toBe(1)
    expect(decided.commentsAdded).toBe(2)
    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, fx.docIds[0]!)))[0]!
    expect(dv.decision).toBe('iterated')
    expect((JSON.parse(dv.commentsJson) as unknown[]).length).toBe(2)
    expect(dv.decidedBy).toBe(h.userId)
    expect(dv.decidedByRole).toBe('owner')
  })

  test('multi-document: set_review_document_selection, then approve with selections + comments', async () => {
    h = await harness()
    const fx = await seedReview(h, 'multi-path', [
      '# A\n\nalpha text\n',
      '# B\n\nbeta text\n',
      '# C\n\ngamma text\n',
    ])
    const writer = patActor(h, ['tasks:execute'])
    const [a, b, c] = fx.docIds as [string, string, string]

    const picked = (await call(h, writer, 'set_review_document_selection', {
      nodeRunId: fx.reviewRunId,
      docVersionId: a,
      selection: 'accepted',
    })) as { ok: boolean }
    expect(picked.ok).toBe(true)

    // The comment names its document; the missing-document rule reaches the model verbatim.
    const unnamed = await refusalOf(() =>
      call(h, writer, 'add_review_comment', {
        nodeRunId: fx.reviewRunId,
        quote: 'beta',
        commentText: 'x',
      }),
    )
    expect(unnamed.code).toBe('review-doc-version-required')

    const decided = (await call(h, writer, 'submit_review', {
      nodeRunId: fx.reviewRunId,
      decision: 'approved',
      reviewIteration: 0,
      selections: [
        { docVersionId: b, selection: 'not_accepted' },
        { docVersionId: c, selection: 'accepted' },
      ],
      comments: [{ docVersionId: b, quote: 'beta', commentText: 'why b is out' }],
    })) as { ok: boolean; selectionsApplied: number; commentsAdded: number }
    expect(decided).toMatchObject({ ok: true, selectionsApplied: 2, commentsAdded: 1 })
    const accepted = (
      await h.db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, fx.reviewRunId))
    ).find((o) => o.portName === 'accepted')!
    expect(accepted.content).toBe('cases/0.md\ncases/2.md')
  })

  test('reject with a reason and a comment', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const writer = patActor(h, ['tasks:execute'])
    const decided = (await call(h, writer, 'submit_review', {
      nodeRunId: fx.reviewRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      reviewIteration: 0,
      comments: [{ commentText: 'overall', quote: undefined }],
    })) as { ok: boolean; commentsAdded: number }
    expect(decided).toMatchObject({ ok: true, commentsAdded: 1 })
    const dv = (await h.db.select().from(docVersions).where(eq(docVersions.id, fx.docIds[0]!)))[0]!
    expect(dv.decision).toBe('rejected')
    expect(dv.decisionReason).toBe('wrong direction')
    const archived = JSON.parse(dv.commentsJson) as Array<{ anchor: { selectedText: string } }>
    expect(archived[0]!.anchor.selectedText).toBe('Design v1') // document-level → the title
  })

  test('a token without tasks:execute is refused by the route gate, not by the tool', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const reader = patActor(h, [])
    const err = await refusalOf(() =>
      call(h, reader, 'add_review_comment', {
        nodeRunId: fx.reviewRunId,
        quote: 'enum',
        occurrence: 1,
        commentText: 'x',
      }),
    )
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(await h.db.select().from(reviewComments)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC-24 / AC-27 — refusal texts keep their keys; ids are path-encoded
// ---------------------------------------------------------------------------

describe('RFC-326 AC-24 — refusals a model can act on', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('ambiguous quote: the candidates ride in the message with their global occurrence numbers', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const writer = patActor(h, ['tasks:execute'])
    const err = await refusalOf(() =>
      call(h, writer, 'add_review_comment', {
        nodeRunId: fx.reviewRunId,
        quote: 'enum',
        commentText: 'x',
      }),
    )
    expect(err.status).toBe(422)
    expect(err.code).toBe('review-anchor-ambiguous')
    expect(err.message).toContain('occurrence 1')
    expect(err.message).toContain('occurrence 2')
    expect(err.message).toContain('## Notes')
  })

  test('unknown quote: near-miss suggestions ride in the message', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const writer = patActor(h, ['tasks:execute'])
    const err = await refusalOf(() =>
      call(h, writer, 'add_review_comment', {
        nodeRunId: fx.reviewRunId,
        quote: 'ENUM SHOULD include',
        commentText: 'x',
      }),
    )
    expect(err.code).toBe('review-anchor-not-found')
    expect(err.message).toContain('enum should include')
  })

  // 实现门 P1#9：上面两条走的是 handler,绕过了 MCP 的 `toolError` 包装与 D9
  // `redactErrorText`。真正到模型手里的是**脱敏之后**的那段文本——它才是「模型
  // 能照着改」这条验收标准的被测面。redactor 若哪天把 occurrence / sectionPath /
  // offsetStart 一起抹掉,或者反过来把内部 details 泄出去,只有这条会红。
  test('over a real tools/call: ambiguous / not-found keep their actionable keys after redaction', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const pat = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'rw',
      scopes: ['tasks:execute'],
      purpose: 'mcp_only',
    })

    const ambiguous = await rpc(h, pat.token, 'tools/call', {
      name: 'add_review_comment',
      arguments: { nodeRunId: fx.reviewRunId, quote: 'enum', commentText: 'x' },
    })
    expect(ambiguous.result?.isError).toBe(true)
    const ambiguousText = ambiguous.result?.content?.map((c) => c.text).join('\n') ?? ''
    expect(ambiguousText).toContain('review-anchor-ambiguous')
    // 候选逐条可用:全局 occurrence 序号 + 章节路径 + 源文偏移,三样缺一不可
    // ——少任何一样,模型都只能靠猜第二次调用的参数。
    expect(ambiguousText).toContain('occurrence 1')
    expect(ambiguousText).toContain('occurrence 2')
    expect(ambiguousText).toContain('## Notes')
    // 源文偏移以 `@<offset>` 形态给出(reviewAnchor.ts describeCandidates)。
    expect(/·\s*@\d+\s*·/.test(ambiguousText), ambiguousText).toBe(true)
    // 脱敏不得把内部实现细节带出去(栈、SQL、绝对路径)。
    expect(ambiguousText).not.toContain('/Users/')
    expect(ambiguousText.toLowerCase()).not.toContain('select ')
    expect(ambiguousText).not.toContain('at Object.')

    const notFound = await rpc(h, pat.token, 'tools/call', {
      name: 'add_review_comment',
      arguments: {
        nodeRunId: fx.reviewRunId,
        quote: 'ENUM SHOULD include',
        occurrence: 1,
        commentText: 'x',
      },
    })
    expect(notFound.result?.isError).toBe(true)
    const notFoundText = notFound.result?.content?.map((c) => c.text).join('\n') ?? ''
    expect(notFoundText).toContain('review-anchor-not-found')
    // 近似候选必须活过 redactor:它是模型下一次调用的唯一线索。
    expect(notFoundText).toContain('enum should include')
    expect(notFoundText).not.toContain('/Users/')

    // 两次都被拒 ⇒ 零写入。
    expect(await h.db.select().from(reviewComments)).toEqual([])
  })
})

describe('RFC-326 AC-27 — every id is encoded before it reaches the dispatcher', () => {
  test('nodeRunId / docVersionId / commentId', async () => {
    const calls: string[] = []
    const recorded: RecordedOperationCall[] = []
    const ctxForTool = (toolName: string): McpToolContext => ({
      actor: {} as Actor,
      operations: recordingOperationHandles(toolName, recorded, (operation) => {
        calls.push(`${operation.method} ${operation.path}`)
        return {}
      }),
      progress: async () => {},
      signal: new AbortController().signal,
    })
    await toolNamed('get_review_document').handler(
      { nodeRunId: '../workflows', docVersionId: 'x/../y' },
      ctxForTool('get_review_document'),
    )
    await toolNamed('update_review_comment').handler(
      { nodeRunId: 'r 1', commentId: 'c/2', commentText: 'x' },
      ctxForTool('update_review_comment'),
    )
    await toolNamed('set_review_document_selection').handler(
      { nodeRunId: 'r', docVersionId: '../../users', selection: 'accepted' },
      ctxForTool('set_review_document_selection'),
    )
    expect(calls).toEqual([
      'GET /api/reviews/..%2Fworkflows/versions/x%2F..%2Fy',
      'PATCH /api/reviews/r%201/comments/c%2F2',
      'PATCH /api/reviews/r/documents/..%2F..%2Fusers/selection',
    ])
  })
})

// ---------------------------------------------------------------------------
// AC-23 / AC-25 — the real transport: tools/list, unknown-tool, audit rows
// ---------------------------------------------------------------------------

interface RpcFrame {
  result?: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> }
  error?: { code: number; message: string }
}

async function rpc(
  h: Harness,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcFrame> {
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: h.configPath,
    opencodeVersion: null,
    dbVersion: 1,
    db: h.db,
    secretBox: createSecretBoxFromKey(randomBytes(32)),
  })
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse(line === undefined ? text : line.slice('data: '.length)) as RpcFrame
}

describe('RFC-326 AC-23 / AC-25 — over the Streamable HTTP transport', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('read-only token: tools/list omits the write tools; a hard call is the SDK unknown-tool error (D8)', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const readOnly = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'ro',
      scopes: [],
      purpose: 'mcp_only',
    })
    expect(toolsFor(patActor(h, [])).map((t) => t.name)).toEqual(expect.arrayContaining(READ_TOOLS))
    for (const name of WRITE_TOOLS) {
      expect(toolsFor(patActor(h, [])).map((t) => t.name)).not.toContain(name)
    }
    const listed = await rpc(h, readOnly.token, 'tools/list', {})
    const names = (listed.result?.tools ?? []).map((t) => t.name)
    for (const name of READ_TOOLS) expect(names).toContain(name)
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name)

    const hard = await rpc(h, readOnly.token, 'tools/call', {
      name: 'add_review_comment',
      arguments: { nodeRunId: fx.reviewRunId, quote: 'enum', occurrence: 1, commentText: 'x' },
    })
    // The SDK answers an unregistered tool either as a JSON-RPC error or as an
    // `isError` result — both name the tool and say "not found"; neither is a 403.
    const refusalText =
      hard.error?.message ?? hard.result?.content?.map((c) => c.text).join('\n') ?? ''
    if (hard.error === undefined) expect(hard.result?.isError).toBe(true)
    expect(refusalText).toContain('add_review_comment')
    expect(refusalText.toLowerCase()).toContain('not found')
    expect(refusalText.toLowerCase()).not.toContain('permission denied')
    expect(await h.db.select().from(reviewComments)).toEqual([])
  })

  // 实现门 P2#14（AC-22）：只读 token 被拒之后,唯一能自救的线索是
  // `describe_capabilities` 报出「缺的是哪个点」。评审五个写工具全部挂在
  // `tasks:execute` 上——这条把「工具被藏起来」与「该去申请什么」对上。
  test('read-only token: describe_capabilities names tasks:execute as the missing point', async () => {
    h = await harness()
    const caps = describeCapabilities(patActor(h, []))
    // 空矩阵 PAT 仍持有全部读点(RFC-247 D3「读面恒开」),但写点一个都没有。
    expect(caps.granted).not.toContain('tasks:execute')
    const unavailable = new Map(caps.toolsUnavailable.map((u) => [u.tool, u.missing]))
    for (const name of WRITE_TOOLS) {
      expect(unavailable.get(name), `${name} 应当被报成「缺 tasks:execute」`).toEqual([
        'tasks:execute',
      ])
    }
    // 读工具不在缺失名单里(否则「缺的是 tasks:execute」这句话会变成噪音)。
    for (const name of READ_TOOLS) expect(unavailable.has(name)).toBe(false)
    // 拿到这个点之后,五个写工具都出现在 tools/list 上（守卫的守卫:
    // 否则「缺 tasks:execute」这句话本身就是错的）。
    const withPoint = toolsFor(patActor(h, ['tasks:execute'])).map((t) => t.name)
    for (const name of WRITE_TOOLS) expect(withPoint).toContain(name)
  })

  test('audit rows: reviews + nodeRunId / human-gates / argument fallback; refusal text keeps the keys after redaction', async () => {
    h = await harness()
    const fx = await seedReview(h, 'single')
    const pat = await createPat({
      db: h.db,
      userId: h.userId,
      name: 'rw',
      scopes: ['tasks:execute'],
      purpose: 'mcp_only',
    })
    const got = await rpc(h, pat.token, 'tools/call', {
      name: 'get_review',
      arguments: { nodeRunId: fx.reviewRunId },
    })
    expect(got.result?.isError).not.toBe(true)
    await rpc(h, pat.token, 'tools/call', { name: 'list_pending_gates', arguments: {} })
    await rpc(h, pat.token, 'tools/call', { name: 'describe_capabilities', arguments: {} })
    const ambiguous = await rpc(h, pat.token, 'tools/call', {
      name: 'add_review_comment',
      arguments: { nodeRunId: fx.reviewRunId, quote: 'enum', commentText: 'x' },
    })
    expect(ambiguous.result?.isError).toBe(true)
    const text = ambiguous.result?.content?.map((c) => c.text).join('\n') ?? ''
    expect(text).toContain('review-anchor-ambiguous')
    expect(text).toContain('occurrence 2')

    const rows = await listTokenAuditForUser(h.db, h.userId)
    const byTool = new Map(rows.filter((r) => r.channel === 'mcp').map((r) => [r.toolName, r]))
    expect(byTool.get('get_review')).toMatchObject({
      resourceKind: 'reviews',
      resourceId: fx.reviewRunId,
      statusCode: 200,
    })
    expect(byTool.get('add_review_comment')).toMatchObject({
      resourceKind: 'reviews',
      resourceId: fx.reviewRunId,
      statusCode: 422,
    })
    expect(byTool.get('list_pending_gates')).toMatchObject({ resourceKind: 'human-gates' })
    expect(byTool.get('list_pending_gates')?.resourceId ?? null).toBeNull()
    expect(byTool.get('describe_capabilities')?.resourceKind ?? null).toBeNull()
    expect(rows.some((r) => r.path === '/api/mcp')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P16 — the route hands the acting user to the service
// ---------------------------------------------------------------------------

describe('RFC-326 P16 — the decision route binds the acting user into the collaboration command', () => {
  test('source lock', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'routes', 'reviews.ts'), 'utf8')
    const start = src.indexOf("path: '/api/reviews/:nodeRunId/decision'")
    const end = src.indexOf('return c.json({', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain('const actor = actorOf(c)')
    expect(src.slice(start, end)).toContain('requireReviewOperations(operations).submitDecision({')
    expect(src.slice(start, end)).toContain('actor,')
    expect(src.slice(start, end)).toContain('authorRole: role,')
  })
})
