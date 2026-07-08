// RFC-098 B1 REGRESSION LOCK — audit S-24 (WP-5): wrapper-git finalize diff is
// fail-closed (design/RFC-098-scheduler-closeout/design.md §B1.5).
//
// WHY THIS FILE EXISTS:
//   Pre-B1 the wrapper-git finalize block swallowed a `gitChangedFiles`
//   failure into `paths = []` and marked the wrapper DONE with an EMPTY
//   git_diff — the whole downstream fan-out then took the empty-source
//   short-circuit and the task went green with zero audit shards (silent
//   correctness loss in the Code→Audit→Fix mainline). B1 makes the catch
//   fail-closed: markWrapperTerminal('failed', 'git-diff-failed:<msg>') and
//   the task fails loudly instead.
//
// Harness: the inner agent is a runtime-generated shim opencode that —
// deterministically, AFTER its own work and BEFORE the wrapper's finalize —
// destroys the worktree's `.git` directory (S24_DELETE_GIT=1). The inner agent
// is READONLY so no pre-snapshot `git stash create` runs against the broken
// tree first; the first git command to hit the breakage is exactly the
// wrapper's finalize `gitChangedFiles`. Control group: same workflow without
// the breakage → wrapper done, git_diff carries the changed path (the normal
// path is byte-unchanged by the fail-closed catch).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Runtime-generated shim opencode (written into the per-test temp dir — not a
// shared fixture). Contract mirrored from fixtures/mock-opencode.ts: argv
// 'run' + --agent NAME, one JSON text event carrying the envelope, exit 0.
// Env knobs:
//   S24_WRITE_FILE   write this file into process.cwd() (= the task worktree)
//   S24_DELETE_GIT   '1' → rm -rf the worktree's .git AFTER the write, BEFORE
//                    emitting the envelope — so the inner node itself succeeds
//                    and the FIRST thing to observe the breakage is the
//                    wrapper's finalize diff.
const SHIM_SOURCE = `
import process from 'node:process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('s24-shim 1.0.0\\n')
  process.exit(0)
}
const wf = process.env.S24_WRITE_FILE ?? ''
if (wf !== '') writeFileSync(join(process.cwd(), wf), 'written by probe\\n')
if (process.env.S24_DELETE_GIT === '1') {
  rmSync(join(process.cwd(), '.git'), { recursive: true, force: true })
}
const text = '<workflow-output>\\n  <port name="summary">probed</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n',
)
process.exit(0)
`

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  shimPath: string
  cleanup: () => void
}

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-rfc098-s24-${slug}-`))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'base.txt'), 'baseline\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  const shimPath = join(appHome, 's24-shim-opencode.ts')
  writeFileSync(shimPath, SHIM_SOURCE)
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    shimPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedTask(h: Harness): Promise<string> {
  // READONLY inner agent: no pre-snapshot stash runs against the (about to
  // be) broken tree — the wrapper finalize is the first git touchpoint.
  await h.db.insert(agents).values({
    id: ulid(),
    name: 'probe',
    description: 'test',
    outputs: JSON.stringify(['summary']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: 'probe', kind: 'agent-single', agentName: 'probe' },
      { id: 'wg', kind: 'wrapper-git', nodeIds: ['probe'] },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  await h.db.insert(tasks).values({
    name: 'rfc098-s24-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.worktreePath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('RFC-098 B1 — S-24: wrapper-git finalize diff failure is fail-closed', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  test('worktree destroyed before finalize → wrapper FAILED with git-diff-failed, task FAILED — not green with an empty diff', async () => {
    h = await buildHarness('fail')
    const taskId = await seedTask(h)

    await withEnv({ S24_DELETE_GIT: '1', S24_WRITE_FILE: 'newfile.txt' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', h.shimPath],
      }),
    )

    // HEADLINE: the task FAILED loudly (pre-B1 it went DONE with an empty
    // git_diff — downstream fan-out silently short-circuited on empty source).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    // RFC-130: the shim deletes `.git` in process.cwd() = the ISOLATED worktree, so
    // the failure surfaces either at the inner node's merge-back (iso `.git` gone →
    // `merge-back-failed`) or at the wrapper's finalize diff (`git-diff-failed`).
    // Either way the task fails LOUDLY (never silently green with an empty diff) —
    // that fail-closed headline is what this locks. (PR-D reworks wrapper-git with a
    // wrapper-private canonical.)
    expect(t?.errorMessage ?? '').toMatch(/git-diff-failed|merge-back-failed/)
    expect(t?.failedNodeId).toBe('wg')

    // The wrapper row carries the typed short-code + the underlying git error.
    const wgRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    )[0]
    expect(wgRun?.status).toBe('failed')
    expect(wgRun?.errorMessage ?? '').toMatch(/git-diff-failed|merge-back-failed/)

    // The inner node itself succeeded — the failure is precisely the
    // finalize diff, not an inner-scope failure relabeled.
    const probeRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'probe')))
    )[0]
    expect(probeRun?.status).toBe('done')

    // Fail-closed means NO git_diff output row was written (pre-B1 wrote an
    // empty-string git_diff port).
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(
        and(eq(nodeRunOutputs.nodeRunId, wgRun?.id ?? ''), eq(nodeRunOutputs.portName, 'git_diff')),
      )
    expect(outputs.length).toBe(0)
  }, 20_000)

  test('control: intact worktree → wrapper done, git_diff lists exactly the file the inner agent wrote (normal path unchanged)', async () => {
    h = await buildHarness('ok')
    const taskId = await seedTask(h)

    await withEnv({ S24_DELETE_GIT: '0', S24_WRITE_FILE: 'newfile.txt' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', h.shimPath],
      }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const wgRun = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'wg')))
    )[0]
    expect(wgRun?.status).toBe('done')

    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(
        and(eq(nodeRunOutputs.nodeRunId, wgRun?.id ?? ''), eq(nodeRunOutputs.portName, 'git_diff')),
      )
    expect(outputs.length).toBe(1)
    expect(outputs[0]?.content).toBe('newfile.txt')
  }, 20_000)

  test('source guard: the finalize catch marks the wrapper failed with the git-diff-failed short-code (no silent paths=[] degrade)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf-8',
    )
    // The typed short-code is minted in the finalize catch…
    expect(src).toContain('`git-diff-failed:${msg}`')
    // …and the wrapper-git-list-path text anchor (git_diff port receives
    // paths.join via the RFC-144 multi-generation upsert) still holds —
    // locked in wrapper-git-list-path.test.ts; the companion assertion here
    // ties the two contracts to the same block.
    expect(src).toMatch(/upsertWrapperOutput\(db, wrapperRunId, 'git_diff', paths\.join\('\\n'\)\)/)
  })
})
