// LOCKS: RFC-165 T2b — two-phase workspace tombstone + revive gate (design
// §1/§3 F8/R3-1/R3-2/D1/D3/R3-4/F9; tests §11.5).
//
// Cases:
//   G1  scratch prune is two-phase: claim (pruning_at) → rm → finalize
//       (pruned_at); plain recursive rm, no `git worktree remove`.
//   G2  a held claim blocks every revive: setTaskStatus revival → 409
//       workspace-pruning.
//   G3  a finalized tombstone blocks revive with 410 workspace-pruned.
//   G4  revive wins the race: once the task left the terminal set, GC's claim
//       (conditional UPDATE requires terminal) loses and the dir survives.
//   G5  delete failure keeps the claim; re-claim only past PRUNING_LEASE_MS
//       (crashed delete retries, no permanent limbo — R3-1).
//   G6  revive against a missing dir (legacy pre-tombstone GC) heals forward:
//       pruned_at stamped atomically + 410 (R3-2-r4).
//   G7  boot reconcile backfills pruned_at for terminal rows whose dir is
//       gone, leaves live dirs alone.
//   G8  scratch orphan scan: anchored / leased / young dirs survive; only an
//       old row-less dir is reaped (F9).
//   G9  iso GC rides the same per-task claim transiently (D1): deletes then
//       releases the stamp; a pre-existing claim makes it back off; a
//       tombstoned task's iso deletes without ceremony.
//   G10 `space_kind='internal'` (fusion) is never a GC candidate (R3-4).
//   G11 multi-repo onlyMerged requires EVERY task_repos row merged (D3).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskRepos, tasks, workflows } from '../src/db/schema'
import {
  PRUNING_LEASE_MS,
  materializingSpaces,
  reconcileLegacyPrunedWorkspaces,
  runIsoWorktreeGc,
  runScratchOrphanGc,
  runWorktreeGc,
} from '../src/services/gc'
import { setTaskStatus } from '../src/services/lifecycle'
import { runGit } from '../src/util/git'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY_MS = 24 * 60 * 60 * 1000
const GC_ON = { worktreeAutoGc: { enabled: true, olderThanDays: 1 } }

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-gc-'))
  const db = createInMemoryDb(MIGRATIONS)
  return { db, appHome, cleanup: () => rmSync(appHome, { recursive: true, force: true }) }
}

async function seedTask(
  h: Harness,
  overrides: Partial<typeof tasks.$inferInsert>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: join(h.appHome, 'no-such-repo'),
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now() - 20 * DAY_MS,
    finishedAt: Date.now() - 10 * DAY_MS,
    ...overrides,
  })
  return taskId
}

async function taskRow(h: Harness, id: string) {
  return (await h.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
}

/** A plain existing dir the revive gate's FS preflight accepts. */
function mkDir(h: Harness, ...parts: string[]): string {
  const p = join(h.appHome, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

describe('RFC-165 T2b — two-phase workspace tombstone + revive gate', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    materializingSpaces.clear()
    h?.cleanup()
  })

  test('G1 scratch prune: claim → rm → finalize', async () => {
    const dir = mkDir(h, 'scratch-ws')
    writeFileSync(join(dir, 'out.md'), 'x')
    const id = await seedTask(h, { spaceKind: 'scratch', worktreePath: dir, repoPath: dir })

    const r = await runWorktreeGc(h.db, GC_ON)
    expect(r.removed).toEqual([id])
    expect(existsSync(dir)).toBe(false)
    const row = await taskRow(h, id)
    expect(row.workspacePruningAt).not.toBe(null)
    expect(row.workspacePrunedAt).not.toBe(null)
  })

  test('G2 held claim blocks revive with 409 workspace-pruning', async () => {
    const dir = mkDir(h, 'ws-claimed')
    const id = await seedTask(h, { status: 'failed', worktreePath: dir })
    await h.db.update(tasks).set({ workspacePruningAt: Date.now() }).where(eq(tasks.id, id))

    await expect(
      setTaskStatus({
        db: h.db,
        taskId: id,
        to: 'pending',
        allowedFrom: ['failed'],
        allowTerminal: true,
        reason: 'test-revive',
      }),
    ).rejects.toThrow(/workspace is being reclaimed/)
  })

  test('G3 finalized tombstone blocks revive with 410 workspace-pruned', async () => {
    const id = await seedTask(h, { status: 'failed', worktreePath: '' })
    await h.db.update(tasks).set({ workspacePrunedAt: Date.now() }).where(eq(tasks.id, id))

    await expect(
      setTaskStatus({
        db: h.db,
        taskId: id,
        to: 'pending',
        allowedFrom: ['failed'],
        allowTerminal: true,
        reason: 'test-revive',
      }),
    ).rejects.toThrow(/workspace was reclaimed/)
  })

  test('G4 revive first ⇒ GC claim loses and the dir survives', async () => {
    const dir = mkDir(h, 'ws-revive-wins')
    const id = await seedTask(h, { status: 'failed', worktreePath: dir })

    const flip = await setTaskStatus({
      db: h.db,
      taskId: id,
      to: 'pending',
      allowedFrom: ['failed'],
      allowTerminal: true,
      reason: 'test-revive',
    })
    expect(flip.to).toBe('pending')

    const r = await runWorktreeGc(h.db, GC_ON)
    expect(r.removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
    const row = await taskRow(h, id)
    expect(row.workspacePruningAt).toBe(null)
    expect(row.workspacePrunedAt).toBe(null)
  })

  test('G5 delete failure keeps the claim; re-claim only past the lease', async () => {
    // A single-"repo" task whose worktree is a PLAIN dir and whose repoPath
    // does not exist: removeWorktree throws deterministically, so phase 2
    // fails while phase 1 (the claim) sticks.
    const dir = mkDir(h, 'ws-stuck')
    const id = await seedTask(h, { status: 'done', worktreePath: dir, repoCount: 1 })

    const t0 = Date.now()
    const r1 = await runWorktreeGc(h.db, GC_ON, t0)
    expect(r1.removed).toEqual([])
    let row = await taskRow(h, id)
    expect(row.workspacePruningAt).toBe(t0)
    expect(row.workspacePrunedAt).toBe(null)

    // Within the lease: nobody re-claims.
    const t1 = t0 + 60_000
    await runWorktreeGc(h.db, GC_ON, t1)
    row = await taskRow(h, id)
    expect(row.workspacePruningAt).toBe(t0)

    // Past the lease: the stale claim is taken over (crashed delete retries).
    const t2 = t0 + PRUNING_LEASE_MS + 60_000
    await runWorktreeGc(h.db, GC_ON, t2)
    row = await taskRow(h, id)
    expect(row.workspacePruningAt).toBe(t2)
    expect(row.workspacePrunedAt).toBe(null)
  })

  test('G6 revive against a missing dir heals forward: tombstone + 410', async () => {
    const id = await seedTask(h, {
      status: 'failed',
      worktreePath: join(h.appHome, 'vanished'),
    })

    await expect(
      setTaskStatus({
        db: h.db,
        taskId: id,
        to: 'pending',
        allowedFrom: ['failed'],
        allowTerminal: true,
        reason: 'test-revive',
      }),
    ).rejects.toThrow(/no longer exists/)
    const row = await taskRow(h, id)
    expect(row.workspacePrunedAt).not.toBe(null)
  })

  test('G7 boot reconcile backfills tombstones for vanished dirs only', async () => {
    const live = mkDir(h, 'ws-live')
    const liveId = await seedTask(h, { status: 'done', worktreePath: live })
    const goneId = await seedTask(h, {
      status: 'interrupted',
      worktreePath: join(h.appHome, 'ws-gone'),
    })

    const healed = await reconcileLegacyPrunedWorkspaces(h.db)
    expect(healed).toBe(1)
    expect((await taskRow(h, goneId)).workspacePrunedAt).not.toBe(null)
    expect((await taskRow(h, liveId)).workspacePrunedAt).toBe(null)
  })

  test('G8 scratch orphan scan: anchored/leased/young survive, old orphan reaped', async () => {
    const anchoredId = await seedTask(h, { status: 'running' })
    const anchored = mkDir(h, 'scratch', anchoredId)
    const leased = mkDir(h, 'scratch', 'LEASED0000000000000000000')
    materializingSpaces.set('LEASED0000000000000000000', { dir: leased, startedAt: Date.now() })
    const young = mkDir(h, 'scratch', 'YOUNG00000000000000000000')
    const old = mkDir(h, 'scratch', 'OLD0000000000000000000000')
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(old, past, past)

    const r = await runScratchOrphanGc(h.db, h.appHome)
    expect(r.removed).toEqual(['OLD0000000000000000000000'])
    expect(existsSync(anchored)).toBe(true)
    expect(existsSync(leased)).toBe(true)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(old)).toBe(false)
  })

  test('G9 iso GC: transient claim → delete → release; backs off a held claim; tombstoned deletes freely', async () => {
    // (a) plain terminal task: claim taken transiently and released after.
    const idA = await seedTask(h, { status: 'done', worktreePath: '' })
    mkDir(h, 'iso', idA)
    let r = await runIsoWorktreeGc(h.db, h.appHome)
    expect(r.removed).toEqual([idA])
    const rowA = await taskRow(h, idA)
    expect(rowA.workspacePruningAt).toBe(null) // released
    expect(rowA.workspacePrunedAt).toBe(null) // workspace untouched

    // (b) a held claim (workspace GC mid-delete) → back off, container stays.
    const idB = await seedTask(h, { status: 'done', worktreePath: '' })
    const isoB = mkDir(h, 'iso', idB)
    await h.db.update(tasks).set({ workspacePruningAt: Date.now() }).where(eq(tasks.id, idB))
    r = await runIsoWorktreeGc(h.db, h.appHome)
    expect(r.removed).toEqual([])
    expect(existsSync(isoB)).toBe(true)

    // (c) tombstoned workspace → no revival possible → delete without claim.
    rmSync(isoB, { recursive: true, force: true })
    const idC = await seedTask(h, { status: 'failed', worktreePath: '' })
    const isoC = mkDir(h, 'iso', idC)
    await h.db.update(tasks).set({ workspacePrunedAt: Date.now() }).where(eq(tasks.id, idC))
    r = await runIsoWorktreeGc(h.db, h.appHome)
    expect(r.removed).toEqual([idC])
    expect(existsSync(isoC)).toBe(false)
  })

  test('G10 internal (fusion) workspaces are never candidates', async () => {
    const dir = mkDir(h, 'fusion-ws')
    await seedTask(h, { status: 'done', spaceKind: 'internal', worktreePath: dir })

    const r = await runWorktreeGc(h.db, GC_ON)
    expect(r.scanned).toBe(0)
    expect(r.removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  test('G11 multi-repo onlyMerged requires EVERY task_repos row merged', async () => {
    // repo0: branch == base (trivially merged). repo1: feat commit NOT on main.
    const repo0 = join(h.appHome, 'r0')
    await runGit(h.appHome, ['init', '-q', '-b', 'main', 'r0'])
    await runGit(repo0, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init',
    ])
    const repo1 = join(h.appHome, 'r1')
    await runGit(h.appHome, ['init', '-q', '-b', 'main', 'r1'])
    await runGit(repo1, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init',
    ])
    await runGit(repo1, ['checkout', '-q', '-b', 'feat'])
    await runGit(repo1, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'ahead',
    ])
    await runGit(repo1, ['checkout', '-q', 'main'])

    const container = mkDir(h, 'multi-ct')
    const id = await seedTask(h, { status: 'done', worktreePath: container, repoCount: 2 })
    await h.db.insert(taskRepos).values([
      {
        taskId: id,
        repoIndex: 0,
        repoPath: repo0,
        baseBranch: 'main',
        branch: 'main',
        worktreePath: repo0,
        worktreeDirName: 'r0',
        schemaVersion: 1,
      },
      {
        taskId: id,
        repoIndex: 1,
        repoPath: repo1,
        baseBranch: 'main',
        branch: 'feat',
        worktreePath: repo1,
        worktreeDirName: 'r1',
        schemaVersion: 1,
      },
    ])

    const r = await runWorktreeGc(h.db, {
      worktreeAutoGc: { enabled: true, olderThanDays: 1, onlyMerged: true },
    })
    // repo1's feat is unmerged → the WHOLE task is skipped; nothing deleted.
    expect(r.removed).toEqual([])
    expect(existsSync(container)).toBe(true)
    const row = await taskRow(h, id)
    expect(row.workspacePruningAt).toBe(null)
  })
})
