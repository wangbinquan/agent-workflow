import {
  type TaskFixtureSpec,
  patchTaskFixture,
  readTaskFixtures,
  taskFixture,
  taskRepoFixture,
  workflowFixture,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createWorkspaceMaintenanceCommand } from '@/modules/source-control/application/workspaceMaintenance'
import { DrizzleWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/workspaceMaintenanceStore'
// RFC-395 II-pre：GC 改接生产 workspaceMaintenance，断言其回执及实际目录 / 行状态。
import {
  workspaceMaintenanceForTest,
  workspaceMaintenanceFilesystemForTest,
} from './helpers/workspaceMaintenance'
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
//   G5  delete failure keeps the claim; re-claim only past WORKSPACE_PRUNING_LEASE_MS
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
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { DrizzleTerminalMaintenancePersistence } from '../src/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { WORKSPACE_PRUNING_LEASE_MS } from '@/modules/source-control/application/workspaceMaintenance'
import { setTaskStatus } from '../src/services/lifecycle'
import { runGit } from '../src/util/git'

const ulid = monotonicFactory()
const DAY_MS = 24 * 60 * 60 * 1000
const GC_ON = { worktreeAutoGc: { enabled: true, olderThanDays: 1 } }

interface Harness {
  db: PersistenceDb
  appHome: string
  cleanup: () => void
}

function buildHarness(provider: ProviderHarness): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-gc-'))
  return {
    db: provider.db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedTask(h: Harness, overrides: Partial<TaskFixtureSpec>): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await workflowFixture(h.db, {
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await taskFixture(h.db, {
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
    // SQLite 的 `rfc328_tasks_lineage_after_insert` 触发器会回填这两列，PostgreSQL 迁移
    // 按设计没有对应物 —— 直插 `tasks` 的夹具两边都显式写，两个引擎的起点才相同。
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    ...overrides,
  })
  return taskId
}

async function taskRow(h: Harness, id: string) {
  return (await readTaskFixtures(h.db, { id }))[0]!
}

/** A plain existing dir the revive gate's FS preflight accepts. */
function mkDir(h: Harness, ...parts: string[]): string {
  const p = join(h.appHome, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

let h: Harness

function seedFixture(harness: ProviderHarness): void {
  h = buildHarness(harness)
}

describeEachProvider('RFC-165 工作区墓碑 + 复活闸（双引擎）', (harness) => {
  beforeEach(() => {
    seedFixture(harness)
  })
  afterEach(() => {
    materializingSpaces.clear()
    h?.cleanup()
  })

  describe('RFC-165 T2b — two-phase workspace tombstone + revive gate', () => {
    test('G1 scratch prune: claim → rm → finalize', async () => {
      const dir = mkDir(h, 'scratch-ws')
      writeFileSync(join(dir, 'out.md'), 'x')
      const id = await seedTask(h, { spaceKind: 'scratch', worktreePath: dir, repoPath: dir })

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...GC_ON,
      })
      expect(r.removed).toBe(1)
      expect(existsSync(dir)).toBe(false)
      const row = await taskRow(h, id)
      expect(row.workspacePruningAt).not.toBe(null)
      expect(row.workspacePruneCause).toBeNull()
      expect(row.workspacePrunedAt).not.toBe(null)
      const { taskExecutionMaintenanceClaims, taskExecutionMaintenanceMembers } = tablesOf(h.db)
      expect(
        await h.db
          .select({
            operation: taskExecutionMaintenanceClaims.operation,
            state: taskExecutionMaintenanceClaims.state,
          })
          .from(taskExecutionMaintenanceClaims),
      ).toEqual([{ operation: 'workspace-gc', state: 'completed' }])
      expect(
        await h.db
          .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
          .from(taskExecutionMaintenanceMembers),
      ).toEqual([{ releasedAt: expect.any(Number) }])
    })

    test('G2 held claim blocks revive with 409 workspace-pruning', async () => {
      const dir = mkDir(h, 'ws-claimed')
      const id = await seedTask(h, { status: 'failed', worktreePath: dir })
      await patchTaskFixture(h.db, { id }, { workspacePruningAt: Date.now() })

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
      await patchTaskFixture(h.db, { id }, { workspacePrunedAt: Date.now() })

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

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...GC_ON,
      })
      expect(r.removed).toBe(0)
      expect(existsSync(dir)).toBe(true)
      const row = await taskRow(h, id)
      expect(row.workspacePruningAt).toBe(null)
      expect(row.workspacePrunedAt).toBe(null)
    })

    test('G4b an active terminal driver defers generic workspace GC', async () => {
      const dir = mkDir(h, 'ws-active-terminal')
      const id = await seedTask(h, {
        status: 'done',
        spaceKind: 'scratch',
        worktreePath: dir,
        repoPath: dir,
      })

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [id],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...GC_ON,
      })
      expect(r.removed).toBe(0)
      expect(existsSync(dir)).toBe(true)
      expect((await taskRow(h, id)).workspacePruningAt).toBeNull()
    })

    test('G4c a task revived after candidate scan still wins the durable pre-delete CAS', async () => {
      // RFC-395 II-pre：在生产候选读取返回后复活，两个 provider 都等待写入提交。
      const dir = mkDir(h, 'ws-revived-after-scan')
      const id = await seedTask(h, {
        status: 'done',
        spaceKind: 'scratch',
        worktreePath: dir,
        repoPath: dir,
      })
      let injected = false
      const store = new DrizzleWorkspaceMaintenanceStore(h.db)
      const scan = store.listGcCandidates.bind(store)
      store.listGcCandidates = async () => {
        const candidates = await scan()
        await patchTaskFixture(h.db, { id }, { status: 'pending' })
        injected = true
        return candidates
      }
      const command = createWorkspaceMaintenanceCommand({
        store,
        terminalMaintenance: new DrizzleTerminalMaintenancePersistence(h.db),
        filesystem: workspaceMaintenanceFilesystemForTest(h.appHome),
      })
      const result = await command.runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        ...GC_ON,
      })

      expect(injected).toBe(true)
      expect(result.removed).toBe(0)
      expect(existsSync(dir)).toBe(true)
      expect(await taskRow(h, id)).toMatchObject({ status: 'pending', workspacePruningAt: null })
    })

    test('G5 delete failure keeps the claim; re-claim only past the lease', async () => {
      // A single-"repo" task whose worktree is a PLAIN dir and whose repoPath
      // does not exist: removeWorktree throws deterministically, so phase 2
      // fails while phase 1 (the claim) sticks.
      const dir = mkDir(h, 'ws-stuck')
      const id = await seedTask(h, { status: 'done', worktreePath: dir })

      const t0 = Date.now()
      const r1 = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: t0,
        ...GC_ON,
      })
      expect(r1.removed).toBe(0)
      let row = await taskRow(h, id)
      expect(row.workspacePruningAt).toBe(t0)
      expect(row.workspacePrunedAt).toBe(null)

      // Within the lease: nobody re-claims.
      const t1 = t0 + 60_000
      await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: t1,
        ...GC_ON,
      })
      row = await taskRow(h, id)
      expect(row.workspacePruningAt).toBe(t0)

      // Past the lease: the stale claim is taken over (crashed delete retries).
      const t2 = t0 + WORKSPACE_PRUNING_LEASE_MS + 60_000
      await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: t2,
        ...GC_ON,
      })
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

      const healed = await (
        await workspaceMaintenanceForTest(h.db).recover({ activeTaskIds: [], webhookClaims: 'all' })
      ).healed
      expect(healed).toBe(1)
      expect((await taskRow(h, goneId)).workspacePrunedAt).not.toBe(null)
      expect((await taskRow(h, liveId)).workspacePrunedAt).toBe(null)
    })

    test('G7b stale claim with a vanished dir is finalized, not stuck (crash between phase 2 and 3)', async () => {
      // Implementation-gate P2: daemon died after rm(dir) but before stamping
      // workspacePrunedAt — the row sits claimed with no directory. The next
      // tick's missing-path branch must finalize it (the old null-only claim
      // predicate left it permanently at "workspace-pruning").
      const id = await seedTask(h, {
        status: 'done',
        worktreePath: join(h.appHome, 'ws-crashed'),
        workspacePruningAt: Date.now() - 60_000, // claimed a minute ago; dir gone
      })

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...GC_ON,
      })
      expect(r.removed).toBe(0)
      const row = await taskRow(h, id)
      expect(row.workspacePrunedAt).not.toBe(null)
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

      const r = await workspaceMaintenanceForTest(h.db, h.appHome).runGcPhase({
        phase: 'scratch',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{ worktreeAutoGc: { enabled: true } },
      })
      expect(r.removed).toBe(1)
      expect(existsSync(anchored)).toBe(true)
      expect(existsSync(leased)).toBe(true)
      expect(existsSync(young)).toBe(true)
      expect(existsSync(old)).toBe(false)
    })

    test('G9 iso GC: transient claim → delete → release; backs off a held claim; tombstoned deletes freely', async () => {
      // (a) plain terminal task: claim taken transiently and released after.
      const idA = await seedTask(h, { status: 'done', worktreePath: '' })
      mkDir(h, 'iso', idA)
      let r = await workspaceMaintenanceForTest(h.db, h.appHome).runGcPhase({
        phase: 'iso',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{ worktreeAutoGc: { enabled: true } },
      })
      expect(r.removed).toBe(1)
      const rowA = await taskRow(h, idA)
      expect(rowA.workspacePruningAt).toBe(null) // released
      expect(rowA.workspacePrunedAt).toBe(null) // workspace untouched

      // (b) a held claim (workspace GC mid-delete) → back off, container stays.
      const idB = await seedTask(h, { status: 'done', worktreePath: '' })
      const isoB = mkDir(h, 'iso', idB)
      await patchTaskFixture(h.db, { id: idB }, { workspacePruningAt: Date.now() })
      r = await workspaceMaintenanceForTest(h.db, h.appHome).runGcPhase({
        phase: 'iso',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{ worktreeAutoGc: { enabled: true } },
      })
      expect(r.removed).toBe(0)
      expect(existsSync(isoB)).toBe(true)

      // (c) tombstoned workspace → no revival possible → delete without claim.
      rmSync(isoB, { recursive: true, force: true })
      const idC = await seedTask(h, { status: 'failed', worktreePath: '' })
      const isoC = mkDir(h, 'iso', idC)
      await patchTaskFixture(h.db, { id: idC }, { workspacePrunedAt: Date.now() })
      r = await workspaceMaintenanceForTest(h.db, h.appHome).runGcPhase({
        phase: 'iso',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{ worktreeAutoGc: { enabled: true } },
      })
      expect(r.removed).toBe(1)
      expect(existsSync(isoC)).toBe(false)
    })

    test('G9b boot resumes the exact workspace maintenance claim after physical deletion', async () => {
      const dir = mkDir(h, 'scratch-crash-window')
      const id = await seedTask(h, {
        status: 'done',
        spaceKind: 'scratch',
        worktreePath: dir,
        repoPath: dir,
      })
      const now = Date.now()
      const { taskExecutionMaintenanceClaims } = tablesOf(h.db)
      await patchTaskFixture(h.db, { id }, { workspacePruningAt: now })
      const terminalMaintenance = new DrizzleTerminalMaintenancePersistence(h.db)
      const members = await terminalMaintenance.snapshotMembers([id])
      let claim = await terminalMaintenance.claim({
        rootTaskId: id,
        operation: 'workspace-gc',
        members,
        cleanupPlanJson: JSON.stringify({ v: 1, kind: 'workspace-prune', taskId: id }),
        now,
      })
      rmSync(dir, { recursive: true, force: true })
      claim = await terminalMaintenance.transition({
        claim,
        to: 'io-complete',
        now: now + 1,
      })

      expect(
        await workspaceMaintenanceForTest(h.db).recover({
          activeTaskIds: [],
          now: now + 2,
          webhookClaims: 'all',
        }),
      ).toEqual({
        completed: 1,
        failed: 0,
        skipped: 0,
        healed: 0,
      })
      expect((await taskRow(h, id)).workspacePrunedAt).toBe(now + 2)
      expect(
        (
          await h.db
            .select({ state: taskExecutionMaintenanceClaims.state })
            .from(taskExecutionMaintenanceClaims)
            .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
        )[0]?.state,
      ).toBe('completed')
    })

    test('G10 internal (fusion) workspaces are never candidates', async () => {
      const dir = mkDir(h, 'fusion-ws')
      await seedTask(h, { status: 'done', spaceKind: 'internal', worktreePath: dir })

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...GC_ON,
      })
      expect(r.scanned).toBe(0)
      expect(r.removed).toBe(0)
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
      const id = await seedTask(h, { status: 'done', worktreePath: container })
      await taskRepoFixture(h.db, [
        {
          taskId: id,
          repoIndex: 0,
          repoPath: repo0,
          baseBranch: 'main',
          branch: 'main',
          worktreePath: repo0,
          mountPath: 'r0',
          schemaVersion: 1,
        },
        {
          taskId: id,
          repoIndex: 1,
          repoPath: repo1,
          baseBranch: 'main',
          branch: 'feat',
          worktreePath: repo1,
          mountPath: 'r1',
          schemaVersion: 1,
        },
      ])

      const r = await workspaceMaintenanceForTest(h.db).runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        gitCloneTimeoutMs: 30 * 60 * 1000,
        now: Date.now(),
        ...{
          worktreeAutoGc: { enabled: true, olderThanDays: 1, onlyMerged: true },
        },
      })
      // repo1's feat is unmerged → the WHOLE task is skipped; nothing deleted.
      expect(r.removed).toBe(0)
      expect(existsSync(container)).toBe(true)
      const row = await taskRow(h, id)
      expect(row.workspacePruningAt).toBe(null)
    })
  })
})
