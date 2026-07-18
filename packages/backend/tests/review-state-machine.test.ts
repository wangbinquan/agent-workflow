// Locks in RFC-005 PR-B T6 + T7 + T11 review state machine.
//
// If this goes red, scheduler.runOneNode review-branch + services/review.ts
// dispatchReviewNode + submitReviewDecision are out of lock-step. RFC-005
// design.md §4 has the full state diagram.
//
// We avoid spawning real opencode by using stub-opencode (already proven by
// the e2e tests) + a tiny workflow: input → designer (agent producing
// kind=markdown 'design' port) → reviewDesign (review node) → output.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, nodeRunOutputs, nodeRuns, reviewComments, tasks } from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import {
  addReviewComment,
  countPendingReviews,
  getReviewDetail,
  listReviewSummaries,
  submitReviewDecision,
} from '../src/services/review'
import { runTask as runTaskBase } from '../src/services/scheduler'
import {
  abortAllActiveTasks,
  startTaskWithLocalRepo as startTaskWithLocalRepoBase,
} from '../src/services/task'
import { runTestGit } from './helpers/testCommand'
import { reenterScheduler } from './reenter-scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const GIT_TIMEOUT_MS = 10_000
const NODE_TIMEOUT_MS = 10_000
const FLOW_TIMEOUT_MS = 20_000

setDefaultTimeout(FLOW_TIMEOUT_MS + 10_000)

async function git(...args: string[]): Promise<void> {
  await runTestGit(args, GIT_TIMEOUT_MS)
}

function runTask(options: Parameters<typeof runTaskBase>[0]) {
  return runTaskBase({
    ...options,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

function startTaskWithLocalRepo(
  input: Parameters<typeof startTaskWithLocalRepoBase>[0],
  deps: Parameters<typeof startTaskWithLocalRepoBase>[1],
) {
  return startTaskWithLocalRepoBase(input, {
    ...deps,
    defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS,
    defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
  })
}

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  stubOpencode: string
  taskId: string
  reviewNodeRunId: string
  cleanup: () => Promise<void>
}

const REVIEW_DOC_V1 = '# Design v1\n\nThe `order_status` enum should include partially_refunded.\n'
const REVIEW_DOC_V2 =
  '# Design v2\n\nThe `order_status` enum now includes partially_refunded and pending_payment.\n'

let runIdx = 0

function makeStubOpencode(dir: string): string {
  // Stub emits a markdown design payload via the workflow-output envelope.
  // First call returns v1; subsequent calls return v2 to simulate a regen.
  const path = join(dir, 'stub-opencode.sh')
  const v1 = REVIEW_DOC_V1.replace(/\n/g, '\\n')
  const v2 = REVIEW_DOC_V2.replace(/\n/g, '\\n')
  const counterFile = join(dir, '.invoke-counter')
  writeFileSync(counterFile, '0')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then
  echo 'stub-opencode 1.14.99'
  exit 0
fi
if [[ "$1" == "run" ]]; then
  COUNTER_FILE='${counterFile}'
  N=$(cat "$COUNTER_FILE")
  N=$((N + 1))
  echo $N > "$COUNTER_FILE"
  if [[ $N -eq 1 ]]; then
    BODY='${v1}'
  else
    BODY='${v2}'
  fi
  ENV='<workflow-output><port name="design">'"$BODY"'</port></workflow-output>'
  TS=$(date +%s%3N)
  printf '{"type":"text","ts":%s,"text":"%s"}\\n' "$TS" "$ENV"
  exit 0
fi
echo "unknown subcommand $1"
exit 1
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

async function buildHarness(): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-review-state-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME

  // Set up a real git repo so worktree creation actually works.
  await git('-C', tmp, 'init', '-b', 'main')
  mkdirSync(repoPath, { recursive: true })
  await git('-C', repoPath, 'init', '-b', 'main')
  await git('-C', repoPath, 'config', 'user.email', 't@t.test')
  await git('-C', repoPath, 'config', 'user.name', 't')
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await git('-C', repoPath, 'add', '.')
  await git('-C', repoPath, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'init')

  const stubOpencode = makeStubOpencode(tmp)

  // Designer agent — markdown output kind on the 'design' port so review can
  // resolve it (T9 markdown_file path / inline markdown).
  await createAgent(db, {
    name: 'designer',
    description: '',
    outputs: ['design'],
    outputKinds: { design: 'markdown' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })

  // Workflow: input → designer → reviewDesign → output.
  const wf = await createWorkflow(db, {
    name: 'design-pipeline',
    description: '',
    definition: {
      $schema_version: 2,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic' },
        {
          id: 'designer',
          kind: 'agent-single',
          agentName: 'designer',
          promptTemplate: 'Design for {{topic}}',
        },
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
          rerunnableOnReject: ['designer'],
          rerunnableOnIterate: ['designer'],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'designer', portName: 'topic' },
        },
      ],
    },
  })

  // Override Paths.root via env so the doc_version files land under our temp.
  process.env.AGENT_WORKFLOW_HOME = appHome

  const task = await startTaskWithLocalRepo(
    {
      workflowId: wf.id,
      name: 'fixture-task',
      repoPath,
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    },
    { db, appHome, opencodeCmd: [stubOpencode], awaitScheduler: true },
  )

  // Locate the review node_run row.
  const reviewRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'rev_1')))
  if (reviewRuns.length === 0) {
    throw new Error('review node_run not created by scheduler')
  }

  return {
    db,
    appHome,
    repoPath,
    stubOpencode,
    taskId: task.id,
    reviewNodeRunId: reviewRuns[0]!.id,
    cleanup: async () => {
      try {
        db.$client.close()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
        else process.env.AGENT_WORKFLOW_HOME = previousAppHome
      }
    },
  }
}

describe('RFC-005 review state machine — dispatch + decisions', () => {
  let h: Harness
  let cleanupHarness: (() => Promise<void>) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  beforeEach(async () => {
    cleanupHarness = undefined
    watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
    h = await buildHarness()
    cleanupHarness = h.cleanup
  })
  afterEach(async () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    abortAllActiveTasks('test-cleanup')
    await cleanupHarness?.()
  })

  test('scheduler parks review at awaiting_review + creates doc_version v1', async () => {
    // After startTask runs synchronously, task should be awaiting_review.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)).limit(1))[0]
    expect(t?.status).toBe('awaiting_review')

    const run = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewNodeRunId)).limit(1)
    )[0]
    expect(run?.status).toBe('awaiting_review')
    expect(run?.reviewIteration).toBe(0)

    const dv = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dv.length).toBe(1)
    expect(dv[0]?.versionIndex).toBe(1)
    expect(dv[0]?.decision).toBe('pending')

    // Body file exists on disk + contains v1.
    const bodyAbs = join(h.appHome, dv[0]!.bodyPath)
    expect(existsSync(bodyAbs)).toBe(true)
    expect(readFileSync(bodyAbs, 'utf8')).toContain('Design v1')
  })

  test('countPendingReviews / listReviewSummaries / getReviewDetail surface the pending review', async () => {
    expect(await countPendingReviews(h.db)).toBe(1)
    const list = await listReviewSummaries(h.db, { status: 'pending' })
    expect(list.length).toBe(1)
    expect(list[0]?.nodeRunId).toBe(h.reviewNodeRunId)
    expect(list[0]?.awaitingReview).toBe(true)

    const detail = await getReviewDetail(h.db, h.appHome, h.reviewNodeRunId)
    expect(detail.summary.nodeRunId).toBe(h.reviewNodeRunId)
    expect(detail.currentVersion.versionIndex).toBe(1)
    expect(detail.currentBody).toContain('Design v1')
    expect(detail.comments).toEqual([])
  })

  test('approve flips the review run to done + clears the pending inbox', async () => {
    const result = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    expect(result.resumeRequired).toBe(true)
    expect(result.taskId).toBe(h.taskId)

    const run = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewNodeRunId)).limit(1)
    )[0]
    expect(run?.status).toBe('done')

    const dv = (
      await h.db
        .select()
        .from(docVersions)
        .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    )[0]
    expect(dv?.decision).toBe('approved')

    expect(await countPendingReviews(h.db)).toBe(0)
  })

  // Regression: approving a review used to flip status=done but never write
  // the two declared output ports (`approved_doc`, `approval_meta`) into
  // node_run_outputs. Downstream output bindings + the task-detail
  // TaskOutputPanel then rendered "等待中…" forever even though the review
  // was complete. RFC-005 design.md §2.2 + workflow.validator.ts declare
  // these ports exist; this test locks in that we actually produce rows.
  test('approve writes approved_doc + approval_meta into node_run_outputs', async () => {
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })

    const outRows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewNodeRunId))
    const byPort = new Map(outRows.map((r) => [r.portName, r.content]))
    expect(byPort.size).toBe(2)
    // The stub script writes the body with literal "\n" escapes (matches the
    // existing dispatch test's contract); we just assert the design body
    // landed in the row so downstream consumers can read it.
    expect(byPort.get('approved_doc')).toContain('Design v1')
    expect(byPort.get('approved_doc')).toContain('order_status')
    const metaRaw = byPort.get('approval_meta')
    expect(metaRaw).toBeDefined()
    const meta = JSON.parse(metaRaw!) as Record<string, unknown>
    expect(meta.decision).toBe('approved')
    // RFC-099 prompt isolation — no decider identity in the port payload.
    expect(meta.decidedBy).toBeUndefined()
    expect(typeof meta.decidedAt).toBe('number')
    expect(meta.reviewIteration).toBe(0)
    expect(meta.versionIndex).toBe(1)
    expect(meta.sourceNodeId).toBe('designer')
    expect(meta.sourcePortName).toBe('design')
  })

  // Regression: when upstream port kind is `markdown_file` (= the agent
  // emitted a worktree-relative path, framework resolved the body for the
  // reviewer), approving used to publish the resolved body into
  // approved_doc. Downstream nodes declared to consume `markdown_file`
  // would then see raw markdown text where they expected a path and
  // fail. Mirror the upstream shape: when doc_version.sourceFilePath is
  // set, approved_doc must re-emit the same path.
  test('approve preserves upstream shape — markdown_file path passes through to approved_doc', async () => {
    // Inject a sourceFilePath onto the pending v1 doc_version to simulate
    // an upstream that emitted `markdown_file`. Existing harness produces
    // inline markdown; we don't need a second harness for this assertion.
    const pendingPath = 'docs/design-v1.md'
    await h.db
      .update(docVersions)
      .set({ sourceFilePath: pendingPath })
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
      author: 'tester',
    })

    const outRows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, h.reviewNodeRunId))
    const byPort = new Map(outRows.map((r) => [r.portName, r.content]))
    expect(byPort.get('approved_doc')).toBe(pendingPath)
    // Must NOT have inlined the body — that's exactly the bug this guards.
    expect(byPort.get('approved_doc')).not.toContain('Design v1')
  })

  test('reject archives v1 comments, bumps reviewIteration, mints a new pending upstream run (RFC-011)', async () => {
    // Drop a comment on v1 so we can verify it gets archived.
    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Design v1',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 12,
        selectedText: 'order_status',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'narrow direction',
    })

    const result = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })
    expect(result.resumeRequired).toBe(true)
    expect(result.reviewIteration).toBe(1)

    const run = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewNodeRunId)).limit(1)
    )[0]
    expect(run?.status).toBe('pending')
    expect(run?.reviewIteration).toBe(1)

    // v1 doc_version archived rejected with reason + comments JSON snapshot.
    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dvs.length).toBe(1)
    expect(dvs[0]?.decision).toBe('rejected')
    expect(dvs[0]?.decisionReason).toContain('wrong direction')
    const archivedComments = JSON.parse(dvs[0]!.commentsJson) as unknown[]
    expect(archivedComments.length).toBe(1)

    // review_comments row deleted on archive.
    const remaining = await h.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, dvs[0]!.id))
    expect(remaining.length).toBe(0)

    // RFC-011: instead of resetting the latest designer row in place, the
    // review code now mints a fresh node_run at retry_index+1 and marks the
    // old row canceled with a stable supersede prefix on errorMessage. This
    // preserves the v1 promptText for the Prompt-tab attempts switcher.
    const upRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'designer')))
    const tops = upRuns.filter((r) => r.parentNodeRunId === null)
    expect(tops.length).toBe(2)
    const old = tops.find((r) => r.retryIndex === 0)
    const fresh = tops.find((r) => r.retryIndex === 1)
    expect(old?.status).toBe('canceled')
    expect(old?.errorMessage).toContain('superseded-by-review-rejected')
    expect(old?.promptText).not.toBeNull() // v1 prompt preserved
    expect(fresh?.status).toBe('pending')
    expect(fresh?.preSnapshot).toBe(old?.preSnapshot ?? null)
  })

  test('reject + scheduler re-run produces a new doc_version v2 with reviewIteration=1', async () => {
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    // Re-enter the scheduler synchronously (mirrors what resumeTask would do).
    // RFC-097: runTask's entry CAS only claims pending tasks — reset first.
    await reenterScheduler(h.db, h.taskId)
    await runTask({
      taskId: h.taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: [h.stubOpencode],
    })

    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dvs.length).toBe(2)
    const v2 = dvs.find((d) => d.versionIndex === 2)
    expect(v2).toBeDefined()
    expect(v2?.decision).toBe('pending')
    expect(v2?.reviewIteration).toBe(1)
    const v2body = readFileSync(join(h.appHome, v2!.bodyPath), 'utf8')
    expect(v2body).toContain('Design v2')

    // After re-run task is back to awaiting_review.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)).limit(1))[0]
    expect(t?.status).toBe('awaiting_review')
  })

  test('iterate path: comments → decisionReason; upstream regenerates with iterate context', async () => {
    await addReviewComment({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      anchor: {
        sectionPath: '# Design v1',
        paragraphIdx: 0,
        offsetStart: 0,
        offsetEnd: 12,
        selectedText: 'order_status',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 1,
      },
      commentText: 'include pending_payment',
    })
    const result = await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })
    expect(result.resumeRequired).toBe(true)
    expect(result.reviewIteration).toBe(1)

    const dvs = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, h.reviewNodeRunId))
    expect(dvs[0]?.decision).toBe('iterated')
    expect(dvs[0]?.decisionReason).toContain('include pending_payment')
    // Designer agent here declares outputKinds: { design: 'markdown' }
    // (inline body), so doc_versions.source_file_path stays null and the
    // renderer must NOT emit a **File**: header. The markdown_file path is
    // covered separately by review-iterate-file-path-in-prompt.test.ts —
    // both cases together pin the conditional-header contract.
    expect(dvs[0]?.sourceFilePath).toBeNull()
    expect(dvs[0]?.decisionReason).not.toContain('**File**:')
  })

  test('optimistic-lock guard: stale reviewIteration → conflict', async () => {
    let err: Error | null = null
    try {
      await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewNodeRunId,
        decision: 'approved',
        expectedReviewIteration: 999,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('review_iteration changed')
  })

  test('decision while not in awaiting_review → conflict', async () => {
    // Approve first.
    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'approved',
      expectedReviewIteration: 0,
    })
    // Second approve should fail.
    let err: Error | null = null
    try {
      await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: h.reviewNodeRunId,
        decision: 'approved',
        expectedReviewIteration: 0,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/not awaiting_review|not-awaiting/)
  })
})

describe('RFC-005 review REST endpoints', () => {
  let h: Harness
  let cleanupHarness: (() => Promise<void>) | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  beforeEach(async () => {
    cleanupHarness = undefined
    watchdog = setTimeout(() => abortAllActiveTasks('test-timeout'), FLOW_TIMEOUT_MS)
    h = await buildHarness()
    cleanupHarness = h.cleanup
  })
  afterEach(async () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    abortAllActiveTasks('test-cleanup')
    await cleanupHarness?.()
  })

  const HEADERS = { Authorization: 'Bearer tok' }

  test('GET /api/reviews lists pending reviews + GET /:nodeRunId returns detail', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: h.db,
    })

    process.env.AGENT_WORKFLOW_HOME = h.appHome
    const listRes = await app.fetch(
      new Request('http://localhost/api/reviews?status=pending', { headers: HEADERS }),
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { nodeRunId: string; awaitingReview: boolean }[]
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0]?.awaitingReview).toBe(true)

    const detailRes = await app.fetch(
      new Request(`http://localhost/api/reviews/${h.reviewNodeRunId}`, { headers: HEADERS }),
    )
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as { currentBody: string }
    expect(detail.currentBody).toContain('Design v1')
  })

  test('GET /api/reviews/pending-count returns the badge count', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: h.db,
    })
    const res = await app.fetch(
      new Request('http://localhost/api/reviews/pending-count', { headers: HEADERS }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(1)
  })

  test('POST /api/reviews/:nodeRunId/comments + DELETE round-trip', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: h.db,
    })
    const addRes = await app.fetch(
      new Request(`http://localhost/api/reviews/${h.reviewNodeRunId}/comments`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            sectionPath: '# Design v1',
            paragraphIdx: 0,
            offsetStart: 0,
            offsetEnd: 12,
            selectedText: 'order_status',
            contextBefore: '',
            contextAfter: '',
            occurrenceIndex: 1,
          },
          commentText: 'needs polishing',
        }),
      }),
    )
    expect(addRes.status).toBe(201)
    const comment = (await addRes.json()) as { id: string }
    expect(comment.id).toBeTruthy()

    const stored = await h.db.select().from(reviewComments).where(eq(reviewComments.id, comment.id))
    expect(stored.length).toBe(1)

    const delRes = await app.fetch(
      new Request(`http://localhost/api/reviews/${h.reviewNodeRunId}/comments/${comment.id}`, {
        method: 'DELETE',
        headers: HEADERS,
      }),
    )
    expect(delRes.status).toBe(200)
    const after = await h.db.select().from(reviewComments).where(eq(reviewComments.id, comment.id))
    expect(after.length).toBe(0)
  })

  test('POST /api/reviews/:nodeRunId/decision approve → ok', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: h.db,
    })
    const res = await app.fetch(
      new Request(`http://localhost/api/reviews/${h.reviewNodeRunId}/decision`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; resumeRequired: boolean }
    expect(body.ok).toBe(true)
    expect(body.resumeRequired).toBe(true)

    const run = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, h.reviewNodeRunId)).limit(1)
    )[0]
    expect(run?.status).toBe('done')
  })

  test('POST /api/reviews/:nodeRunId/decision reject without reason → 422', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: h.db,
    })
    const res = await app.fetch(
      new Request(`http://localhost/api/reviews/${h.reviewNodeRunId}/decision`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'rejected', reviewIteration: 0 }),
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
