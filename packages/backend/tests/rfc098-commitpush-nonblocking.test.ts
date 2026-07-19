// RFC-098 B1 REGRESSION LOCK — commit&push moved OUT of the dispatch loop
// (audit S-17 second half + adversarial-review revision #2,
// design/RFC-098-scheduler-closeout/design.md §B1.4).
//
// WHY THIS FILE EXISTS:
//   Pre-B1 the runScope dispatch loop AWAITED maybeRunCommitPush synchronously
//   after every top-level node ok — the whole loop froze for the duration of
//   the commit-agent opencode session (no new completions raced, no ready
//   nodes dispatched). B1 mints the commit as a SYNTHETIC in-flight entry
//   keyed 'commitpush:<nodeId>:<iter>' (a NON-node key, so deriveFrontier's
//   in-flight set never freezes a real node) and the loop keeps racing.
//
//   Test 1 (non-blocking): with a SLOW commit session, the downstream ready
//   node is spawned WHILE the commit session is still running —
//   trace order: node2.start < first-commit.end. Pre-B1 node2.start was
//   strictly >= commit.end (the synchronous await). A file-backed barrier
//   keeps the first commit session open until node2 actually starts, avoiding
//   a fixed millisecond window that collapses under full-suite load.
//
//   Test 2 (cancel drains synthetics — revision #2): a cancel landing while
//   the commit session is in flight must DRAIN the synthetic before runScope
//   returns — otherwise the abandoned commit session (a worktree-writing git
//   process) would outlive runTask's finally and race the write-lock registry
//   gc. Oracle: runTask resolves, task is 'canceled', and EVERY node_runs row
//   (incl. the commit container + its session child) is settled — nothing
//   left 'running'/'pending'.

import type { CommitPushMeta, WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { commitPushNodeId, COMMIT_AGENT_NAME } from '../src/services/commitPush'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Runtime-generated shim opencode (per-test temp dir, not a shared fixture).
// One shim plays all roles, keyed by --agent:
//   'commit'  → sleep CP_COMMIT_DELAYS[callIndex] ms, emit commit_message.
//   others    → sleep CP_DELAY_MS_FOR_<agent> ms, optionally write
//               CP_WRITE_FILE_FOR_<agent> into cwd (= the task worktree),
//               emit <port name="out">.
// Every invocation appends {agent, callIndex, phase: start|end, t} to
// CP_STATE_DIR/trace.jsonl so the test can compare subprocess lifetimes
// (start = spawn reached, end = just before exit).
const SHIM_SOURCE = `
import process from 'node:process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('cp-shim 1.0.0\\n')
  process.exit(0)
}
const nonce = /\\bnonce="([^"]+)"/.exec(argv[1] ?? '')?.[1]
const outputOpen =
  nonce === undefined ? '<workflow-output>' : '<workflow-output nonce="' + nonce + '">'
const ai = argv.indexOf('--agent')
const agent = ai >= 0 ? (argv[ai + 1] ?? '') : ''
const stateDir = process.env.CP_STATE_DIR ?? ''
mkdirSync(stateDir, { recursive: true })
const counterFile = join(stateDir, 'count-' + agent)
let n = 0
if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
writeFileSync(counterFile, String(n + 1))
const trace = (phase) =>
  appendFileSync(
    join(stateDir, 'trace.jsonl'),
    JSON.stringify({ agent, callIndex: n, phase, t: Date.now() }) + '\\n',
  )
trace('start')
writeFileSync(join(stateDir, 'started-' + agent), String(Date.now()))
let text
if (agent === 'commit') {
  const waitForAgent = process.env.CP_COMMIT_WAIT_FOR_AGENT ?? ''
  if (n === 0 && waitForAgent !== '') {
    const timeoutMs = Number(process.env.CP_COMMIT_WAIT_TIMEOUT_MS ?? '10000')
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 10000)
    const marker = join(stateDir, 'started-' + waitForAgent)
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
    if (!existsSync(marker)) {
      writeFileSync(join(stateDir, 'wait-timeout-commit-0'), waitForAgent)
    }
  }
  const delays = JSON.parse(process.env.CP_COMMIT_DELAYS ?? '[]')
  const d = Number(delays[n] ?? 0)
  if (Number.isFinite(d) && d > 0) await Bun.sleep(d)
  text = outputOpen + '<port name="commit_message">test: cp shim commit</port></workflow-output>'
} else {
  const d = Number(process.env['CP_DELAY_MS_FOR_' + agent] ?? '0')
  if (Number.isFinite(d) && d > 0) await Bun.sleep(d)
  const wf = process.env['CP_WRITE_FILE_FOR_' + agent] ?? ''
  if (wf !== '') writeFileSync(join(process.cwd(), wf), 'written by ' + agent + '\\n')
  text = outputOpen + '<port name="out">done-' + agent + '</port></workflow-output>'
}
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n',
)
trace('end')
process.exit(0)
`

interface TraceEvent {
  agent: string
  callIndex: number
  phase: 'start' | 'end'
  t: number
}

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  remote: string
  shimPath: string
  stateDir: string
  cleanup: () => void
}

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-rfc098-cp-${slug}-`))
  const worktreePath = join(appHome, 'wt')
  const remote = join(appHome, 'remote.git')
  const stateDir = join(appHome, 'shim-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(remote, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  await runGit(remote, ['init', '-q', '--bare', '-b', 'main'])
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'README.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  await runGit(worktreePath, ['remote', 'add', 'origin', remote])
  await runGit(worktreePath, ['push', '-q', '-u', 'origin', 'main'])
  const shimPath = join(appHome, 'cp-shim-opencode.ts')
  writeFileSync(shimPath, SHIM_SOURCE)
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    remote,
    shimPath,
    stateDir,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['out']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

/** n1 (writer) → n2 (readonly): n2 becomes ready only AFTER n1 completes, so
 *  "n2 dispatched while n1's commit session runs" is a real ordering claim,
 *  not a same-frame coincidence. */
async function seedTask(h: Harness): Promise<string> {
  await seedAgent(h.db, 'n1')
  await seedAgent(h.db, 'n2')
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: 'n1', kind: 'agent-single', agentName: 'n1' },
      { id: 'n2', kind: 'agent-single', agentName: 'n2' },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'n1', portName: 'out' },
        target: { nodeId: 'n2', portName: 'ctx' },
      },
    ],
  }
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  await h.db.insert(tasks).values({
    name: 'rfc098-cp-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.worktreePath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    // The worktree sits on 'main' (no isolation-branch checkout in this
    // harness) — keep the push refspec source aligned so the push succeeds.
    branch: 'main',
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
    autoCommitPush: true,
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

function readTrace(stateDir: string): TraceEvent[] {
  const path = join(stateDir, 'trace.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TraceEvent)
}

describe('RFC-098 B1 — auto commit&push runs as a synthetic in-flight entry, not a dispatch-loop freeze', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness('run')
  })
  afterEach(() => h.cleanup())

  test('ready downstream node is dispatched WHILE the slow commit session runs (n2.start < first commit end)', async () => {
    const taskId = await seedTask(h)

    // n1 completes instantly leaving a dirty worktree. The first commit
    // session waits on n2's process-start marker, so the ordering oracle is a
    // handshake rather than a scheduler-speed assumption. With the old
    // synchronous await, n2 can never create that marker before the commit's
    // 10s deadline and this test deterministically fails. n2's completion
    // triggers a SECOND commit session (callIndex 1) — keep that one delayed
    // so the first session commits+pushes first and the second finds nothing
    // left to commit (its outcome is not asserted; commit failures never
    // break task execution).
    await withEnv(
      {
        CP_STATE_DIR: h.stateDir,
        CP_WRITE_FILE_FOR_n1: 'change.txt',
        CP_COMMIT_WAIT_FOR_AGENT: 'n2',
        CP_COMMIT_WAIT_TIMEOUT_MS: '10000',
        CP_COMMIT_DELAYS: JSON.stringify([0, 1500]),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.shimPath],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    const trace = readTrace(h.stateDir)
    const n1End = trace.find((e) => e.agent === 'n1' && e.phase === 'end')
    const n2Start = trace.find((e) => e.agent === 'n2' && e.phase === 'start')
    const commit0Start = trace.find(
      (e) => e.agent === COMMIT_AGENT_NAME && e.callIndex === 0 && e.phase === 'start',
    )
    const commit0End = trace.find(
      (e) => e.agent === COMMIT_AGENT_NAME && e.callIndex === 0 && e.phase === 'end',
    )
    expect(n1End).toBeDefined()
    expect(n2Start).toBeDefined()
    expect(commit0Start).toBeDefined()
    expect(commit0End).toBeDefined()

    // Sanity: the commit session was triggered by n1's completion.
    expect(commit0Start!.t).toBeGreaterThanOrEqual(n1End!.t)

    // HEADLINE (flipped semantics vs the pre-B1 synchronous await): n2 was
    // SPAWNED before the first commit session could finish — the dispatch
    // loop did not freeze. Pre-B1, n2.start >= commit0.end held structurally;
    // the file-backed wait would time out before allowing that old ordering.
    expect(existsSync(join(h.stateDir, 'wait-timeout-commit-0'))).toBe(false)
    expect(n2Start!.t).toBeLessThan(commit0End!.t)

    // The commit landed for real: n1's commit container row is done & pushed,
    // and the remote got the branch tip.
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const commitRow = rows.find(
      (r) => r.nodeId === commitPushNodeId('n1') && r.commitPushJson !== null,
    )
    expect(commitRow).toBeDefined()
    expect(commitRow!.status).toBe('done')
    const meta = JSON.parse(commitRow!.commitPushJson!) as CommitPushMeta
    expect(meta.pushOutcome).toBe('pushed')

    // Drain determinism on the OK path: nothing is left un-settled after
    // runTask returns (the synthetics resolved inside the race set).
    expect(rows.filter((r) => r.status === 'running' || r.status === 'pending').length).toBe(0)
  }, 30_000)

  test('cancel mid-commit: synthetics are drained — task lands canceled with every row settled, no orphaned commit session', async () => {
    const taskId = await seedTask(h)

    const controller = new AbortController()
    const runP = withEnv(
      {
        CP_STATE_DIR: h.stateDir,
        CP_WRITE_FILE_FOR_n1: 'change.txt',
        // n2 sleeps long enough to be mid-run when the abort fires; the
        // commit session sleeps 800ms so the abort lands mid-commit too.
        CP_DELAY_MS_FOR_n2: '5000',
        CP_COMMIT_DELAYS: JSON.stringify([800]),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.shimPath],
          signal: controller.signal,
        }),
    )

    // Deterministic trip point: wait until BOTH the commit session and n2
    // have reached their spawn (trace 'start'), i.e. the commit is in flight
    // and the downstream node is running — then cancel.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const tr = readTrace(h.stateDir)
      const commitStarted = tr.some((e) => e.agent === COMMIT_AGENT_NAME && e.phase === 'start')
      const n2Started = tr.some((e) => e.agent === 'n2' && e.phase === 'start')
      if (commitStarted && n2Started) break
      await Bun.sleep(20)
    }
    controller.abort()

    // Drain proof #1: runTask RESOLVES (a leaked/awaited-forever commit
    // synthetic would hang here until the test timeout).
    await runP

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')

    // Drain proof #2: every node_runs row is settled — the canceled exits
    // awaited the commit synthetic before returning, so neither the commit
    // container nor its opencode-session child row is stranded mid-flight
    // past runTask's finally (where the write-lock registry gc runs).
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.status === 'running' || r.status === 'pending')).toEqual([])

    // The commit container settled to a terminal status with its meta
    // persisted (the killed message-gen session degrades to the fallback
    // message — never to an abandoned row).
    const commitRow = rows.find(
      (r) => r.nodeId === commitPushNodeId('n1') && r.commitPushJson !== null,
    )
    expect(commitRow).toBeDefined()
    expect(['done', 'failed']).toContain(commitRow!.status)
  }, 20_000)

  test("source guard: the synthetic key is non-node ('commitpush:<nodeId>:<iter>') and BOTH canceled exits drain before returning", () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf-8',
    )
    // Non-node key: a real node id can never collide with the prefix, so
    // deriveFrontier's in-flight set cannot freeze a scope node on it.
    expect(src).toContain('`commitpush:${nodeId}:${iteration}`')
    // Revision #2: every canceled return inside the dispatch loop drains the
    // synthetics first. Two exits: loop-head aborted check + raced node
    // 'canceled' result.
    const drainCalls = src.match(/await drainCommitPush\(\)/g) ?? []
    expect(drainCalls.length).toBeGreaterThanOrEqual(2)
    // maybeRunCommitPush's per-repo loop bails out once the signal aborted.
    expect(src).toMatch(
      /for \(const repo of state\.repos\) \{[\s\S]{0,400}aborted === true\) return/,
    )
  })
})
