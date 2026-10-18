// RFC-056 patch 2026-05-26 — one-off fixup for cross-clarify tasks whose
// downstream chain ran on a stale approved_doc because `dispatchReviewNode`
// short-circuited cascade-minted review rows at higher
// crossClarifyIteration (pre-patch behavior; see
// design/RFC-056-clarify-cross-agent/patch-2026-05-26-review-dispatch-respects-cci.md).
//
// Symptom (live task 01KS86DPCSERV7S41GQA5Y81RN):
//   - Reviewer node has multiple pending top-level rows at cci > 0 that
//     never started (startedAt = null) — cascade kept minting, dispatcher
//     kept short-circuiting under the pre-patch `alreadyDone` rule.
//   - The questioner downstream of the reviewer DID run at the bumped cci
//     and produced `done` rows, but read a stale `approved_doc` because
//     no fresh review at cci > 0 ever finished.
//   - Cross-clarify lifecycle keeps spawning new sessions on top of the
//     stale chain; the current node_run for the cross-clarify is
//     awaiting_human.
//
// After this script + the patch ship, the user re-approves the latest
// reviewer (parked by the scheduler on resume) and the questioner
// re-dispatches with fresh upstream content.
//
// Strategy (the "跳到最新 cci 重审" path, user-confirmed):
//   1. Validate task exists.
//   2. Detect "stuck cascade" review nodes: a review whose upstream agent's
//      latest done row has cci > the review's latest done row's cci.
//   3. For each such review, leave the existing cascade-minted pending row
//      (at the max cci) in place — `dispatchReviewNode` will pick it up
//      on resume and (with the patch) actually parks it awaiting_review.
//      No DB mutation needed for the review itself.
//   4. For every non-review downstream node whose latest top-level row is
//      done at the upstream's max cci (i.e. it ALREADY consumed stale
//      data and finished), mint a fresh pending row at ri = max+1
//      inheriting the upstream's cci. This row will re-dispatch after
//      the reviewer's re-approval and read the fresh approved_doc.
//   5. Abandon any awaiting_human cross_clarify_session on a downstream
//      cross-clarify node — those questions were answered against the
//      stale chain and no longer represent reality; the questioner can
//      re-emit them after consuming the fresh approved_doc.
//   6. Flip task.status = 'pending' so resumeTask drives the workflow on
//      next daemon start.
//
// IMPORTANT: stop the daemon before running. Run with `--dry-run`
// (default) to see the plan; add `--apply` to actually mutate the DB.
//
// Run:
//   bun run --filter @agent-workflow/backend scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts \
//       --task-id 01KS86DPCSERV7S41GQA5Y81RN
//
// Optional flags:
//   --db <path>       override the sqlite path (default ~/.agent-workflow/db.sqlite)
//   --apply           perform the mutations (default is dry-run)

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { and, eq } from 'drizzle-orm'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import * as schema from '@/db/schema'
import { crossClarifySessions, nodeRuns, tasks } from '@/db/schema'
import { isFresherNodeRun } from '@/services/scheduler'
import {
  isReviewCciAlignedWithUpstream,
  pickFreshestReviewRun,
} from '@/modules/collaboration/infrastructure/review'
import type { WorkflowDefinition } from '@agent-workflow/shared'

interface CliArgs {
  taskId: string
  dbPath: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let taskId: string | undefined
  let dbPath = resolve(homedir(), '.agent-workflow', 'db.sqlite')
  // Default to dry-run; user must opt in with --apply.
  let dryRun = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--task-id') taskId = argv[++i]
    else if (a === '--db') dbPath = resolve(argv[++i] ?? '')
    else if (a === '--apply') dryRun = false
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
  console.error(
    'usage: fixup-rfc056-2026-05-26-cci-stuck-review.ts --task-id <ulid> [--db <path>] [--apply|--dry-run]',
  )
}

function parseDefinition(raw: string): WorkflowDefinition | null {
  try {
    return JSON.parse(raw) as WorkflowDefinition
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sqlite = new Database(args.dbPath)
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const db = drizzle(sqlite, { schema })

  const tag = '[rfc-056-cci-fixup]'
  console.log(
    `${tag} target task=${args.taskId} db=${args.dbPath}${args.dryRun ? ' (DRY-RUN)' : ' (APPLY)'}`,
  )

  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, args.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    console.error(`${tag} task not found`)
    process.exit(1)
  }

  const def = parseDefinition(taskRow.workflowSnapshot)
  if (def === null) {
    console.error(`${tag} workflow snapshot unparseable`)
    process.exit(1)
  }

  // Index nodes by id + collect review nodes' upstream source nodeIds.
  const nodeKindById = new Map<string, string>()
  const reviewUpstream = new Map<string, string>() // reviewNodeId → sourceNodeId
  for (const n of def.nodes ?? []) {
    if (typeof n.id !== 'string' || typeof n.kind !== 'string') continue
    nodeKindById.set(n.id, n.kind)
    if (n.kind === 'review') {
      const ip = (n as Record<string, unknown>).inputSource as { nodeId?: unknown } | undefined
      if (ip !== undefined && typeof ip.nodeId === 'string') {
        reviewUpstream.set(n.id, ip.nodeId)
      }
    }
  }

  // Pull all node_runs for the task.
  const allRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, args.taskId))

  // Build latest-per-node by isFresherNodeRun (excluding fan-out children).
  const latestByNode = new Map<string, (typeof allRuns)[number]>()
  for (const r of allRuns) {
    if (r.parentNodeRunId !== null) continue
    const cur = latestByNode.get(r.nodeId)
    if (cur === undefined || isFresherNodeRun(r, cur)) latestByNode.set(r.nodeId, r)
  }

  // Detect "stuck cascade" reviews.
  interface StuckReview {
    reviewNodeId: string
    upstreamNodeId: string
    upstreamLatestCci: number
    reviewPendingRunId: string | undefined
    reviewLatestDoneCci: number
    /** True when no pending review row exists at the target cci (daemon
     *  restart swept all cascade rows to `interrupted`); the script must
     *  mint a fresh pending row from the latestDone template so the
     *  scheduler has something to dispatch. */
    needsFreshPendingMint: boolean
    templateRunId: string
    newRetryIndex: number
    templateReviewIteration: number
    templateClarifyIteration: number
  }
  const stuck: StuckReview[] = []
  for (const [reviewNodeId, upstreamNodeId] of reviewUpstream) {
    const upstreamLatest = latestByNode.get(upstreamNodeId)
    if (upstreamLatest === undefined || upstreamLatest.status !== 'done') continue
    const reviewRows = allRuns.filter(
      (r) => r.nodeId === reviewNodeId && r.parentNodeRunId === null,
    )
    if (reviewRows.length === 0) continue
    const { reuse, latestDone } = pickFreshestReviewRun(reviewRows)
    const aligned = isReviewCciAlignedWithUpstream(latestDone, upstreamLatest)
    if (aligned) continue
    const pendingRow = reviewRows.find(
      (r) =>
        r.status === 'pending' &&
        (r.crossClarifyIteration ?? 0) >= (upstreamLatest.crossClarifyIteration ?? 0),
    )
    const template = latestDone ?? reuse!
    stuck.push({
      reviewNodeId,
      upstreamNodeId,
      upstreamLatestCci: upstreamLatest.crossClarifyIteration ?? 0,
      reviewPendingRunId: pendingRow?.id,
      reviewLatestDoneCci: latestDone?.crossClarifyIteration ?? 0,
      needsFreshPendingMint: pendingRow === undefined,
      templateRunId: template.id,
      newRetryIndex: Math.max(...reviewRows.map((r) => r.retryIndex)) + 1,
      templateReviewIteration: template.reviewIteration,
      templateClarifyIteration: template.clarifyIteration,
    })
  }

  if (stuck.length === 0) {
    console.log(`${tag} no stuck reviews detected — task does NOT match the RFC-056-cci shape`)
    process.exit(1)
  }

  // For each stuck review, enumerate the downstream non-review nodes whose
  // latest done row consumed stale upstream data — those need to re-run.
  // We do a BFS forward from the review's upstream node through the data
  // graph (skipping cross-clarify and clarify-channel edges) and collect
  // nodes whose latest done row has cci ≤ the review's stuck cci. A new
  // pending row at ri = max+1 will let the scheduler re-dispatch them post-
  // review-approval.
  function isClarifyChannelEdge(e: {
    source: { portName: string }
    target: { portName: string }
  }): boolean {
    return (
      e.source.portName === '__clarify__' ||
      e.target.portName === '__clarify_response__' ||
      e.target.portName === '__external_feedback__' ||
      e.source.portName === 'to_designer' ||
      e.source.portName === 'to_questioner'
    )
  }
  const adj = new Map<string, string[]>()
  for (const e of def.edges ?? []) {
    if (isClarifyChannelEdge(e)) continue
    const arr = adj.get(e.source.nodeId) ?? []
    arr.push(e.target.nodeId)
    adj.set(e.source.nodeId, arr)
  }

  interface DownstreamMint {
    nodeId: string
    templateRunId: string
    newRetryIndex: number
    cci: number
  }
  const mints: DownstreamMint[] = []
  const visited = new Set<string>()
  function walkFrom(startNodeId: string, targetCci: number): void {
    const queue: string[] = [...(adj.get(startNodeId) ?? [])]
    while (queue.length > 0) {
      const cur = queue.shift()
      if (cur === undefined) break
      if (visited.has(cur)) continue
      visited.add(cur)
      const kind = nodeKindById.get(cur) ?? ''
      // Review nodes are handled separately (their pending row already
      // exists from cascade; dispatcher will park it awaiting_review).
      if (kind !== 'review') {
        const rows = allRuns.filter(
          (r) => r.nodeId === cur && r.parentNodeRunId === null && r.iteration === 0,
        )
        if (rows.length > 0) {
          const latestRow = rows.reduce<(typeof rows)[number] | undefined>(
            (acc, r) => (acc === undefined || isFresherNodeRun(r, acc) ? r : acc),
            undefined,
          )
          if (latestRow !== undefined && latestRow.status === 'done') {
            const newRetryIndex = Math.max(...rows.map((r) => r.retryIndex)) + 1
            mints.push({
              nodeId: cur,
              templateRunId: latestRow.id,
              newRetryIndex,
              cci: targetCci,
            })
          }
        }
      }
      for (const next of adj.get(cur) ?? []) queue.push(next)
    }
  }
  for (const s of stuck) walkFrom(s.upstreamNodeId, s.upstreamLatestCci)

  // Locate any awaiting_human cross_clarify_session(s) on the affected
  // chain so we can abandon them — their questions were generated against
  // stale data.
  const sessions = await db
    .select()
    .from(crossClarifySessions)
    .where(eq(crossClarifySessions.taskId, args.taskId))
  const pendingSessions = sessions.filter((s) => s.status === 'awaiting_human')

  // Print plan.
  console.log(`${tag} plan:`)
  console.log(`  task.status currently = ${taskRow.status}`)
  console.log(`  stuck reviews: ${stuck.length}`)
  for (const s of stuck) {
    const mintNote = s.needsFreshPendingMint
      ? `MINT fresh pending ri=${s.newRetryIndex} cci=${s.upstreamLatestCci} (template=${s.templateRunId})`
      : `reuse existing pending ${s.reviewPendingRunId}`
    console.log(
      `    - ${s.reviewNodeId} upstream=${s.upstreamNodeId} upstream.cci=${s.upstreamLatestCci} reviewDone.cci=${s.reviewLatestDoneCci} → ${mintNote}`,
    )
  }
  console.log(`  downstream non-review re-mints: ${mints.length}`)
  for (const m of mints) {
    const template = allRuns.find((r) => r.id === m.templateRunId)
    console.log(
      `    - ${m.nodeId} ri=${m.newRetryIndex} cci=${m.cci} template=${m.templateRunId}` +
        ` (template.cl=${template?.clarifyIteration ?? 0} template.rev=${template?.reviewIteration ?? 0})`,
    )
  }
  console.log(`  awaiting_human cross_clarify sessions to abandon: ${pendingSessions.length}`)
  for (const s of pendingSessions) {
    console.log(`    - session=${s.id} cross_clarify_node_run=${s.crossClarifyNodeRunId}`)
  }

  if (args.dryRun) {
    console.log(`${tag} --dry-run set; no DB writes. Re-run with --apply to commit.`)
    process.exit(0)
  }

  // Apply.
  const now = Date.now()
  let writes = 0
  for (const s of stuck) {
    if (!s.needsFreshPendingMint) continue
    const template = allRuns.find((r) => r.id === s.templateRunId)
    if (template === undefined) continue
    const newId = ulid()
    await db.insert(nodeRuns).values({
      id: newId,
      taskId: args.taskId,
      nodeId: s.reviewNodeId,
      status: 'pending',
      retryIndex: s.newRetryIndex,
      iteration: template.iteration,
      parentNodeRunId: null,
      shardKey: template.shardKey ?? null,
      reviewIteration: s.templateReviewIteration,
      clarifyIteration: s.templateClarifyIteration,
      crossClarifyIteration: s.upstreamLatestCci,
      preSnapshot: template.preSnapshot,
    })
    writes += 1
    console.log(
      `${tag} minted review ${s.reviewNodeId} run=${newId} ri=${s.newRetryIndex} cci=${s.upstreamLatestCci}`,
    )
  }
  for (const m of mints) {
    const template = allRuns.find((r) => r.id === m.templateRunId)
    if (template === undefined) continue
    const newId = ulid()
    await db.insert(nodeRuns).values({
      id: newId,
      taskId: args.taskId,
      nodeId: m.nodeId,
      status: 'pending',
      retryIndex: m.newRetryIndex,
      iteration: template.iteration,
      parentNodeRunId: null,
      shardKey: template.shardKey ?? null,
      reviewIteration: template.reviewIteration,
      clarifyIteration: template.clarifyIteration,
      crossClarifyIteration: m.cci,
      preSnapshot: template.preSnapshot,
    })
    writes += 1
    console.log(`${tag} minted ${m.nodeId} run=${newId} ri=${m.newRetryIndex} cci=${m.cci}`)
  }
  for (const s of pendingSessions) {
    await db
      .update(crossClarifySessions)
      .set({ status: 'abandoned', abandonedAt: now })
      .where(eq(crossClarifySessions.id, s.id))
    // The corresponding node_run row goes done (abandoned cross-clarify
    // treats the session as resolved with no Q&A contribution). Use a CAS
    // on awaiting_human so we don't clobber a row that already raced out
    // of the parked state.
    await db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: now })
      .where(and(eq(nodeRuns.id, s.crossClarifyNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
    writes += 2
    console.log(`${tag} abandoned cross_clarify session=${s.id}`)
  }
  // Flip task back to pending so resumeTask picks it up cleanly. Use CAS
  // on the prior status so we don't fight a concurrent daemon write.
  await db
    .update(tasks)
    .set({ status: 'pending' })
    .where(and(eq(tasks.id, args.taskId), eq(tasks.status, taskRow.status)))
  writes += 1
  console.log(`${tag} flipped task.status ${taskRow.status} → pending`)

  console.log(`${tag} applied ${writes} writes. Start the daemon; next resume will:`)
  console.log(`${tag}   1. dispatch the cascade-minted review pending row → awaiting_review`)
  console.log(`${tag}   2. wait for user to approve the reviewer (latest cci)`)
  console.log(`${tag}   3. dispatch the new downstream pending rows with fresh approved_doc`)
}

main().catch((err: unknown) => {
  console.error('[rfc-056-cci-fixup] fatal:', err)
  process.exit(1)
})
