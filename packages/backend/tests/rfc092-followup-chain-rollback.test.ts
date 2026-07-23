// RFC-092 T2 — S-2b regression: fresh → followup → fresh retry chain rolls
// back to the LAST FRESH-SESSION baseline, not to a bare reset+clean.
//
// Locks design/RFC-092-scheduler-p0-stopgap/design.md §2.2 / 测试策略 §5-9:
//   the scheduler's in-process retry rollback uses the `lastFreshSnapshot`
//   local (the pre-snapshot written by the most recent FRESH-SESSION attempt
//   of this runOneNode invocation). Followup attempts write no snapshot and do
//   NOT overwrite it. The deleted `readSnapshotForLatestRun` would instead
//   pick the latest row by desc(retryIndex) — the followup attempt's
//   snapshot-less row — read NULL → '' and degrade "roll back to baseline X"
//   into a plain reset+clean, silently destroying a dirty baseline that
//   existed BEFORE the task ever ran (S-2b).
//
// Chain construction (single repo, writer agent, retries=2):
//   pre-task: worktree carries an uncommitted TRACKED modification
//             (src.txt = DIRTY-BASELINE) — the baseline X. (gitStashSnapshot
//             is `git stash create`, which captures tracked changes only, so
//             X is expressed as a tracked mutation, not an untracked file.)
//   attempt 0 (fresh): pre-snapshot captures X. The mock writes a half-done
//             untracked file + overwrites src.txt, then fails in the ONLY
//             shape decideEnvelopeFollowup accepts (scheduler.ts): clean
//             exit 0 + captured session id + ≥1 text event + no envelope
//             ('no <workflow-output> envelope found in stdout').
//   attempt 1 (followup, --session): no rollback, no snapshot — the mock
//             records the inherited state (proves the worktree was KEPT),
//             writes a second half-done file, then fails non-followup-ably
//             (exit 7).
//   attempt 2 (fresh): decideEnvelopeFollowup says no (exit!=0, and zero text
//             events) → fresh-session retry → rollback to lastFreshSnapshot
//             (attempt 0's X-bearing stash). The mock records the retry-start
//             state, emits a valid envelope and succeeds.
//
// HEADLINE: at attempt-2 start, X is restored (DIRTY-BASELINE back) and both
// attempts' half-products are gone. Under the pre-fix code the same chain
// reset src.txt to its committed HEAD body — losing X.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Self-contained mini-mock opencode (written into the per-test temp dir).
// Counter-keyed behavior — see the chain construction in the file header.
// Manifests record { half0, half1, src } so the test can assert exactly what
// each attempt inherited on disk at its start.
const MINI_MOCK_SOURCE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const env = process.env
const __awArgv = process.argv.slice(2)
const prompt = __awArgv.includes('--') ? __awArgv.slice(__awArgv.indexOf('--') + 1).join(' ') : (__awArgv[1] ?? '')
const nonce = /\\bnonce="([^"]+)"/.exec(prompt)?.[1]
const outputOpen =
  nonce === undefined ? '<workflow-output>' : '<workflow-output nonce="' + nonce + '">'
const counterFile = env.S2B_COUNTER_FILE
if (!counterFile) {
  process.stderr.write('S2B_COUNTER_FILE unset\\n')
  process.exit(2)
}
let n = 0
if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
n += 1
writeFileSync(counterFile, String(n))
if (env.S2B_ARGV_LOG) {
  appendFileSync(env.S2B_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
}
const wt = process.cwd() // runner spawns opencode with cwd = task worktree
const srcFile = join(wt, 'src.txt')
const half0 = join(wt, 'half-attempt0.txt')
const half1 = join(wt, 'half-attempt1.txt')
const recordManifest = (file) =>
  writeFileSync(
    file,
    JSON.stringify({
      half0: existsSync(half0),
      half1: existsSync(half1),
      src: readFileSync(srcFile, 'utf-8'),
    }),
  )
if (n === 1) {
  // fresh attempt 0: half-done writes, then the followup-able failure shape:
  // clean exit + session id + >=1 text event + NO envelope.
  writeFileSync(half0, 'partial-from-attempt0\\n')
  writeFileSync(srcFile, 'half-modified-by-attempt0\\n')
  process.stdout.write(
    JSON.stringify({ type: 'session.created', sessionID: 'opc_s2b_chain', timestamp: Date.now() }) +
      '\\n',
  )
  process.stdout.write(
    JSON.stringify({
      type: 'text',
      timestamp: Date.now(),
      part: { type: 'text', text: 'thinking out loud, forgot the envelope' },
    }) + '\\n',
  )
  process.exit(0)
}
if (n === 2) {
  // followup attempt 1: record the inherited state, write more half-product,
  // then fail in a NON-followup-able shape (non-zero exit, zero text events).
  if (env.S2B_MANIFEST_FOLLOWUP) recordManifest(env.S2B_MANIFEST_FOLLOWUP)
  writeFileSync(half1, 'partial-from-attempt1\\n')
  process.exit(7)
}
// fresh attempt 2: record the retry-start state, emit a valid envelope, succeed.
if (env.S2B_MANIFEST_FRESH) recordManifest(env.S2B_MANIFEST_FRESH)
const envelope = outputOpen + '\\n  <port name="summary">ok</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envelope } }) +
    '\\n',
)
process.exit(0)
`

interface Harness {
  db: DbClient
  appHome: string
  /** Single-repo worktree — a real git repo so stash snapshot/rollback work. */
  worktree: string
  miniMockPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-s2b-chain-'))
  const worktree = join(appHome, 'worktrees', 'single', 'wt')
  mkdirSync(worktree, { recursive: true })
  await runGit(worktree, ['init', '-q', '-b', 'main'])
  await runGit(worktree, ['config', 'user.email', 't@e.com'])
  await runGit(worktree, ['config', 'user.name', 'T'])
  writeFileSync(join(worktree, 'src.txt'), 'base\n')
  await runGit(worktree, ['add', '.'])
  await runGit(worktree, ['commit', '-q', '-m', 'init'])
  const miniMockPath = join(appHome, 's2b-mini-opencode.ts')
  writeFileSync(miniMockPath, MINI_MOCK_SOURCE)
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktree,
    miniMockPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedWriterAgent(db: DbClient, name: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
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
  return id
}

async function seedSingleRepoTask(h: Harness, agentId: string): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      {
        id: 'a1',
        kind: 'agent-single',
        agentId,
        agentName: 'fixer',
      } as unknown as WorkflowDefinition['nodes'][number],
    ],
    edges: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.worktree,
    worktreePath: h.worktree,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    // repoCount defaults to 1 — single-repo path throughout.
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

interface Manifest {
  half0: boolean
  half1: boolean
  src: string
}

describe('S-2b followup-chain retry rollback restores the last FRESH baseline (RFC-092 REGRESSION LOCK)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('fresh(snapshot=X) → followup(keeps worktree) → fresh retry starts on X: dirty baseline restored, both half-products gone', async () => {
    const agentId = await seedWriterAgent(h.db, 'fixer')
    const taskId = await seedSingleRepoTask(h, agentId)

    // Baseline X: an uncommitted TRACKED modification present BEFORE the task
    // runs. attempt 0's pre-snapshot (git stash create) captures it.
    writeFileSync(join(h.worktree, 'src.txt'), 'base\nDIRTY-BASELINE\n')

    const manifestFollowup = join(h.appHome, 's2b-manifest-followup.json')
    const manifestFresh = join(h.appHome, 's2b-manifest-fresh.json')
    const argvLog = join(h.appHome, 's2b-argv.log')

    await withEnv(
      {
        S2B_COUNTER_FILE: join(h.appHome, 's2b-counter'),
        S2B_MANIFEST_FOLLOWUP: manifestFollowup,
        S2B_MANIFEST_FRESH: manifestFresh,
        S2B_ARGV_LOG: argvLog,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.miniMockPath],
          // RFC-115: retry budget via runTask opts (was node.retries: 2 →
          // attempts 0 fresh, 1 followup, 2 fresh).
          defaultNodeRetries: 2,
        }),
    )

    // Attempt 2 succeeded → task done.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Three attempts: 0 failed (fresh), 1 failed (followup), 2 done (fresh).
    const runs = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((r) => r.nodeId === 'a1')
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(runs.map((r) => r.status)).toEqual(['failed', 'failed', 'done'])

    // ── Chain-shape evidence: the middle attempt really was a same-session
    // followup. (a) argv: only invocation 2 carries --session with the id
    // attempt 0 emitted; (b) the RFC-042 audit event sits on the retryIndex-1
    // row; (c) snapshot dual evidence: fresh rows carry a non-empty
    // preSnapshot (X was captured), the followup row carries NULL (it never
    // snapshots — exactly the row the deleted desc(retryIndex) picker would
    // have wrongly used as the rollback source).
    const argvs = readFileSync(argvLog, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[])
    expect(argvs.length).toBe(3)
    expect(argvs[0]).not.toContain('--session')
    const sessionIdx = argvs[1]!.indexOf('--session')
    expect(sessionIdx).toBeGreaterThanOrEqual(0)
    expect(argvs[1]![sessionIdx + 1]).toBe('opc_s2b_chain')
    expect(argvs[2]).not.toContain('--session')
    const followupEvents = await h.db
      .select()
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, runs[1]!.id))
    expect(followupEvents.some((e) => e.payload.includes('[rfc042/envelope-followup]'))).toBe(true)
    // RFC-130: the iso model no longer writes pre-snapshot columns — every attempt
    // ran in an iso and the canonical worktree was never touched. All NULL.
    expect(runs[0]?.preSnapshot).toBeNull()
    expect(runs[1]?.preSnapshot).toBeNull()
    expect(runs[2]?.preSnapshot).toBeNull()

    // ── Followup attempt inherited the SAME iso AS-IS (RFC-130 D17: a same-session
    // followup keeps its iso worktree): attempt 0's half-product and tracked
    // overwrite were both still on disk in the reused iso.
    const atFollowup = JSON.parse(readFileSync(manifestFollowup, 'utf-8')) as Manifest
    expect(atFollowup.half0).toBe(true)
    expect(atFollowup.half1).toBe(false)
    expect(atFollowup.src).toBe('half-modified-by-attempt0\n')

    // ── HEADLINE (RFC-130): the fresh retry (attempt 2) started on a FRESH iso
    // re-branched from the canonical worktree — which still carries the pre-task
    // dirty baseline X (the failed attempts lived in the discarded iso0, so
    // canonical was never modified). Both attempts' half-products are absent.
    const atFresh = JSON.parse(readFileSync(manifestFresh, 'utf-8')) as Manifest
    expect(atFresh.half0).toBe(false)
    expect(atFresh.half1).toBe(false)
    expect(atFresh.src).toBe('base\nDIRTY-BASELINE\n')

    // ── Final tree after the done task: baseline X still present (attempt 2
    // wrote nothing into the worktree), half-products gone for good.
    expect(readFileSync(join(h.worktree, 'src.txt'), 'utf-8')).toBe('base\nDIRTY-BASELINE\n')
    expect(existsSync(join(h.worktree, 'half-attempt0.txt'))).toBe(false)
    expect(existsSync(join(h.worktree, 'half-attempt1.txt'))).toBe(false)
  })
})
