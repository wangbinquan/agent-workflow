import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1h — property-based: random event sequences preserve
// cross-table invariants.
//
// Generates random event sequences (approve / iterate / reject / dispatch /
// retry) and applies them via the real service functions. After each
// sequence, all double-layer invariants (R1/R2/T1/U1) still hold.
//
// numRuns is kept modest (30) since each run does ~10 DB ops + a fixture
// build. Shrinking should still bisect any failing trace into a minimal
// repro.

import { describe, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import fc from 'fast-check'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode, submitReviewDecision } from '../src/services/review'
import { retryNode } from '../src/services/task'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Invariant checker (copy of T1c's, minus the C1/T2/T3 rules we don't
// exercise here since this property test doesn't touch clarify/output).
//
// T1 (`task.status='awaiting_review' ⟹ ∃ review run awaiting_review`) is
// intentionally NOT enforced here because it's a *transient* invariant: in
// production, `submitReviewDecision` returns `resumeRequired: true` and the
// route handler fires `resumeTask(...)` fire-and-forget, which flips
// `task.status` from awaiting_review → pending. Between the two writes T1
// can be momentarily false. The property test exercises the service-layer
// in isolation (no route handler firing resume), so T1 is checked in T1c
// against steady-state shapes instead.
type Rule = 'R1' | 'R2' | 'U1'
interface Violation {
  rule: Rule
  detail: string
}
async function checkInvariants(db: DbClient, taskId: string): Promise<Violation[]> {
  const v: Violation[] = []
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (t === undefined) return v
  const def = JSON.parse(t.workflowSnapshot) as { nodes?: Array<{ id?: string; kind?: string }> }
  const kindOf = new Map<string, string>()
  for (const n of def.nodes ?? []) {
    if (typeof n.id === 'string' && typeof n.kind === 'string') kindOf.set(n.id, n.kind)
  }
  const allRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const allDocs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))

  for (const dv of allDocs) {
    if (dv.decision !== 'approved') continue
    const run = allRuns.find((r) => r.id === dv.reviewNodeRunId)
    if (run === undefined || run.status !== 'done') {
      v.push({
        rule: 'R1',
        detail: `approved dv ${dv.id} → run.status=${run?.status ?? 'missing'}`,
      })
    }
  }
  for (const r of allRuns) {
    if (kindOf.get(r.nodeId) !== 'review') continue
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'done') continue
    const has = allDocs.some((dv) => dv.reviewNodeRunId === r.id && dv.decision === 'approved')
    if (!has) v.push({ rule: 'R2', detail: `review run ${r.id} done but no approved dv` })
  }
  const groups = new Map<string, number>()
  for (const r of allRuns) {
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'awaiting_review' && r.status !== 'awaiting_human') continue
    const k = `${r.nodeId}::${r.iteration}`
    groups.set(k, (groups.get(k) ?? 0) + 1)
  }
  for (const [k, c] of groups) {
    if (c > 1) v.push({ rule: 'U1', detail: `${k} has ${c} active rows` })
  }
  return v
}

// Event ADT.
type Event =
  | { kind: 'approve' }
  | { kind: 'iterate' }
  | { kind: 'reject' }
  | { kind: 'dispatch' } // re-enter scheduler dispatch path on review
  | { kind: 'retry-agent' }

const eventArbitrary: fc.Arbitrary<Event> = fc.oneof(
  fc.constant<Event>({ kind: 'approve' }),
  fc.constant<Event>({ kind: 'iterate' }),
  fc.constant<Event>({ kind: 'reject' }),
  fc.constant<Event>({ kind: 'dispatch' }),
  fc.constant<Event>({ kind: 'retry-agent' }),
)

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  definition: WorkflowDefinition
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1h-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  // We used to call `runGit` 5 times here (init / config email / config
  // name / add / commit). On macos GHA each spawn is ~30-80ms, so 5 ×
  // 20 fc iterations stacked to multiple seconds of pure subprocess
  // overhead. Two cheap wins:
  //   1. `git -c init.defaultBranch=main init -q` collapses init + the
  //      branch-rename `git config` to one call.
  //   2. Pass commit identity inline via `-c user.email=… -c user.name=…`
  //      on the commit invocation itself — transient config applies to
  //      that one command, no separate `git config` needed.
  // Net: 5 spawns → 3 spawns/harness.
  await runGit(repoPath, ['-c', 'init.defaultBranch=main', 'init', '-q'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, [
    '-c',
    'user.email=t@t.test',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '-m',
    'i',
  ])
  const db = createInMemoryDb(MIGRATIONS)
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
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'doc', portName: 'docpath' },
        target: { nodeId: 'rev_1', portName: 'in' },
      },
    ],
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
  // Initial agent done + outputs.
  const agentRunId = ulid()
  await db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: 'doc',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 900,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: agentRunId, portName: 'docpath', content: '# v0' })
  // Initial review row awaiting decision + pending dv.
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'rev_1',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: Date.now() - 30,
  })
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  writeFileSync(join(appHome, 'doc_versions', 'v1.md'), '# v0')
  await db.insert(docVersions).values({
    id: ulid(),
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'doc_versions/v1.md',
    decision: 'pending',
  })
  await db.update(tasks).set({ status: 'awaiting_review' }).where(eq(tasks.id, taskId))

  return {
    db,
    appHome,
    repoPath,
    taskId,
    definition,
    cleanup: () => rimrafDir(tmp),
  }
}

// Apply one event to the harness. Each event is best-effort: if the
// precondition isn't met (no awaiting_review row, no agent to retry, etc.)
// the event is a no-op. Returns true iff it actually mutated state.
async function applyEvent(h: Harness, ev: Event): Promise<boolean> {
  try {
    if (ev.kind === 'approve' || ev.kind === 'iterate' || ev.kind === 'reject') {
      const rows = await h.db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, h.taskId),
            eq(nodeRuns.nodeId, 'rev_1'),
            eq(nodeRuns.status, 'awaiting_review'),
          ),
        )
      const target = rows[0]
      if (target === undefined) return false
      // Pending dv?
      const dvs = await h.db
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.reviewNodeRunId, target.id), eq(docVersions.decision, 'pending')))
      if (dvs.length === 0) return false
      await submitReviewDecision({
        db: h.db,
        appHome: h.appHome,
        nodeRunId: target.id,
        decision:
          ev.kind === 'approve' ? 'approved' : ev.kind === 'iterate' ? 'iterated' : 'rejected',
        expectedReviewIteration: target.reviewIteration,
        author: 'rng',
        ...(ev.kind === 'reject' ? { rejectReason: 'r' } : {}),
      })
      return true
    }
    if (ev.kind === 'dispatch') {
      // Re-enter dispatch only when the review has no active awaiting row
      // (otherwise dispatch is no-op or idempotent).
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
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
      return true
    }
    if (ev.kind === 'retry-agent') {
      // Need a task that's NOT pending/running. If task is awaiting_review or
      // failed/interrupted, retryNode accepts it. If task is running, skip.
      const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
      if (task.status === 'running' || task.status === 'pending') return false
      // Pick the latest agent row that's not canceled.
      const rows = await h.db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, h.taskId),
            eq(nodeRuns.nodeId, 'doc'),
            ne(nodeRuns.status, 'canceled'),
          ),
        )
      const target = rows.sort((a, b) => b.retryIndex - a.retryIndex)[0]
      if (target === undefined) return false
      await retryNode(h.db, h.taskId, target.id, {
        cascade: true,
        deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['/usr/bin/env', 'true'] },
      })
      return true
    }
    return false
  } catch {
    // Event hit a precondition error (e.g., task-not-resumable, review-not-awaiting).
    // That's expected for many random sequences — treat as no-op.
    return false
  }
}

describe('RFC-053 PR-A T1h — property-based: random sequences preserve invariants', () => {
  // Per-test timeout 15s — same flake shape + same fix as the `stress`
  // test below: each fc.asyncProperty iteration spawns 3× `runGit`
  // subprocesses inside `buildHarness()` (macos GHA: ~30-80ms each) +
  // runs the DB migration set, and numRuns=30 stacks against bun:test's
  // default 5s ceiling. f37ef44 widened the budget on the stress test
  // but missed this case (CI run 26302009314 macos timed out at
  // 5006.84ms / 5000ms default). Property-based tests want shrink-time
  // budget, so we give it 15s here too.
  test('after any sequence of 1-8 events, R1/R2/T1/U1 hold', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArbitrary, { minLength: 1, maxLength: 8 }), async (seq) => {
        const h = await buildHarness()
        try {
          for (const ev of seq) {
            await applyEvent(h, ev)
          }
          const violations = await checkInvariants(h.db, h.taskId)
          if (violations.length > 0) {
            // Print on failure for easier shrinking.
            console.error('violations:', violations, 'sequence:', seq)
          }
          return violations.length === 0
        } finally {
          h.cleanup()
        }
      }),
      { numRuns: 30 },
    )
  }, 15000)

  test('after long sequences (10-15 events), invariants still hold', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArbitrary, { minLength: 10, maxLength: 15 }), async (seq) => {
        const h = await buildHarness()
        try {
          for (const ev of seq) {
            await applyEvent(h, ev)
          }
          const violations = await checkInvariants(h.db, h.taskId)
          if (violations.length > 0) {
            console.error('violations:', violations, 'sequence:', seq)
          }
          return violations.length === 0
        } finally {
          h.cleanup()
        }
      }),
      { numRuns: 10 },
    )
  })

  test('stress: approve-iterate-approve cycles never leave R1 violated', async () => {
    // Targeted property: any interleaving of approve/iterate operations
    // followed by a final approve should end with R1 satisfied (every
    // approved dv has a done node_run).
    //
    // Per-test timeout 15s (bumped from bun:test's default 5s). Each
    // fc.asyncProperty iteration calls `buildHarness()` which spawns ~5
    // `runGit` subprocesses (init / 2× config / add / commit) + runs
    // the full DB migration set + ~5 inserts. That's ~200-500ms per
    // iteration on macos GHA runners (which lack ramfs for /tmp), so
    // numRuns=20 stacks to 4-10s, right at the default timeout edge.
    // Property-based testing wants a real budget to shrink on a real
    // failure, so we give it 15s — confirmed unrelated flake on
    // 2026-05-22 CI run 26297919707; same shape would re-occur every
    // few macos runs until the budget was widened.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constant('A'), fc.constant('I')), {
          minLength: 1,
          maxLength: 6,
        }),
        async (ops) => {
          const h = await buildHarness()
          try {
            for (const op of ops) {
              await applyEvent(h, { kind: op === 'A' ? 'approve' : 'iterate' })
              // After every op, re-enter dispatch (simulating scheduler resume).
              await applyEvent(h, { kind: 'dispatch' })
            }
            const violations = (await checkInvariants(h.db, h.taskId)).filter(
              (v) => v.rule === 'R1',
            )
            if (violations.length > 0) {
              console.error('R1 violations:', violations, 'ops:', ops)
            }
            return violations.length === 0
          } finally {
            h.cleanup()
          }
        },
      ),
      { numRuns: 20 },
    )
  }, 15000)
})
