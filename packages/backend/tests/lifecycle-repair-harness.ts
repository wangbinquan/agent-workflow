import { rimrafDir } from './helpers/cleanup'
// LOCKS: RFC-057 — shared test harness for repair option suites.
// Not a *.test.ts file so bun:test doesn't try to run it.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  clarifySessions,
  docVersions,
  lifecycleAlerts,
  lifecycleRepairAudit,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { abortAllActiveTasks } from '../src/services/task'
import type { StartTaskDeps } from '../src/services/task'

export const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

export interface RepairHarness {
  db: DbClient
  taskId: string
  workflowId: string
  tmpDir: string
  cleanup: () => void
  /** Minimal StartTaskDeps suitable for tests: nonexistent opencode binary so
   *  any background resumeTask -> runTask spawn fails fast and gets swallowed
   *  by task.ts's `.catch`. Tests should call abortAllActiveTasks + a short
   *  sleep after applyRepairOption() before asserting to avoid races. */
  deps: StartTaskDeps
}

export async function buildHarness(opts: {
  taskStatus:
    | 'pending'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted'
  workflow?: WorkflowDefinition
}): Promise<RepairHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc057-repair-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const def: WorkflowDefinition =
    opts.workflow ??
    ({
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'doc', portName: 'docpath' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    } as WorkflowDefinition)
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    taskId,
    workflowId,
    tmpDir: tmp,
    cleanup: () => rimrafDir(tmp),
    deps: {
      db,
      appHome: tmp,
      opencodeCmd: ['/nonexistent-opencode-binary-rfc057-test'],
    },
  }
}

export async function insertNodeRun(
  db: DbClient,
  taskId: string,
  opts: {
    nodeId: string
    status:
      | 'pending'
      | 'running'
      | 'awaiting_review'
      | 'awaiting_human'
      | 'done'
      | 'failed'
      | 'canceled'
      | 'interrupted'
      | 'skipped'
      | 'exhausted'
    retryIndex?: number
    iteration?: number
    reviewIteration?: number
    clarifyIteration?: number
    shardKey?: string | null
    startedAt?: number
    finishedAt?: number | null
    errorMessage?: string | null
    // RFC-074 PR-C: explicit id lets multi-generation tests pin id-order
    // deterministically (freshness/generation selection is pure ULID id-order;
    // two plain ulid() calls in the same ms could otherwise invert and flake).
    id?: string
  },
): Promise<string> {
  const id = opts.id ?? ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: opts.iteration ?? 0,
    retryIndex: opts.retryIndex ?? 0,
    reviewIteration: opts.reviewIteration ?? 0,
    shardKey: opts.shardKey ?? null,
    status: opts.status,
    startedAt: opts.startedAt ?? Date.now() - 1000,
    finishedAt: opts.finishedAt ?? null,
    errorMessage: opts.errorMessage ?? null,
  })
  return id
}

export async function insertDocVersion(
  db: DbClient,
  taskId: string,
  opts: {
    reviewNodeRunId: string
    reviewNodeId: string
    decision: 'pending' | 'approved' | 'rejected' | 'iterated'
    versionIndex?: number
    reviewIteration?: number
    sourceFilePath?: string | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(docVersions).values({
    id,
    taskId,
    reviewNodeId: opts.reviewNodeId,
    reviewNodeRunId: opts.reviewNodeRunId,
    sourceNodeId: 'src',
    sourcePortName: 'docpath',
    versionIndex: opts.versionIndex ?? 1,
    reviewIteration: opts.reviewIteration ?? 0,
    bodyPath: 'dv/v1.md',
    decision: opts.decision,
    decidedAt: opts.decision === 'pending' ? null : Date.now(),
    sourceFilePath: opts.sourceFilePath ?? null,
  })
  return id
}

export async function insertClarifySession(
  db: DbClient,
  taskId: string,
  opts: {
    clarifyNodeRunId: string
    clarifyNodeId: string
    status: 'awaiting_human' | 'answered' | 'canceled'
  },
): Promise<string> {
  const id = ulid()
  await db.insert(clarifySessions).values({
    id,
    taskId,
    sourceAgentNodeId: 'src',
    sourceAgentNodeRunId: 'src-run',
    clarifyNodeId: opts.clarifyNodeId,
    clarifyNodeRunId: opts.clarifyNodeRunId,
    iterationIndex: 0,
    questionsJson: '[]',
    status: opts.status,
    answersJson: opts.status === 'awaiting_human' ? null : '[]',
    answeredAt: opts.status === 'awaiting_human' ? null : Date.now(),
  })
  return id
}

export async function insertAlert(
  db: DbClient,
  taskId: string,
  opts: {
    rule: string
    detail: Record<string, unknown>
    severity?: 'warning' | 'error'
  },
): Promise<string> {
  const id = ulid()
  await db.insert(lifecycleAlerts).values({
    id,
    taskId,
    rule: opts.rule,
    severity: opts.severity ?? 'warning',
    detail: JSON.stringify(opts.detail),
    detectedAt: Date.now(),
    resolvedAt: null,
  })
  return id
}

export async function readAuditRows(
  db: DbClient,
  taskId: string,
): Promise<
  Array<{
    id: string
    optionId: string
    outcome: string
    beforeSnapshot: Record<string, unknown>
    afterSnapshot: Record<string, unknown>
  }>
> {
  const rows = await db
    .select()
    .from(lifecycleRepairAudit)
    .where(eq(lifecycleRepairAudit.taskId, taskId))
  return rows.map((r) => ({
    id: r.id,
    optionId: r.optionId,
    outcome: r.outcome,
    beforeSnapshot: JSON.parse(r.beforeSnapshotJson) as Record<string, unknown>,
    afterSnapshot: JSON.parse(r.afterSnapshotJson) as Record<string, unknown>,
  }))
}

export async function readAlert(
  db: DbClient,
  alertId: string,
): Promise<{ resolvedAt: number | null; severity: string } | null> {
  const rows = await db
    .select()
    .from(lifecycleAlerts)
    .where(eq(lifecycleAlerts.id, alertId))
    .limit(1)
  if (rows.length === 0) return null
  return { resolvedAt: rows[0]!.resolvedAt, severity: rows[0]!.severity }
}

export async function readNodeRunStatus(db: DbClient, nodeRunId: string): Promise<string | null> {
  const rows = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  return rows[0]?.status ?? null
}

export async function readTaskStatus(db: DbClient, taskId: string): Promise<string | null> {
  const rows = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return rows[0]?.status ?? null
}

export async function settleResumes(): Promise<void> {
  const aborted = abortAllActiveTasks()
  // Only pay the settle when a resume was actually in flight. Most repair tests
  // (preflight-stale, preview-steps, …) never trigger a background runTask, so
  // there is nothing to settle and the sleep would be ~78×50ms of dead wait
  // across the suite. When a task WAS aborted, give the void runTask promise a
  // tick so its `.finally` removes itself from the activeTasks map — 50ms is
  // generous for an ENOENT-on-spawn fail (the only mode tests should hit).
  if (aborted.length > 0) await Bun.sleep(50)
}
