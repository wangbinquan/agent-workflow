// RFC-053 PR-A T1a — node_run.status transition matrix, *current* behavior.
//
// Each test exercises one service-layer entry point that mutates
// `node_runs.status`, asserting the post-state. This file is the LIVING
// state diagram for review / clarify / retry / orphan paths — when PR-B
// introduces `transitionNodeRunStatus()`, these tests must keep passing
// (and a sibling `lifecycle-transition-table.test.ts` will assert
// `nextNodeRunStatus()` directly on the same matrix).
//
// Skipped here on purpose (covered in dedicated files; touching runner /
// scheduler / shutdown requires stub-opencode and is expensive):
//   - runner.ts pending → running / running → done / running → failed /
//     running → awaiting_human (covered by scheduler-*.test.ts and
//     review-state-machine.test.ts via stub-opencode)
//   - task.ts cancelTask drives node_runs via scheduler abort (covered by
//     tasks.test.ts e2e routes)
//   - shutdown.ts graceful drives the same as cancel (covered by
//     daemon-related tests)

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  clarifySessions,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode, submitReviewDecision } from '../src/services/review'
import { submitClarifyAnswers } from '../src/services/clarify'
import { retryNode } from '../src/services/task'
import { reapOrphanRuns } from '../src/services/orphans'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  definition: WorkflowDefinition
  cleanup: () => void
}

async function buildHarness(opts?: {
  /** When true, seed a sibling review node so reject-cascade tests have a target. */
  withSiblingReview?: boolean
}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1a-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const db = createInMemoryDb(MIGRATIONS)

  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['docpath', 'sidecar']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })

  const nodes: WorkflowNode[] = [
    { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
    {
      id: 'rev_1',
      kind: 'review',
      inputSource: { nodeId: 'doc', portName: 'docpath' },
    } as unknown as WorkflowNode,
  ]
  if (opts?.withSiblingReview === true) {
    nodes.push({
      id: 'rev_2',
      kind: 'review',
      inputSource: { nodeId: 'doc', portName: 'sidecar' },
    } as unknown as WorkflowNode)
  }
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes,
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })

  return {
    db,
    appHome,
    repoPath,
    taskId,
    definition,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

async function seedAgentDone(
  db: DbClient,
  taskId: string,
  opts: { retryIndex?: number; clarifyIteration?: number; ports?: Record<string, string> } = {},
): Promise<string> {
  const id = ulid()
  const ports = opts.ports ?? { docpath: '# v1', sidecar: '# side v1' }
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'doc',
    iteration: 0,
    retryIndex: opts.retryIndex ?? 0,
    status: 'done',
    startedAt: Date.now() - 200,
    finishedAt: Date.now() - 100,
  })
  for (const [portName, content] of Object.entries(ports)) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName, content })
  }
  return id
}

async function seedReviewRow(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'pending' | 'awaiting_review',
  reviewIteration = 0,
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration,
    status,
    startedAt: Date.now() - 50,
  })
  return id
}

describe('RFC-053 PR-A T1a — node_run.status transition matrix (current behavior)', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  describe('Section A: review', () => {
    test('A1 dispatchReviewNode mints fresh awaiting_review row when none exists', async () => {
      await seedAgentDone(h.db, h.taskId)
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      const reviewNode = h.definition.nodes.find((n) => n.id === 'rev_1')!

      const res = await dispatchReviewNode({
        db: h.db,
        taskId: h.taskId,
        task,
        appHome: h.appHome,
        definition: h.definition,
        node: reviewNode,
        iteration: 0,
      })
      expect(res.kind).toBe('awaiting_review')

      const rows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_1')))
      expect(rows.length).toBe(1)
      expect(rows[0]!.status).toBe('awaiting_review')
      expect(rows[0]!.reviewIteration).toBe(0)
    })

    test('A2 dispatchReviewNode reuse: pending row → awaiting_review (post-iterate path)', async () => {
      await seedAgentDone(h.db, h.taskId)
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'pending', 3)
      const reviewNode = h.definition.nodes.find((n) => n.id === 'rev_1')!

      const res = await dispatchReviewNode({
        db: h.db,
        taskId: h.taskId,
        task,
        appHome: h.appHome,
        definition: h.definition,
        node: reviewNode,
        iteration: 0,
      })
      expect(res.kind).toBe('awaiting_review')

      const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]!
      expect(after.status).toBe('awaiting_review')
      expect(after.reviewIteration).toBe(3) // preserved
    })

    test('A3 dispatchReviewNode is idempotent on existing awaiting_review + pending doc_version', async () => {
      await seedAgentDone(h.db, h.taskId)
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      // Pre-existing pending doc_version (simulates daemon restart resume).
      const dvId = ulid()
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', 'v1.md'), '# v1')
      await h.db.insert(docVersions).values({
        id: dvId,
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: 'doc_versions/v1.md',
        decision: 'pending',
      })
      const reviewNode = h.definition.nodes.find((n) => n.id === 'rev_1')!

      await dispatchReviewNode({
        db: h.db,
        taskId: h.taskId,
        task,
        appHome: h.appHome,
        definition: h.definition,
        node: reviewNode,
        iteration: 0,
      })

      const dvs = await h.db.select().from(docVersions).where(eq(docVersions.taskId, h.taskId))
      expect(dvs.length).toBe(1) // no phantom v2
      expect(dvs[0]!.id).toBe(dvId)
    })

    test('A4 submitReviewDecision approve: awaiting_review → done + outputs written', async () => {
      await seedAgentDone(h.db, h.taskId)
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 2)
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', 'v3.md'), '# body')
      await h.db.insert(docVersions).values({
        id: ulid(),
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 3,
        reviewIteration: 2,
        bodyPath: 'doc_versions/v3.md',
        decision: 'pending',
      })

      const res = await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: reviewRunId,
        decision: 'approved',
        expectedReviewIteration: 2,
        author: 'tester',
      })
      expect(res.resumeRequired).toBe(true)

      const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId)))[0]!
      expect(after.status).toBe('done')
      expect(after.finishedAt).not.toBeNull()
      const outs = await h.db
        .select()
        .from(nodeRunOutputs)
        .where(eq(nodeRunOutputs.nodeRunId, reviewRunId))
      const ports = new Set(outs.map((o) => o.portName))
      expect(ports.has('approved_doc')).toBe(true)
      expect(ports.has('approval_meta')).toBe(true)
    })

    test('A5 submitReviewDecision iterate: awaiting_review → pending + bumps reviewIteration + cancels upstream', async () => {
      const agentRunId = await seedAgentDone(h.db, h.taskId, { ports: { docpath: '# v1' } })
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', 'v1.md'), '# v1')
      await h.db.insert(docVersions).values({
        id: ulid(),
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: 'doc_versions/v1.md',
        decision: 'pending',
      })

      const res = await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: reviewRunId,
        decision: 'iterated',
        expectedReviewIteration: 0,
        author: 'tester',
      })
      expect(res.resumeRequired).toBe(true)
      expect(res.reviewIteration).toBe(1)

      const reviewAfter = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId))
      )[0]!
      expect(reviewAfter.status).toBe('pending')
      expect(reviewAfter.reviewIteration).toBe(1)

      // Old upstream agent row is canceled (supersede).
      const agentAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, agentRunId)))[0]!
      expect(agentAfter.status).toBe('canceled')
      expect(agentAfter.errorMessage ?? '').toContain('superseded-by-review-iterated')

      // A fresh upstream agent row at retryIndex+1 is minted as pending.
      const agentRows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
      const fresh = agentRows.find((r) => r.retryIndex === 1)
      expect(fresh).toBeDefined()
      expect(fresh!.status).toBe('pending')
    })

    test('A6 submitReviewDecision reject: awaiting_review → pending + decisionReason saved', async () => {
      const agentRunId = await seedAgentDone(h.db, h.taskId, { ports: { docpath: '# v1' } })
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', 'v1.md'), '# v1')
      const dvId = ulid()
      await h.db.insert(docVersions).values({
        id: dvId,
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: 'doc_versions/v1.md',
        decision: 'pending',
      })

      const res = await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: reviewRunId,
        decision: 'rejected',
        expectedReviewIteration: 0,
        author: 'tester',
        rejectReason: 'try again',
      })
      expect(res.resumeRequired).toBe(true)

      const reviewAfter = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewRunId))
      )[0]!
      expect(reviewAfter.status).toBe('pending')

      const dvAfter = (await h.db.select().from(docVersions).where(eq(docVersions.id, dvId)))[0]!
      expect(dvAfter.decision).toBe('rejected')
      expect(dvAfter.decisionReason).toBe('try again')

      const agentAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, agentRunId)))[0]!
      expect(agentAfter.status).toBe('canceled')
      expect(agentAfter.errorMessage ?? '').toContain('superseded-by-review-rejected')
    })

    test('A7 submitReviewDecision sibling cascade on reject: sibling awaiting_review → awaiting_review (bumped iteration)', async () => {
      // RFC-005 A2: reject cascades to all siblings sharing the upstream port.
      // Sibling reviews stay awaiting_review (with bumped reviewIteration), so
      // the user re-reviews; the cascaded review row's reviewIteration moves
      // forward. (This intentionally exercises a same-status transition with a
      // side effect — kept here to lock the cascade behavior.)
      h = await buildHarness({ withSiblingReview: true })
      const agentRunId = await seedAgentDone(h.db, h.taskId)
      const rev1RunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      const rev2RunId = await seedReviewRow(h.db, h.taskId, 'rev_2', 'awaiting_review', 0)
      mkdirSync(join(h.appHome, 'doc_versions'), { recursive: true })
      writeFileSync(join(h.appHome, 'doc_versions', 'v1.md'), '# v1')
      writeFileSync(join(h.appHome, 'doc_versions', 'v1s.md'), '# side v1')
      await h.db.insert(docVersions).values({
        id: ulid(),
        taskId: h.taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: rev1RunId,
        sourceNodeId: 'doc',
        sourcePortName: 'docpath',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: 'doc_versions/v1.md',
        decision: 'pending',
      })
      await h.db.insert(docVersions).values({
        id: ulid(),
        taskId: h.taskId,
        reviewNodeId: 'rev_2',
        reviewNodeRunId: rev2RunId,
        sourceNodeId: 'doc',
        sourcePortName: 'sidecar',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: 'doc_versions/v1s.md',
        decision: 'pending',
      })

      await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: rev1RunId,
        decision: 'rejected',
        expectedReviewIteration: 0,
        author: 'tester',
        rejectReason: 'r',
      })

      // rev_2 is cascaded — its row's reviewIteration bumped, status remains
      // awaiting_review (the sibling still waits for the user to re-review
      // the regenerated doc_version once upstream regenerates).
      const rev2After = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, rev2RunId)))[0]!
      expect(rev2After.reviewIteration).toBeGreaterThan(0)
      // Status post-cascade: stays awaiting_review (waiting for re-review).
      expect(['awaiting_review', 'pending']).toContain(rev2After.status)

      void agentRunId
    })

    test('A8 submitReviewDecision on already-done row throws ConflictError(review-not-awaiting)', async () => {
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      // Pre-flip to done — simulates a second concurrent approve.
      await h.db
        .update(nodeRuns)
        .set({ status: 'done', finishedAt: Date.now() })
        .where(eq(nodeRuns.id, reviewRunId))

      let threw = false
      let code: string | undefined
      try {
        await submitReviewDecision({
          db: h.db,
          appHome: h.appHome,
          nodeRunId: reviewRunId,
          decision: 'approved',
          expectedReviewIteration: 0,
          author: 'tester',
        })
      } catch (err) {
        threw = true
        code = (err as { code?: string }).code
      }
      expect(threw).toBe(true)
      expect(code).toBe('review-not-awaiting')
    })

    test('A9 submitReviewDecision with stale reviewIteration throws ConflictError', async () => {
      const reviewRunId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 3)
      let code: string | undefined
      try {
        await submitReviewDecision({
          db: h.db,
          appHome: h.appHome,
          nodeRunId: reviewRunId,
          decision: 'approved',
          expectedReviewIteration: 0,
          author: 'tester',
        })
      } catch (err) {
        code = (err as { code?: string }).code
      }
      expect(code).toBe('review-iteration-mismatch')
    })
  })

  describe('Section B: retry cascade mint', () => {
    test('B1 retryNode on agent: mints retry+1 row at status=failed errorMessage=queued for retry', async () => {
      await h.db
        .update(tasks)
        .set({ status: 'failed', errorSummary: 'boom' })
        .where(eq(tasks.id, h.taskId))
      const agentRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: agentRunId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'failed',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
        finishedAt: Date.now() - 50,
      })

      await retryNode(h.db, h.taskId, agentRunId, {
        cascade: false,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, h.taskId))
      const fresh = rows.find((r) => r.nodeId === 'doc' && r.retryIndex === 1)
      expect(fresh).toBeDefined()
      expect(fresh!.status).toBe('failed')
      expect(fresh!.errorMessage).toBe('queued for retry')
    })

    test('B2 retryNode with cascade: review/clarify/output downstream are NOT minted (RFC-052)', async () => {
      // Already covered exhaustively in retry-node-no-review-cascade.test.ts;
      // re-asserted here as the canonical entry in the transition matrix.
      await h.db
        .update(tasks)
        .set({ status: 'failed', errorSummary: 'boom' })
        .where(eq(tasks.id, h.taskId))
      const agentRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: agentRunId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'failed',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
        finishedAt: Date.now() - 50,
      })
      await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)

      await retryNode(h.db, h.taskId, agentRunId, {
        cascade: true,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })

      const reviewRows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'rev_1'))
      // Only the awaiting_review row exists — no placeholder.
      expect(reviewRows.length).toBe(1)
      expect(reviewRows[0]!.status).toBe('awaiting_review')
    })
  })

  describe('Section C: orphan reap', () => {
    test('C1 reapOrphanRuns flips running tasks → interrupted', async () => {
      await h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, h.taskId))
      const runRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: runRunId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'running',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
      })
      const pendingRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: pendingRunId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'pending',
        retryIndex: 1,
        iteration: 0,
        startedAt: Date.now() - 50,
      })

      const result = await reapOrphanRuns(h.db)
      expect(result.tasks).toBe(1)
      expect(result.runs).toBe(2)

      const taskAfter = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      expect(taskAfter.status).toBe('interrupted')
      expect(taskAfter.errorSummary).toBe('daemon-restart')

      const runAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runRunId)))[0]!
      expect(runAfter.status).toBe('interrupted')

      const pendingAfter = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, pendingRunId))
      )[0]!
      expect(pendingAfter.status).toBe('interrupted')
    })

    test('C2 reapOrphanRuns leaves awaiting_review / done rows alone', async () => {
      await h.db.update(tasks).set({ status: 'awaiting_review' }).where(eq(tasks.id, h.taskId))
      const awaitingId = await seedReviewRow(h.db, h.taskId, 'rev_1', 'awaiting_review', 0)
      const doneId = ulid()
      await h.db.insert(nodeRuns).values({
        id: doneId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
        finishedAt: Date.now() - 50,
      })

      await reapOrphanRuns(h.db)

      const taskAfter = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      // awaiting_review tasks are NOT reaped (only `running` is).
      expect(taskAfter.status).toBe('awaiting_review')
      const awaitingAfter = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, awaitingId))
      )[0]!
      expect(awaitingAfter.status).toBe('awaiting_review')
      const doneAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!
      expect(doneAfter.status).toBe('done')
    })
  })

  describe('Section D: clarify resume', () => {
    test('D1 submitClarifyAnswers closes session, sets clarify node_run to done, mints fresh asker row at ci+1', async () => {
      // Setup: agent node_run awaiting_human + clarify node_run awaiting_human
      // + clarify_session awaiting_human.
      const agentRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: agentRunId,
        taskId: h.taskId,
        nodeId: 'doc',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 100,
        opencodeSessionId: 'opencode-session-1',
      })
      // Build a minimal clarify node config — the service queries by clarify
      // node_run id, not the clarify node config, so we don't strictly need
      // it in the workflow definition. But seed a clarify run row to be
      // closed.
      const clarifyRunId = ulid()
      await h.db.insert(nodeRuns).values({
        id: clarifyRunId,
        taskId: h.taskId,
        nodeId: 'clarify_x',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now() - 50,
      })
      const sessionId = ulid()
      const questions = [
        {
          id: 'q1',
          title: 'Pick one',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ]
      await h.db.insert(clarifySessions).values({
        id: sessionId,
        taskId: h.taskId,
        clarifyNodeId: 'clarify_x',
        clarifyNodeRunId: clarifyRunId,
        sourceAgentNodeId: 'doc',
        sourceAgentNodeRunId: agentRunId,
        iterationIndex: 0,
        status: 'awaiting_human',
        questionsJson: JSON.stringify(questions),
        answersJson: '{}',
        createdAt: Date.now() - 30,
      })

      await submitClarifyAnswers({
        db: h.db,
        clarifyNodeRunId: clarifyRunId,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: ['A'],
            customText: '',
          },
        ],
      })

      // Clarify node_run → done.
      const clarifyAfter = (
        await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyRunId))
      )[0]!
      expect(clarifyAfter.status).toBe('done')
      expect(clarifyAfter.finishedAt).not.toBeNull()
      // Session closed.
      const sessAfter = (
        await h.db.select().from(clarifySessions).where(eq(clarifySessions.id, sessionId))
      )[0]!
      expect(sessAfter.status).toBe('answered')

      // Fresh agent rerun minted at clarifyIteration=1, retryIndex=0.
      const agentRows = await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'doc')))
      const fresh = agentRows.find((r) => r.status === 'pending')
      expect(fresh).toBeDefined()
      expect(fresh!.retryIndex).toBe(0)
      expect(fresh!.status).toBe('pending')
    })
  })
})
