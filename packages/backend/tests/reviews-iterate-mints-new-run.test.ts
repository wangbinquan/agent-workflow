import { rimrafDir } from './helpers/cleanup'
// Locks in RFC-011 backend semantics: review reject / iterate must not
// reset the latest upstream node_run in place. Instead it marks the old
// row canceled (with a stable supersede prefix on errorMessage) and mints
// a fresh node_run at retry_index+1 inheriting preSnapshot. This preserves
// the old row's promptText / outputs so the Prompt-tab attempts switcher
// (RFC-011 T2) can render historical prompts.
//
// If this goes red, services/review.ts:submitReviewDecision iterate/reject
// branch is out of lock-step with RFC-011 design §3.1.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { createWorkflow } from '../src/services/workflow'
import { submitReviewDecision } from '../src/services/review'
import { startTask } from '../src/services/task'
import { isWindows, stubCmd } from './helpers/stub-runtime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  taskId: string
  worktreePath: string
  reviewNodeRunId: string
  cleanup: () => Promise<void>
}

interface HarnessOpts {
  secondReviewNode?: boolean
  /**
   * Overrides for the review node's rollback flags. Defaults to neither
   * key (so review.ts uses its decision-specific defaults: rollbackOnReject=true,
   * rollbackOnIterate=false). Tests that need to assert the `-rollback`
   * marker on iterate / suppress it on reject pass these explicitly.
   */
  rollbackFilesOnIterate?: boolean
  rollbackFilesOnReject?: boolean
}

const REVIEW_DOC = '# Design v1\n\nThe `order_status` enum should include partially_refunded.\n'

let runIdx = 0

function makeStubOpencode(dir: string): string {
  const body = REVIEW_DOC.replace(/\n/g, '\\n')
  if (isWindows) {
    const path = join(dir, 'stub-opencode.js')
    const lines = [
      `// Auto-generated stub opencode for Windows test compatibility`,
      `const { writeFileSync, readFileSync, existsSync } = require('node:fs')`,
      ``,
      `const args = process.argv.slice(2)`,
      ``,
      `if (args.includes('--version')) {`,
      `  process.stdout.write(${JSON.stringify('stub-opencode 1.14.99\n')})`,
      `  process.exit(0)`,
      `}`,
      ``,
      `if (args[0] !== 'run') {`,
      `  process.stderr.write('stub-opencode: expected run, got: ' + args[0] + '\\n')`,
      `  process.exit(2)`,
      `}`,
      ``,
      `const BODY = ${JSON.stringify(REVIEW_DOC)}`,
      `let envelope = '<workflow-output>\\n  <port name="design">' + BODY + '</port>\\n</workflow-output>'`,
      `process.stdout.write(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envelope } }) + '\\n')`,
      `process.exit(0)`,
    ]
    writeFileSync(path, lines.join('\n'))
    return path
  }
  const path = join(dir, 'stub-opencode.sh')
  const script = `#!/usr/bin/env bash
set -e
if [[ "$1" == "--version" ]]; then
  echo 'stub-opencode 1.14.99'
  exit 0
fi
if [[ "$1" == "run" ]]; then
  BODY='${body}'
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

async function buildHarness(opts?: HarnessOpts): Promise<Harness> {
  runIdx++
  const tmp = mkdtempSync(join(tmpdir(), `aw-rfc011-${runIdx}-`))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  const db = createInMemoryDb(MIGRATIONS)

  execSync('git init -b main', { cwd: tmp, stdio: 'ignore' })
  mkdirSync(repoPath, { recursive: true })
  execSync(`git init -b main "${repoPath}"`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.email t@t.test`, { stdio: 'ignore' })
  execSync(`git -C "${repoPath}" config user.name t`, { stdio: 'ignore' })
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`, { stdio: 'ignore' })

  const stubOpencode = makeStubOpencode(tmp)

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

  // Use loose typing — the workflow schema accepts unknown extras and the
  // reviewer fields aren't part of WorkflowNodeSchema's strict shape.
  const rollbackOverrides: Record<string, boolean> = {}
  if (opts?.rollbackFilesOnIterate !== undefined) {
    rollbackOverrides.rollbackFilesOnIterate = opts.rollbackFilesOnIterate
  }
  if (opts?.rollbackFilesOnReject !== undefined) {
    rollbackOverrides.rollbackFilesOnReject = opts.rollbackFilesOnReject
  }
  const reviewNodes = [
    {
      id: 'rev_1',
      kind: 'review' as const,
      inputSource: { nodeId: 'designer', portName: 'design' },
      rerunnableOnReject: ['designer'],
      rerunnableOnIterate: ['designer'],
      ...rollbackOverrides,
    },
  ]
  if (opts?.secondReviewNode === true) {
    reviewNodes.push({
      id: 'rev_2',
      kind: 'review' as const,
      inputSource: { nodeId: 'designer', portName: 'design' },
      rerunnableOnReject: ['designer'],
      rerunnableOnIterate: ['designer'],
      ...rollbackOverrides,
    })
  }

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
        ...reviewNodes,
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

  process.env.AGENT_WORKFLOW_HOME = appHome

  const task = await startTask(
    {
      workflowId: wf.id,
      name: 'fixture-task',
      repoPath,
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    },
    { db, appHome, opencodeCmd: stubCmd(stubOpencode), awaitScheduler: true },
  )

  const reviewRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, task.id), eq(nodeRuns.nodeId, 'rev_1')))
  if (reviewRuns.length === 0) throw new Error('rev_1 node_run not created')

  return {
    db,
    appHome,
    taskId: task.id,
    worktreePath: task.worktreePath,
    reviewNodeRunId: reviewRuns[0]!.id,
    cleanup: async () => {
      rimrafDir(tmp)
      delete process.env.AGENT_WORKFLOW_HOME
    },
  }
}

/**
 * The stub agent never dirties files, so `git stash create` against the
 * worktree returns '' and `node_runs.pre_snapshot` stays empty — meaning
 * the review.ts rollback branch is skipped regardless of the rollback flag.
 *
 * To exercise the actual rollback path (and the new `-rollback` supersede
 * marker it produces), tests call this helper after startTask: it dirties
 * the worktree, captures a real stash sha, and writes that sha into the
 * latest designer node_run's pre_snapshot column. From there a subsequent
 * submitReviewDecision with rollback=true will invoke rollbackToSnapshot,
 * succeed, and tag the canceled row with `-rollback`.
 */
async function seedDesignerPreSnapshot(h: Harness): Promise<string> {
  writeFileSync(join(h.worktreePath, 'dirty.txt'), 'pretend-uncommitted-work\n')
  // `git stash create` skips untracked files, so add the file first to put
  // it in the index — then the stash sha is non-empty and rollbackToSnapshot
  // can apply it back.
  execSync('git add dirty.txt', { cwd: h.worktreePath })
  const sha = execSync('git stash create', { cwd: h.worktreePath }).toString().trim()
  if (sha === '') throw new Error('git stash create returned empty sha')
  // Update the latest non-shard designer row.
  const rows = await fetchDesignerTopRuns(h)
  const target = rows[rows.length - 1]
  if (target === undefined) throw new Error('no designer node_run to seed')
  await h.db.update(nodeRuns).set({ preSnapshot: sha }).where(eq(nodeRuns.id, target.id))
  return sha
}

async function fetchDesignerTopRuns(h: Harness) {
  const rows = await h.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'designer')))
  return rows.filter((r) => r.parentNodeRunId === null).sort((a, b) => a.retryIndex - b.retryIndex)
}

describe('RFC-011 review reject/iterate mints a fresh node_run', () => {
  let h: Harness
  afterEach(async () => {
    await h.cleanup()
  })

  test('iterate keeps the old upstream run as canceled and preserves its promptText', async () => {
    h = await buildHarness()
    const beforeRuns = await fetchDesignerTopRuns(h)
    expect(beforeRuns.length).toBe(1)
    const originalPrompt = beforeRuns[0]!.promptText
    expect(originalPrompt).not.toBeNull()

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const afterRuns = await fetchDesignerTopRuns(h)
    expect(afterRuns.length).toBe(2)
    const old = afterRuns[0]!
    expect(old.retryIndex).toBe(0)
    expect(old.status).toBe('canceled')
    expect(old.promptText).toBe(originalPrompt) // not overwritten
    expect(old.errorMessage).toContain('superseded-by-review-iterated')
    // Default iterate has rollbackFilesOnIterate=false AND the stub never
    // dirtied the worktree, so rollback was not performed — marker must NOT
    // carry the `-rollback` suffix.
    expect(old.errorMessage).toMatch(/^superseded-by-review-iterated:/)
    expect(old.errorMessage).not.toContain('-rollback')
    expect(old.finishedAt).not.toBeNull()
  })

  test('iterate mints a new pending row at retry_index+1 inheriting preSnapshot', async () => {
    h = await buildHarness()
    const before = (await fetchDesignerTopRuns(h))[0]!
    const beforeSnapshot = before.preSnapshot

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const afterRuns = await fetchDesignerTopRuns(h)
    const fresh = afterRuns.find((r) => r.retryIndex === 1)
    expect(fresh).toBeDefined()
    expect(fresh!.status).toBe('pending')
    expect(fresh!.preSnapshot).toBe(beforeSnapshot)
    expect(fresh!.parentNodeRunId).toBeNull()
    expect(fresh!.iteration).toBe(before.iteration)
    // The fresh row is the one the scheduler will pick up next; its
    // promptText starts blank until runner.ts:127 writes the new prompt.
    expect(fresh!.promptText).toBeNull()
  })

  test('reject does the same and sibling review nodes still cascade back to awaiting_review', async () => {
    h = await buildHarness({ secondReviewNode: true })
    const before = await fetchDesignerTopRuns(h)
    expect(before.length).toBe(1)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    expect(after.length).toBe(2)
    expect(after[0]!.status).toBe('canceled')
    expect(after[0]!.errorMessage).toContain('superseded-by-review-rejected')
    // Default reject has rollbackFilesOnReject=true but the stub left the
    // worktree clean → preSnapshot is empty → rollback branch was skipped →
    // marker must still be the plain form.
    expect(after[0]!.errorMessage).toMatch(/^superseded-by-review-rejected:/)
    expect(after[0]!.errorMessage).not.toContain('-rollback')
    expect(after[1]!.status).toBe('pending')
    expect(after[1]!.retryIndex).toBe(1)

    // Sibling review row (rev_2) should be reset back to awaiting_review by
    // cascadeSiblingReviews so the upstream re-run invalidates its content.
    const rev2 = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, h.taskId), eq(nodeRuns.nodeId, 'rev_2')))
    expect(rev2.length).toBeGreaterThan(0)
    // Sibling that was awaiting_review or done is bumped to awaiting_review
    // by cascadeSiblingReviews. Either way it should not stay 'done'.
    for (const r of rev2) {
      expect(r.status).not.toBe('done')
    }
  })

  // The next four cases lock in the `-rollback` supersede marker that the
  // frontend uses to pick between the 'Canceled' label (worktree files
  // actually rolled back) and the 'Superseded' label (files kept). The
  // marker is added in services/review.ts iff rollbackToSnapshot completed
  // without throwing — which requires both a non-empty preSnapshot and
  // rollbackFlag=true.

  test('iterate with rollbackFilesOnIterate=true tags the canceled row with -rollback', async () => {
    h = await buildHarness({ rollbackFilesOnIterate: true })
    await seedDesignerPreSnapshot(h)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    const old = after.find((r) => r.retryIndex === 0)!
    expect(old.status).toBe('canceled')
    expect(old.errorMessage).toMatch(/^superseded-by-review-iterated-rollback:/)
  })

  test('iterate without rollback flag leaves no -rollback marker even with seeded preSnapshot', async () => {
    h = await buildHarness() // default rollbackFilesOnIterate=false
    await seedDesignerPreSnapshot(h)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    const old = after.find((r) => r.retryIndex === 0)!
    expect(old.errorMessage).toMatch(/^superseded-by-review-iterated:/)
    expect(old.errorMessage).not.toContain('-rollback')
  })

  test('reject with default rollbackFilesOnReject=true tags the canceled row with -rollback', async () => {
    h = await buildHarness()
    await seedDesignerPreSnapshot(h)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    const old = after.find((r) => r.retryIndex === 0)!
    expect(old.errorMessage).toMatch(/^superseded-by-review-rejected-rollback:/)
  })

  test('reject with rollbackFilesOnReject=false omits the -rollback marker', async () => {
    h = await buildHarness({ rollbackFilesOnReject: false })
    await seedDesignerPreSnapshot(h)

    await submitReviewDecision({
      db: h.db,
      appHome: h.appHome,
      nodeRunId: h.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    const after = await fetchDesignerTopRuns(h)
    const old = after.find((r) => r.retryIndex === 0)!
    expect(old.errorMessage).toMatch(/^superseded-by-review-rejected:/)
    expect(old.errorMessage).not.toContain('-rollback')
  })
})
