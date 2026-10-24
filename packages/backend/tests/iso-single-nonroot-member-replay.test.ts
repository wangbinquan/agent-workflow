import { o2Ports } from './helpers/o2Closure'
// RFC-395 II-a A2: replay after the NULL scalar node-tree case now crosses list ports.
// Standalone defect fix approved 2026-10-21: a single non-root group member
// has repoCount=1 but checkpoints are keyed by its mount (e.g. svc), not ''.
// Locks ii0-draft.md §12.1–§12.3, especially the four reproductions in §12.2:
// /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/
// ce31531f-54f7-41d0-a56c-f5201a8706b7/scratchpad/rfc395/ii0-draft.md
// The old count-only writer dropped the node tree, so pending-merge replay
// failed and wrapper/call adoption lost the base and submodule topology.
// Real group fixtures follow rfc248-materialize-group; the crash window and
// discarded iso follow rfc130-crash-replay. Both DB providers run these cases.

import {
  nodeRunFixture,
  nodeRunOutputFixture,
  patchNodeRunFixture,
  readTaskFixtures,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { selectIsolationWorkspaceFactory } from '@/modules/source-control/public/participants'
import { createOrRebuildWrapperIso } from '@/modules/task-execution/composition/wrapperMechanics'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import {
  createIsoUnderLock,
  mergeBackAndSettle,
  persistIsoBase,
  persistIsoNodeTree,
  type IsolatedAgentRunBinding,
} from '@/services/isolatedAgentRun'
import { discardNodeIso, snapshotNodeIsoFinal, type IsoHandle } from '@/services/nodeIsolation'
import { runGit } from '@/util/git'
import { createLogger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { startGitHttpRemote } from './helpers/gitHttpRemote'
import { singleMemberWorkspaceFixture } from './helpers/singleMemberWorkspaceFixture'
import { createProviderTaskExecutionTestTopology } from './helpers/providerTaskExecutionTestTopology'

const TIMEOUT = 60_000
const shapes = [
  { name: 'single non-root member', mounts: ['svc'], scalar: false },
  { name: 'single root member', mounts: [''], scalar: true },
  { name: 'multiple members including root', mounts: ['', 'svc'], scalar: false },
] as const

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function decodeMap(scalar: string | null, perRepo: string | null): Record<string, string> {
  return perRepo === null ? (scalar === null ? {} : { '': scalar }) : JSON.parse(perRepo)
}

describeEachProvider('single non-root member isolation checkpoint regression', (harness) => {
  let tmp: string
  let appHome: string
  const cleanup: Array<() => void | Promise<void>> = []
  const priorAppHome = process.env.AGENT_WORKFLOW_HOME

  beforeAll(async () => {
    await startGitHttpRemote()
  })
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-iso-single-nonroot-'))
    appHome = join(tmp, 'home')
    process.env.AGENT_WORKFLOW_HOME = appHome
  })
  afterEach(async () => {
    try {
      for (const dispose of cleanup.splice(0).reverse()) await dispose()
    } finally {
      if (priorAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = priorAppHome
      removeTempDirSync(tmp)
    }
  })

  async function fixture(mounts: readonly string[]) {
    const db = harness.db
    const { task, definition } = await singleMemberWorkspaceFixture(harness, {
      tmp,
      appHome,
      mounts,
      cleanup,
    })
    const binding: IsolatedAgentRunBinding = {
      persistence: createTaskExecutionPersistence(db, {
        recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
      }),
    }
    const writeSem = new Semaphore(1)
    const state = {
      taskId: task.id,
      task,
      definition,
      repos: task.repos,
      scopeRoot: task.worktreePath,
      opts: {
        appHome,
        persistence: binding.persistence,
        isolationWorkspaces: selectIsolationWorkspaceFactory(),
      },
      log: createLogger('iso-single-nonroot-test'),
      writeSem,
    } as unknown as TaskMechanicsState
    async function isolate() {
      const runId = ulid()
      await nodeRunFixture(db, { id: runId, taskId: task.id, nodeId: 'A', status: 'running' })
      const handle = await createIsoUnderLock({
        binding,
        writeSem,
        appHome,
        taskId: task.id,
        isoKeyRunId: runId,
        canonRepos: task.repos,
      })
      expect(handle.passthrough).toBe(false)
      return { runId, handle }
    }
    async function row(runId: string) {
      const { nodeRuns } = tablesOf(db)
      return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    }
    return { task, binding, writeSem, state, isolate, row }
  }

  test(
    'production launch keeps the one svc member under a non-git group root',
    async () => {
      const { task } = await fixture(['svc'])
      expect(task.repoGroupId).not.toBeNull()
      expect(task.worktreePath).toContain(join('worktrees', 'group'))
      expect(task.repos[0]!.worktreePath).toBe(join(task.worktreePath, 'svc'))
      expect(existsSync(join(task.worktreePath, '.git'))).toBe(false)
      expect((await runGit(task.worktreePath, ['rev-parse', '--show-toplevel'])).exitCode).not.toBe(
        0,
      )
      expect(await git(task.repos[0]!.worktreePath, ['rev-parse', '--is-inside-work-tree'])).toBe(
        'true',
      )
    },
    TIMEOUT,
  )

  for (const shape of shapes) {
    for (const withHandle of [true, false]) {
      test(
        `${shape.name}: base and node tree round-trip (handle=${withHandle})`,
        async () => {
          const f = await fixture(shape.mounts)
          const { runId, handle } = await f.isolate()
          const trees = await snapshotNodeIsoFinal(handle)
          for (const repo of handle.repos) {
            repo.subBases = { vendor: `base-${repo.mountPath}` }
            repo.poolDirs = { vendor: join(tmp, 'pool', repo.mountPath) }
          }
          await persistIsoBase(f.binding, runId, handle)
          await persistIsoNodeTree(f.binding, runId, trees, withHandle ? handle : undefined)
          const row = await f.row(runId)
          expect(decodeMap(row.isoNodeTree, row.isoNodeTreeReposJson)).toEqual(trees)
          expect(decodeMap(row.isoBaseSnapshot, row.isoBaseSnapshotReposJson)).toEqual(
            Object.fromEntries(handle.repos.map((repo) => [repo.mountPath, repo.baseSnapshot])),
          )
          const topology = Object.fromEntries(
            handle.repos.map((repo) => [
              repo.mountPath,
              {
                subBases: repo.subBases,
                poolDirs: repo.poolDirs,
              },
            ]),
          )
          if (shape.scalar) {
            expect(row.isoNodeTree).toBe(trees['']!)
            expect(row.isoNodeTreeReposJson).toBeNull()
            expect(row.isoBaseSnapshotReposJson).toBeNull()
            expect(JSON.parse(row.isoSubmodulesJson!)).toEqual(topology[''])
            expect(row.isoSubmodulesReposJson).toBeNull()
          } else {
            expect(row.isoNodeTree).toBeNull()
            expect(row.isoBaseSnapshot).toBeNull()
            expect(row.isoSubmodulesJson).toBeNull()
            expect(JSON.parse(row.isoSubmodulesReposJson!)).toEqual(topology)
          }
          expect(row.mergeState).toBe('pending-merge')
        },
        TIMEOUT,
      )
    }

    test(
      `${shape.name}: wrapper rebuild retains persisted base and submodule topology`,
      async () => {
        const f = await fixture(shape.mounts)
        const { runId, handle } = await f.isolate()
        for (const repo of handle.repos) {
          repo.subBases = { vendor: `base-${repo.mountPath}` }
          repo.poolDirs = { vendor: join(tmp, 'pool', repo.mountPath) }
        }
        await persistIsoBase(f.binding, runId, handle)
        const rebuilt = await createOrRebuildWrapperIso(
          f.state,
          runId,
          await f.binding.persistence.nodeExecution.read(runId),
        )
        for (const [index, repo] of handle.repos.entries()) {
          expect(rebuilt.repos[index]!.baseSnapshot).toBe(repo.baseSnapshot)
          expect(rebuilt.repos[index]!.isoWorktreePath).toBe(repo.isoWorktreePath)
          expect(rebuilt.repos[index]!.subBases).toEqual(repo.subBases)
          expect(rebuilt.repos[index]!.poolDirs).toEqual(repo.poolDirs)
        }
      },
      TIMEOUT,
    )

    test(
      `${shape.name}: crash after mark-pending-merge replays once and finishes the node`,
      async () => {
        const f = await fixture(shape.mounts)
        const { runId, handle } = await f.isolate()
        await persistIsoBase(f.binding, runId, handle)
        let runtimeCalls = 0
        // Fake runtime: only execution is replaced; isolation, snapshots, column
        // writes, recovery, frontier and task completion use production mechanics.
        const runtime = async (iso: IsoHandle) => {
          runtimeCalls++
          for (const mount of shape.mounts)
            writeFileSync(join(iso.containerPath, mount, 'a.txt'), 'from fake runtime\n')
          await patchNodeRunFixture(
            harness.db,
            { id: runId },
            { status: 'done', finishedAt: Date.now() },
          )
          await nodeRunOutputFixture(harness.db, {
            nodeRunId: runId,
            portName: 'summary',
            content: 'ok',
          })
        }
        await runtime(handle)
        const crash = new Error('injected crash after mark-pending-merge, before merge-back')
        const crashBinding: IsolatedAgentRunBinding = {
          persistence: {
            ...f.binding.persistence,
            mergeStates: {
              ...f.binding.persistence.mergeStates,
              async transition(input) {
                const result = await f.binding.persistence.mergeStates.transition(input)
                if (input.event.kind === 'mark-pending-merge') throw crash
                return result
              },
            },
          },
        }
        await expect(
          mergeBackAndSettle({
            binding: crashBinding,
            writeSem: f.writeSem,
            handle,
            nodeRunId: runId,
            via: 'live',
            conflictResolver: async () => {
              throw new Error('unexpected conflict')
            },
          }),
        ).rejects.toBe(crash)
        expect((await f.row(runId)).mergeState).toBe('pending-merge')
        const pinned = (await f.binding.persistence.nodeExecution.read(runId))!
        expect(pinned.checkpoints.map((checkpoint) => checkpoint.mountPath)).toEqual([
          ...shape.mounts,
        ])
        expect(pinned.checkpoints.every((checkpoint) => checkpoint.nodeTree !== undefined)).toBe(
          true,
        )
        for (const repo of f.task.repos)
          expect(existsSync(join(repo.worktreePath, 'a.txt'))).toBe(false)
        await discardNodeIso(handle)
        // No in-memory tree/handle is supplied to the fresh execution topology.
        const recovery = await createProviderTaskExecutionTestTopology(harness, appHome)
        cleanup.push(() => recovery.dispose())
        await recovery.runTask({
          taskId: f.task.id,
          db: harness.db,
          appHome,
          defaultNodeRetries: 0,
        })
        const { nodeRuns } = tablesOf(harness.db)
        const task = (await readTaskFixtures(harness.db, { id: f.task.id }))[0]!
        expect(task.errorMessage).toBeNull()
        expect(task.status).toBe('done')
        expect((await f.row(runId)).status).toBe('done')
        expect((await f.row(runId)).mergeState).toBe('merged')
        expect(
          await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, f.task.id)),
        ).toHaveLength(1)
        for (const repo of f.task.repos)
          expect(readFileSync(join(repo.worktreePath, 'a.txt'), 'utf8')).toBe('from fake runtime\n')
        expect(runtimeCalls).toBe(1)
      },
      TIMEOUT,
    )

    test(
      `${shape.name}: conflict parking stores pending submodule resolutions under the mount`,
      async () => {
        const f = await fixture(shape.mounts)
        const { runId, handle } = await f.isolate()
        await persistIsoBase(f.binding, runId, handle)
        const repo = handle.repos[0]!
        writeFileSync(join(repo.isoWorktreePath, 'base.txt'), 'node version\n')
        writeFileSync(join(repo.canonWorktreePath, 'base.txt'), 'canonical version\n')
        const result = await mergeBackAndSettle({
          binding: f.binding,
          writeSem: f.writeSem,
          handle,
          nodeRunId: runId,
          via: 'live',
          async conflictResolver() {
            // The resolver reports a remaining submodule conflict. This isolates
            // the persistence contract from Git's submodule merge implementation.
            repo.subBases = { vendor: 'sub-base' }
            repo.poolDirs = { vendor: join(tmp, 'pool') }
            repo.pendingSubResolves = ['vendor']
            return { allResolved: false, detail: 'vendor unresolved' }
          },
        })
        expect(result.kind).toBe('conflict-human')
        const row = await f.row(runId)
        const topology = shape.scalar
          ? { '': JSON.parse(row.isoSubmodulesJson!) }
          : JSON.parse(row.isoSubmodulesReposJson!)
        expect(topology?.[repo.mountPath]).toEqual({
          subBases: { vendor: 'sub-base' },
          poolDirs: { vendor: join(tmp, 'pool') },
          pendingSubResolves: ['vendor'],
        })
        expect(row.mergeState).toBe('conflict-human')
      },
      TIMEOUT,
    )
  }
})
