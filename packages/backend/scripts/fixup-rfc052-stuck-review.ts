// RFC-052 — one-off fixup for tasks stuck in `awaiting_review` after the
// review-retry-cascade bug. Symptom is:
//
//   - tasks.status = 'awaiting_review'
//   - the review node_run row has status='awaiting_review' but its newest
//     doc_version has decision='approved' (not 'pending')
//   - upstream retry-cascade left `queued for retry` placeholder rows
//     (status=failed, errorMessage='queued for retry') for non-process kinds
//     {review, clarify, output, input}
//
// The script:
//   1. validates the task is in that exact shape (refuses to touch tasks that
//      look different);
//   2. promotes the affected review node_run rows to status='done'
//      (finishedAt = the approved doc_version's decided_at) and ensures the
//      approved_doc / approval_meta output rows exist;
//   3. deletes the `queued for retry` placeholder rows for non-process kinds
//      so the scheduler's `isFresherNodeRun` picks the correct latest row;
//   4. flips tasks.status to 'pending' + clears error fields so the next
//      daemon-side resumeTask drives the workflow forward.
//
// IMPORTANT: stop the daemon before running. Modifying the DB while the
// daemon is also writing risks resume races. After the script reports
// success, start the daemon back up — orphan-reap will not touch the
// 'pending' status (only 'running' tasks are reaped) and the scheduler will
// pick the task up on next start.
//
// Run:
//   bun run --filter @agent-workflow/backend scripts/fixup-rfc052-stuck-review.ts \
//       --task-id 01KS1N8WVZWE8FTR4K9WSETRNW
//
// Optional flags:
//   --db <path>       override the sqlite path (default ~/.agent-workflow/db.sqlite)
//   --dry-run         print what would change without writing

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { desc, eq, inArray } from 'drizzle-orm'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import * as schema from '@/db/schema'
import { docVersions, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import { NODE_KIND_BEHAVIORS, type NodeKind } from '@agent-workflow/shared'

interface CliArgs {
  taskId: string
  dbPath: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let taskId: string | undefined
  let dbPath = resolve(homedir(), '.agent-workflow', 'db.sqlite')
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--task-id') taskId = argv[++i]
    else if (a === '--db') dbPath = resolve(argv[++i] ?? '')
    else if (a === '--dry-run') dryRun = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (taskId === undefined || taskId === '') {
    console.error('missing required --task-id')
    printHelp()
    process.exit(2)
  }
  return { taskId, dbPath, dryRun }
}

function printHelp(): void {
  console.error('usage: fixup-rfc052-stuck-review.ts --task-id <ulid> [--db <path>] [--dry-run]')
}

interface SnapshotNode {
  id?: string
  kind?: string
}

function parseSnapshotNodes(raw: string): Map<string, NodeKind> {
  const out = new Map<string, NodeKind>()
  try {
    const parsed: unknown = JSON.parse(raw)
    const ns = (parsed as { nodes?: unknown })?.nodes
    if (!Array.isArray(ns)) return out
    for (const n of ns as SnapshotNode[]) {
      if (typeof n?.id === 'string' && typeof n?.kind === 'string') {
        out.set(n.id, n.kind as NodeKind)
      }
    }
  } catch {
    /* swallow — snapshot may be corrupt; caller falls back */
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const sqlite = new Database(args.dbPath)
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })

  console.log(
    `[rfc-052] target task=${args.taskId} db=${args.dbPath}${args.dryRun ? ' (dry-run)' : ''}`,
  )

  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, args.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    console.error(`[rfc-052] task not found`)
    process.exit(1)
  }
  if (taskRow.status !== 'awaiting_review') {
    console.error(
      `[rfc-052] task.status='${taskRow.status}' — script only handles 'awaiting_review'; no-op`,
    )
    process.exit(1)
  }

  const kindOf = parseSnapshotNodes(taskRow.workflowSnapshot)

  // Find every review node_run for this task whose row says awaiting_review
  // but whose newest doc_version says approved — that's the smoking gun.
  const allRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, args.taskId))

  interface StuckReview {
    nodeRunId: string
    nodeId: string
    approvedDocVersionId: string
    decidedAt: number
  }
  const stuck: StuckReview[] = []

  for (const r of allRuns) {
    if (r.status !== 'awaiting_review') continue
    if (kindOf.get(r.nodeId) !== 'review') continue
    const docs = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, r.id))
      .orderBy(desc(docVersions.versionIndex))
    if (docs.length === 0) continue
    const newest = docs[0]!
    const pending = docs.find((d) => d.decision === 'pending')
    if (pending !== undefined) {
      console.log(
        `[rfc-052] node_run ${r.id} (${r.nodeId}) has a pending doc_version v${pending.versionIndex} — not the RFC-052 shape, skipping`,
      )
      continue
    }
    if (newest.decision !== 'approved') {
      console.log(
        `[rfc-052] node_run ${r.id} (${r.nodeId}) newest doc_version is decision='${newest.decision}', not 'approved' — skipping`,
      )
      continue
    }
    if (typeof newest.decidedAt !== 'number') {
      console.log(
        `[rfc-052] node_run ${r.id} (${r.nodeId}) approved doc_version has no decidedAt — skipping`,
      )
      continue
    }
    stuck.push({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      approvedDocVersionId: newest.id,
      decidedAt: newest.decidedAt,
    })
  }

  if (stuck.length === 0) {
    console.error(
      `[rfc-052] no review node_runs match the RFC-052 stuck shape on task ${args.taskId} — refusing to touch the DB`,
    )
    process.exit(1)
  }

  // Find placeholder rows for non-process kinds (queued for retry) to delete.
  const placeholderIds: string[] = []
  for (const r of allRuns) {
    if (r.errorMessage !== 'queued for retry') continue
    const k = kindOf.get(r.nodeId)
    if (k === undefined) continue
    // Skip kinds that would cascade on retry — those are "real" placeholders.
    // We only want to delete placeholders for non-process kinds (review /
    // clarify / output / input) where the retry-cascade row was minted
    // accidentally pre-RFC-052.
    if (NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder') continue
    placeholderIds.push(r.id)
  }

  console.log(`[rfc-052] stuck reviews: ${stuck.length}`)
  for (const s of stuck) {
    console.log(
      `  - node_run=${s.nodeRunId} node=${s.nodeId} newest approved v=${s.approvedDocVersionId} decidedAt=${s.decidedAt}`,
    )
  }
  console.log(
    `[rfc-052] placeholder rows to delete (non-process queued-for-retry): ${placeholderIds.length}`,
  )
  for (const id of placeholderIds) console.log(`  - ${id}`)

  if (args.dryRun) {
    console.log('[rfc-052] --dry-run set; not modifying DB')
    process.exit(0)
  }

  // 1. Promote stuck review rows to done + ensure outputs exist.
  for (const s of stuck) {
    // Try fetching the approved doc_version to source approved_doc body.
    const dvRow = (
      await db.select().from(docVersions).where(eq(docVersions.id, s.approvedDocVersionId)).limit(1)
    )[0]
    if (dvRow === undefined) continue

    const approvedDocContent =
      dvRow.sourceFilePath !== null && dvRow.sourceFilePath !== ''
        ? dvRow.sourceFilePath
        : // We don't have appHome at hand to re-read the body file; instead
          // fall back to an explicit marker so downstream readers see *some*
          // content. Workflows that gated on this output were already stuck;
          // a marker is strictly better than nothing.
          `[rfc-052-fixup] approved_doc body lives at doc_version=${dvRow.id}; re-read via API if needed`

    const meta = JSON.stringify({
      decision: 'approved',
      decidedAt: s.decidedAt,
      decidedBy: dvRow.decidedBy ?? 'rfc-052-fixup',
      reviewIteration: dvRow.reviewIteration,
      versionIndex: dvRow.versionIndex,
      sourceNodeId: dvRow.sourceNodeId,
      sourcePortName: dvRow.sourcePortName,
      rfcFixup: 'RFC-052',
    })

    await db
      .insert(nodeRunOutputs)
      .values({
        nodeRunId: s.nodeRunId,
        portName: 'approved_doc',
        content: approvedDocContent,
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: approvedDocContent },
      })
    await db
      .insert(nodeRunOutputs)
      .values({
        nodeRunId: s.nodeRunId,
        portName: 'approval_meta',
        content: meta,
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: meta },
      })
    await db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: s.decidedAt })
      .where(eq(nodeRuns.id, s.nodeRunId))
    console.log(`[rfc-052] promoted ${s.nodeRunId} → done finishedAt=${s.decidedAt}`)
  }

  // 2. Delete placeholder rows.
  if (placeholderIds.length > 0) {
    await db.delete(nodeRuns).where(inArray(nodeRuns.id, placeholderIds))
    console.log(`[rfc-052] deleted ${placeholderIds.length} placeholder rows`)
  }

  // 3. Push the task back to pending; clear error fields. The daemon will
  // re-enter resumeTask on next start (or via the user running it manually).
  await db
    .update(tasks)
    .set({ status: 'pending', errorSummary: null, errorMessage: null, failedNodeId: null })
    .where(eq(tasks.id, args.taskId))
  console.log(`[rfc-052] task ${args.taskId} → pending; restart daemon to drive it forward`)
  process.exit(0)
}

void main().catch((err) => {
  console.error(
    '[rfc-052] failed:',
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  )
  process.exit(1)
})
