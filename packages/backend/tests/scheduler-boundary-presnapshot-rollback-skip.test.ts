// Locked regression: clean-tree pre-snapshot ("") makes a writer retry SKIP rollback,
// so a failed attempt's partial write leaks into the successful retry + final tree.
//
// DEFECT (HIGH):
//   - Pre-snapshot is captured via gitStashSnapshot (scheduler.ts:1540), which
//     returns '' for a CLEAN worktree (git.ts:716-722 — `git stash create` on a
//     clean tree yields empty stdout).
//   - The fresh-session retry rollback is gated `if (!agent.readonly && snap !== '')`
//     (scheduler.ts:1462), so when the pre-snapshot was '' the retry SKIPS rollback
//     entirely.
//   - But rollbackToSnapshot('', ...) (git.ts:739-753) is explicitly written to
//     still `reset --hard HEAD` + `clean -fd` even for an empty sha (only the
//     `stash apply` step is gated on sha!==''). Skipping the whole call therefore
//     leaves the failed attempt's partial write on disk.
//
// Net: a writer agent whose FAILED attempt dirtied a clean worktree leaks that
// stray file into the next (successful) attempt and into the final task tree.
//
// RED until the scheduler stops gating rollback on `snap !== ''` for writer
// (non-readonly) nodes — i.e. always rollback (reset+clean) on a fresh-session
// retry, and let rollbackToSnapshot decide whether to also `stash apply`.
//
// The headline assertion below (stray.txt must NOT exist after a successful
// retry) fails against today's buggy code because rollback was skipped.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runGit } from '../src/util/git'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-red-presnap-skip-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}
async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: JSON.stringify(extra),
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
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

describe('scheduler retry rollback: writer fail-then-succeed must clear partial writes even when pre-snapshot was "" (clean tree)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('failed writer attempt that dirtied a clean worktree is rolled back before the retry (stray.txt must not survive)', async () => {
    // Real git repo with a committed clean baseline. Because the tree is CLEAN
    // when the writer's attempt-0 pre-snapshot is taken, gitStashSnapshot
    // returns '' — which is exactly the condition that trips the rollback gate.
    const repo = h.worktreePath
    await runGit(repo, ['init', '-q', '-b', 'main'])
    await runGit(repo, ['config', 'user.email', 't@e.com'])
    await runGit(repo, ['config', 'user.name', 'T'])
    writeFileSync(join(repo, 'src.txt'), 'base\n')
    await runGit(repo, ['add', '.'])
    await runGit(repo, ['commit', '-q', '-m', 'init'])

    // WRITER agent (readonly=false) so pre-snapshot/rollback are in play.
    await seedAgent(h.db, 'fixer', ['summary'])

    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          agentName: 'fixer',
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)

    await withEnv(
      {
        MOCK_OPENCODE_FAIL_COUNTER: join(h.appHome, 'cnt'),
        MOCK_OPENCODE_FAIL_UNTIL: '1',
        // Only written on attempts that fail (forceFail), into the worktree cwd.
        MOCK_OPENCODE_WRITE_FILE: 'stray.txt',
        MOCK_OPENCODE_WRITE_FILE_CONTENT: 'partial',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'done' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          // RFC-115: retry budget via runTask opts (was node.retries: 1).
          defaultNodeRetries: 1,
        }),
    )

    // The retry (attempt 1) succeeds, so the task is done.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Sanity: attempt 0 failed (wrote stray.txt) and attempt 1 succeeded.
    const runs = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((r) => r.nodeId === 'a1')
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(runs.length).toBe(2)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[1]?.status).toBe('done')
    // The failed attempt's pre-snapshot was '' (clean tree) — this is the exact
    // input that makes the buggy `snap !== ''` gate skip rollback.
    expect(runs[0]?.preSnapshot ?? '').toBe('')

    // HEADLINE RED ASSERTION: the failed attempt's partial write must have been
    // rolled back (reset --hard + clean -fd) before the retry ran. Today the
    // rollback is skipped because the pre-snapshot sha was '' → stray.txt leaks
    // into the final tree → this fails.
    expect(existsSync(join(h.worktreePath, 'stray.txt'))).toBe(false)
  })
})
