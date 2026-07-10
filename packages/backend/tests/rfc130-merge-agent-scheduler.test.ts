import { rimrafDir } from './helpers/cleanup'
// RFC-130 §6.2 — end-to-end scheduler wiring of the built-in merge agent.
//
// Two writer nodes at the same level each run in their OWN iso worktree and both
// overwrite the SAME line of f.txt with DISTINCT content (their node-run id). The
// first merge-back is clean (canonical still == base); the second is a real 3-way
// CONFLICT (canonical advanced under it). That conflict must route through the
// built-in merge agent (resolveMergeConflicts → runNode of aw-merge-resolver in a
// resolve-iso), and:
//   - success shim → conflict resolved → both writers merge_state='merged', task
//     done, a `merge-resolve` child node_run exists, canonical carries the agent's
//     resolution.
//   - failing shim (leaves markers) → framework self-check (D6) rejects it →
//     merge_state='conflict-human', task awaiting_human (conflict never lost).
//
// The shim opencode plays THREE roles by inspecting its cwd: a worker (writes
// unique content), the merge agent in a resolve-iso (writes clean OR marker-laden
// content per MERGE_SHOULD_FAIL). This is the only test that exercises the real
// runNode dispatch of the merge agent through the scheduler.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-mas-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'f.txt'), 'BASE\n')
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

// A shim opencode that overwrites f.txt so writer siblings collide on merge-back,
// then acts as the merge agent when run inside a resolve-iso.
function writeShim(appHome: string): string {
  const shimPath = join(appHome, 'shim-opencode.ts')
  writeFileSync(
    shimPath,
    `
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
const cwd = process.cwd()
const f = join(cwd, 'f.txt')
// Platform-agnostic: the merge agent runs in a cwd whose basename starts with
// 'resolve-' (e.g. 'resolve-repo'). On POSIX the original cwd.includes('/resolve-')
// worked, but Windows backslash paths never match a forward-slash segment.
const isMerge = basename(cwd).startsWith('resolve-')
let port
if (isMerge) {
  // Merge agent. Resolve = write clean content; fail = leave conflict markers.
  if (process.env.MERGE_SHOULD_FAIL === '1') {
    writeFileSync(f, '<<<<<<< ours\\nA\\n=======\\nB\\n>>>>>>> theirs\\n')
  } else {
    writeFileSync(f, 'RESOLVED\\n')
  }
  port = 'resolution'
} else {
  // Worker: overwrite the single line with content unique to this node run
  // (cwd basename = nodeRunId) so two siblings conflict on the second merge-back.
  writeFileSync(f, 'worker-' + basename(cwd) + '\\n')
  port = 'summary'
}
const envl = '<workflow-output>\\n  <port name="' + port + '">done</port>\\n</workflow-output>'
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

function twoWriterDef(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: 'w1', kind: 'agent-single', agentName: 'w1' },
      { id: 'w2', kind: 'agent-single', agentName: 'w2' },
    ],
    edges: [],
  } as unknown as WorkflowDefinition
}

async function seedTask(h: Harness, def: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'mas',
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

describe('RFC-130 §6.2 — merge agent scheduler wiring (real conflict, real dispatch)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('sibling writer conflict → merge agent resolves → both merged, task done, resolution materialized', async () => {
    await seedWriter(h.db, 'w1')
    await seedWriter(h.db, 'w2')
    const shim = writeShim(h.appHome)
    const taskId = await seedTask(h, twoWriterDef())
    await withEnv({ MOCK_OPENCODE_DELAY_MS: '0' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', shim],
        maxConcurrentNodes: 4,
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // Both writers reached done and ended 'merged' (one clean, one via merge agent).
    for (const name of ['w1', 'w2']) {
      const r = runs.find((x) => x.nodeId === name && x.parentNodeRunId === null)
      expect(r?.status).toBe('done')
      expect(r?.mergeState).toBe('merged')
    }
    // A merge-resolve child node_run was minted (the merge agent ran).
    expect(runs.some((r) => r.rerunCause === 'merge-resolve')).toBe(true)
    // Canonical carries the agent's resolution (markers gone).
    const finalF = readFileSync(join(h.worktreePath, 'f.txt'), 'utf8')
    expect(finalF).toBe('RESOLVED\n')
  }, 30_000)

  test('sibling writer conflict → merge agent FAILS (leaves markers) → conflict-human + awaiting_human', async () => {
    await seedWriter(h.db, 'w1')
    await seedWriter(h.db, 'w2')
    const shim = writeShim(h.appHome)
    const taskId = await seedTask(h, twoWriterDef())
    await withEnv({ MOCK_OPENCODE_DELAY_MS: '0', MERGE_SHOULD_FAIL: '1' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', shim],
        maxConcurrentNodes: 4,
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('awaiting_human')
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // Exactly one writer conflicted and could not be resolved → conflict-human.
    const conflicted = runs.filter(
      (r) => r.parentNodeRunId === null && r.mergeState === 'conflict-human',
    )
    expect(conflicted.length).toBe(1)
    // The canonical worktree was NOT polluted with conflict markers (D27): it holds
    // the cleanly-merged sibling's content, never the '<<<<<<<' resolve-iso body.
    const finalF = readFileSync(join(h.worktreePath, 'f.txt'), 'utf8')
    expect(finalF.includes('<<<<<<<')).toBe(false)
  }, 30_000)
})
