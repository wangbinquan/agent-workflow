import { rimrafDir } from './helpers/cleanup'
// RFC-130 §8.3 D9 (T14) — fan-out shard-rerun directional-undo.
//
// When a fan-out shard is RE-RUN to REPLACE a prior merged attempt, the fresh iso is
// checked out from a canon that still carries the prior delta. `undoPriorShardDeltaInIso`
// removes that prior delta INSIDE the iso BEFORE the agent runs, so the agent writes on
// the clean pre-shard base and its output REPLACES (not superimposes on) the prior.
//
// Key correctness properties (each pinned below + at integration level):
//   - failure-safe (Codex P1 / AC-6): the undo touches only the private iso, never
//     canon — a failed/canceled rerun leaves the prior merged delta intact.
//   - identical re-output survives (Codex P2): because the undo runs BEFORE the agent,
//     a file the agent re-writes with identical bytes reappears as its own write on the
//     clean base (a post-run tree-reverse would have wrongly deleted it).
//   - sibling-safe: unrelated sibling deltas already in the iso survive the undo.
//   - single replacement level (Codex P1): the scheduler only undoes when EXACTLY ONE
//     done+merged candidate exists; with ≥2 merged generations it falls back to
//     superimposition (== pre-T14, never destructive).

import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit, snapshotFullState } from '../src/util/git'
import { undoPriorShardDeltaInIso } from '../src/services/nodeIsolation'

const ulidMono = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// A git worktree standing in for a freshly-created iso (checked out from canon).
async function initIso(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  // Only the committed seed; the caller layers the "delta" files as untracked.
  writeFileSync(join(dir, 'seed.txt'), 'S\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c)
  return dir
}

describe('RFC-130 T14 — undoPriorShardDeltaInIso (iso pre-agent undo, §8.3 D9)', () => {
  test('removes the prior delta from the iso, KEEPING unrelated sibling deltas', async () => {
    // iso == canon-at-dispatch = seed + prior(old.txt) + sibling(sib.txt).
    const iso = await initIso({})
    try {
      const priorBase = await snapshotFullState(iso) // seed only (pre-shard)
      writeFileSync(join(iso, 'old.txt'), 'OLD\n') // prior shard delta
      const priorNode = await snapshotFullState(iso) // seed + old.txt
      writeFileSync(join(iso, 'sib.txt'), 'SIB\n') // an unrelated sibling delta in canon

      const applied = await undoPriorShardDeltaInIso(iso, priorNode, priorBase)

      expect(applied).toBe(true)
      expect(existsSync(join(iso, 'old.txt'))).toBe(false) // prior delta undone
      expect(readFileSync(join(iso, 'sib.txt'), 'utf8')).toBe('SIB\n') // sibling kept
      expect(readFileSync(join(iso, 'seed.txt'), 'utf8')).toBe('S\n') // committed base kept
    } finally {
      rimrafDir(iso)
    }
  })

  test('CONSERVATIVE: reverse conflict → returns false, iso UNCHANGED', async () => {
    const iso = await initIso({})
    try {
      const priorBase = await snapshotFullState(iso)
      writeFileSync(join(iso, 'shared.txt'), 'PRIOR\n') // prior wrote shared.txt
      const priorNode = await snapshotFullState(iso)
      // iso now diverges on the SAME file → undo (delete) vs iso (modify) conflict.
      writeFileSync(join(iso, 'shared.txt'), 'DIVERGED\n')

      const applied = await undoPriorShardDeltaInIso(iso, priorNode, priorBase)

      expect(applied).toBe(false) // fell back
      expect(readFileSync(join(iso, 'shared.txt'), 'utf8')).toBe('DIVERGED\n') // untouched
    } finally {
      rimrafDir(iso)
    }
  })

  test('FAIL-OPEN: pruned prior snapshot (unreachable sha) → returns false, no throw', async () => {
    const iso = await initIso({ 'live.txt': 'L\n' })
    try {
      const bogus = '0000000000000000000000000000000000000000'
      const applied = await undoPriorShardDeltaInIso(iso, bogus, bogus)
      expect(applied).toBe(false)
      expect(readFileSync(join(iso, 'live.txt'), 'utf8')).toBe('L\n')
    } finally {
      rimrafDir(iso)
    }
  })

  test('undefined prior snapshots → returns false (no prior merged attempt)', async () => {
    const iso = await initIso({})
    try {
      expect(await undoPriorShardDeltaInIso(iso, undefined, undefined)).toBe(false)
    } finally {
      rimrafDir(iso)
    }
  })

  test('non-git iso path (passthrough) → returns false', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-plain-'))
    try {
      expect(await undoPriorShardDeltaInIso(plain, 'a', 'b')).toBe(false)
    } finally {
      rimrafDir(plain)
    }
  })

  // Source guard: the scheduler must (a) gate the undo on EXACTLY ONE done+merged
  // candidate (single-level), and (b) apply it to the iso BEFORE the agent runs (a
  // failed rerun must not have touched canon). If a refactor moves the undo to canon
  // or after the run, failure-safety / identical-output correctness silently regress.
  test('source guard: scheduler gates single-level + undoes in the iso pre-run', async () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')
    expect(src).toContain('undoPriorShardDeltaInIso')
    expect(src).toContain('doneMergedCandidates')
    expect(src).toMatch(/doneMergedCandidates\.length === 1/)
    // The shard's runNode dispatch must come AFTER the undo call (pre-agent undo).
    const undoIdx = src.indexOf('undoPriorShardDeltaInIso(')
    const runIdxAfterUndo = src.indexOf('const result = await runNode({', undoIdx)
    expect(undoIdx).toBeGreaterThan(0)
    expect(runIdxAfterUndo).toBeGreaterThan(undoIdx)
  })
})

// ---------------------------------------------------------------------------
// Integration — end-to-end through the real scheduler (the RFC's 专项回归).
// ---------------------------------------------------------------------------

// Shim opencode: always writes a CONSTANT header.txt (identical across values — the
// Codex P2 survival case) + a value-specific f_<value>.txt. If the value contains
// 'FAIL', exits non-zero WITHOUT an envelope (a failed rerun).
function valueFileShim(appHome: string): string {
  const shimPath = join(appHome, 'value-file-shim.ts')
  writeFileSync(
    shimPath,
    `
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// The prompt is \`Process <value>\` (single-line, derived from the shard value).
// On Windows the runner pipes the prompt via stdin instead of argv (Bun.spawn
// truncates argv elements at '\\n' on win32), so argv-based extraction returns
// nothing and the value would silently become 'unknown'. Fall back to stdin.
let promptArg = process.argv.find((a) => a.startsWith('Process ')) ?? ''
if (!promptArg && process.platform === 'win32') {
  try { promptArg = readFileSync(0, 'utf-8') } catch { /* stdin unavailable */ }
}
if (!promptArg) promptArg = 'Process unknown'
const value = (promptArg.split('\\n')[0] ?? '').slice('Process '.length).trim()
const safe = value.replace(/[^a-zA-Z0-9]/g, '_')
if (value.includes('FAIL')) {
  process.stderr.write('simulated shard failure\\n')
  process.exit(1)
}
writeFileSync(join(process.cwd(), 'header.txt'), 'HEADER\\n') // constant across reruns
writeFileSync(join(process.cwd(), 'f_' + safe + '.txt'), value + '\\n')
const envl = '<workflow-output>\\n  <port name="result">' + value + '</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envl } }) + '\\n',
)
process.exit(0)
`,
  )
  return shimPath
}

function fanoutDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<string>', isShardSource: true }],
      },
      { id: 'inner', kind: 'agent-single', agentName: 'worker', promptTemplate: 'Process {{doc}}' },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'inp', portName: 'docs' },
        target: { nodeId: 'fan', portName: 'docs' },
      },
      {
        id: 'eB',
        source: { nodeId: 'fan', portName: 'docs' },
        target: { nodeId: 'inner', portName: 'doc' },
        boundary: 'wrapper-input',
      },
    ],
  } as unknown as WorkflowDefinition
}

async function initCanon(appHome: string): Promise<string> {
  const canon = join(appHome, 'wt')
  mkdirSync(canon, { recursive: true })
  await runGit(canon, ['init', '-q', '-b', 'main'])
  await runGit(canon, ['config', 'user.email', 't@e.com'])
  await runGit(canon, ['config', 'user.name', 'T'])
  writeFileSync(join(canon, 'seed.txt'), 'S\n')
  await runGit(canon, ['add', '.'])
  await runGit(canon, ['commit', '-q', '-m', 'init'])
  return canon
}

// Seed a real-git canon + the DB state a gen-1 run-through-iso would have left for
// shard '0' (value 'alpha'): canon carries header.txt + f_alpha.txt, and a DONE
// shard row with iso_base_snapshot / iso_node_tree / merge_state='merged'.
async function seedGen1(
  db: DbClient,
  canon: string,
): Promise<{ taskId: string; wrapperRunId: string; doneShardId: string }> {
  await db.insert(agents).values({
    id: ulidMono(),
    name: 'worker',
    description: 'test',
    outputs: JSON.stringify(['result']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const isoBaseSnapshot = await snapshotFullState(canon) // pre-shard: seed only
  writeFileSync(join(canon, 'header.txt'), 'HEADER\n') // gen-1 delta (constant file)
  writeFileSync(join(canon, 'f_alpha.txt'), 'alpha\n') // gen-1 delta (value file)
  const isoNodeTree = await snapshotFullState(canon)

  const def = fanoutDef()
  const workflowId = ulidMono()
  const taskId = ulidMono()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't14-e2e',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: canon,
    worktreePath: canon,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ docs: 'PLACEHOLDER' }),
    startedAt: Date.now(),
  })
  const wrapperRunId = ulidMono()
  await db.insert(nodeRuns).values({
    id: wrapperRunId,
    taskId,
    nodeId: 'fan',
    status: 'pending',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    shardKey: null,
    startedAt: Date.now(),
  })
  const doneShardId = ulidMono()
  await db.insert(nodeRuns).values({
    id: doneShardId,
    taskId,
    nodeId: 'inner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: wrapperRunId,
    shardKey: '0',
    shardValueHash: sha256Hex('alpha'),
    isoBaseSnapshot,
    isoNodeTree,
    mergeState: 'merged',
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: doneShardId, portName: 'result', content: 'alpha' })
  return { taskId, wrapperRunId, doneShardId }
}

describe('RFC-130 T14 — end-to-end shard replacement through the scheduler', () => {
  const cleanups: string[] = []
  afterAll(() => {
    for (const d of cleanups) rimrafDir(d)
  })

  test('different-file rerun REPLACES prior delta, and IDENTICAL re-output survives (P2)', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-e2e-'))
    cleanups.push(appHome)
    const canon = await initCanon(appHome)
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedGen1(db, canon)
    await db
      .update(tasks)
      .set({ inputs: JSON.stringify({ docs: 'alpha-NEW' }) })
      .where(eq(tasks.id, taskId))

    const shim = valueFileShim(appHome)
    await runTask({ taskId, db, appHome, opencodeCmd: ['bun', 'run', shim], maxConcurrentNodes: 4 })

    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Replacement: the prior value file is gone; the new one is present.
    expect(existsSync(join(canon, 'f_alpha.txt'))).toBe(false)
    expect(readFileSync(join(canon, 'f_alpha_NEW.txt'), 'utf8')).toBe('alpha-NEW\n')
    // Codex P2: the constant header the rerun RE-PRODUCED with identical bytes SURVIVES.
    expect(readFileSync(join(canon, 'header.txt'), 'utf8')).toBe('HEADER\n')
    expect(readFileSync(join(canon, 'seed.txt'), 'utf8')).toBe('S\n')
  }, 60_000)

  test('FAILURE-SAFETY (P1 / AC-6): a FAILED rerun leaves the prior merged delta INTACT', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-failsafe-'))
    cleanups.push(appHome)
    const canon = await initCanon(appHome)
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedGen1(db, canon)
    await db
      .update(tasks)
      .set({ inputs: JSON.stringify({ docs: 'alpha-FAIL' }) })
      .where(eq(tasks.id, taskId))

    const shim = valueFileShim(appHome)
    await runTask({ taskId, db, appHome, opencodeCmd: ['bun', 'run', shim], maxConcurrentNodes: 4 })

    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).not.toBe('done')
    // Canon was NEVER touched (undo runs only in the iso) — the prior delta survives.
    expect(readFileSync(join(canon, 'f_alpha.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(canon, 'header.txt'), 'utf8')).toBe('HEADER\n')
  }, 60_000)

  test('BRANCH-2 RESUME: resumed replacement of a failed attempt still replaces prior delta', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-branch2-'))
    cleanups.push(appHome)
    const canon = await initCanon(appHome)
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, wrapperRunId } = await seedGen1(db, canon)
    // A prior replacement attempt that FAILED before merge → non-done freshest row.
    await db.insert(nodeRuns).values({
      id: ulidMono(),
      taskId,
      nodeId: 'inner',
      status: 'failed',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: wrapperRunId,
      shardKey: '0',
      shardValueHash: sha256Hex('alpha-NEW'),
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db
      .update(tasks)
      .set({ inputs: JSON.stringify({ docs: 'alpha-NEW' }) })
      .where(eq(tasks.id, taskId))

    const shim = valueFileShim(appHome)
    await runTask({ taskId, db, appHome, opencodeCmd: ['bun', 'run', shim], maxConcurrentNodes: 4 })

    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    expect(existsSync(join(canon, 'f_alpha.txt'))).toBe(false)
    expect(existsSync(join(canon, 'f_alpha_NEW.txt'))).toBe(true)
  }, 60_000)

  test('SINGLE-LEVEL (P1): ≥2 merged generations → fall back to superimposition (no resurrection)', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc130-t14-3gen-'))
    cleanups.push(appHome)
    const canon = await initCanon(appHome)
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, wrapperRunId } = await seedGen1(db, canon)
    // A SECOND already-merged generation (beta) → two done+merged candidates. Its delta
    // (f_beta.txt) is also in canon.
    const gen2Base = await snapshotFullState(canon)
    writeFileSync(join(canon, 'f_beta.txt'), 'beta\n')
    const gen2Node = await snapshotFullState(canon)
    await db.insert(nodeRuns).values({
      id: ulidMono(),
      taskId,
      nodeId: 'inner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: wrapperRunId,
      shardKey: '0',
      shardValueHash: sha256Hex('beta'),
      isoBaseSnapshot: gen2Base,
      isoNodeTree: gen2Node,
      mergeState: 'merged',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db
      .update(tasks)
      .set({ inputs: JSON.stringify({ docs: 'gamma' }) })
      .where(eq(tasks.id, taskId))

    const shim = valueFileShim(appHome)
    await runTask({ taskId, db, appHome, opencodeCmd: ['bun', 'run', shim], maxConcurrentNodes: 4 })

    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')
    // Fall back to superimposition (== pre-T14): the new file is added; prior files
    // remain (NOT resurrected/rewritten). Safe — never destructive.
    expect(existsSync(join(canon, 'f_gamma.txt'))).toBe(true)
    expect(existsSync(join(canon, 'f_beta.txt'))).toBe(true)
  }, 60_000)
})
