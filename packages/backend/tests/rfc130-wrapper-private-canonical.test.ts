import { rimrafDir } from './helpers/cleanup'
// RFC-130 T11 (D29) — wrapper-PRIVATE canonical (AC-10). A git wrapper's inner
// scope runs in a wrapper-canonical (an iso worktree of the wrapper), so a PARALLEL
// writer sibling merging into the TASK canonical while the wrapper runs CANNOT
// pollute the wrapper's `git_diff`. Pre-RFC-130 the wrapper diffed the task
// canonical directly → the sibling's file leaked in (the writeSem-serialize model
// hid it; the new parallel model would expose it without wrapper-private canonical).
//
// Setup: top level = { git-wrapper[inner writer], sibling writer } with NO edge
// between them → they run in parallel. Each writer (same shim) writes a file named
// after its OWN iso worktree (cwd basename = node-run id). We then assert the
// wrapper's git_diff port contains the INNER node's file but NOT the sibling's.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-wpc-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'seed.txt'), 'seed\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rimrafDir(appHome),
  }
}

// Each writer creates a file named after its own cwd's basename (= its node-run id
// under {appHome}/iso/{taskId}/{nodeRunId}) so inner vs sibling files are distinct.
function writeShim(appHome: string): string {
  const shimPath = join(appHome, 'shim-opencode.ts')
  writeFileSync(
    shimPath,
    `
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
const cwd = process.cwd()
writeFileSync(join(cwd, basename(cwd) + '.txt'), 'x\\n')
const envl = '<workflow-output>\\n  <port name="summary">ok</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envl } }) + '\\n',
)
process.exit(0)
`,
  )
  return shimPath
}

async function seedWriter(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['summary']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

function def(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['inner'] },
      { id: 'inner', kind: 'agent-single', agentName: 'w', promptTemplate: 'go' },
      { id: 'sib', kind: 'agent-single', agentName: 'w', promptTemplate: 'go' },
    ],
    edges: [],
  } as unknown as WorkflowDefinition
}

async function seedTask(h: Harness, d: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(d),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'wpc',
    workflowId,
    workflowSnapshot: JSON.stringify(d),
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

describe('RFC-130 T11 — wrapper-private canonical (AC-10)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test("git wrapper git_diff excludes a parallel sibling writer's file", async () => {
    await seedWriter(h.db, 'w')
    const shim = writeShim(h.appHome)
    const taskId = await seedTask(h, def())
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', shim],
      maxConcurrentNodes: 4,
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const innerRun = runs.find((r) => r.nodeId === 'inner')
    const sibRun = runs.find((r) => r.nodeId === 'sib')
    const gwRun = runs.find((r) => r.nodeId === 'gw')
    expect(innerRun && sibRun && gwRun).toBeTruthy()

    const gitDiff = (
      await h.db
        .select()
        .from(nodeRunOutputs)
        .where(
          and(eq(nodeRunOutputs.nodeRunId, gwRun!.id), eq(nodeRunOutputs.portName, 'git_diff')),
        )
    )[0]
    const files = (gitDiff?.content ?? '').split('\n').filter((p) => p.length > 0)

    // The wrapper's diff carries the INNER node's file (merged into the
    // wrapper-canonical) and NOT the parallel sibling's (which merged into the
    // TASK canonical, isolated from the wrapper-canonical) — AC-10.
    expect(files).toContain(`${innerRun!.id}.txt`)
    expect(files).not.toContain(`${sibRun!.id}.txt`)
    // The sibling's write DID reach the task canonical (proving it ran in parallel
    // and merged back — so the exclusion above is real isolation, not a no-op).
    const canonFiles = (
      await runGit(h.worktreePath, ['status', '--porcelain', '--untracked-files=all'])
    ).stdout
    expect(canonFiles).toContain(`${sibRun!.id}.txt`)
  }, 30_000)
})
