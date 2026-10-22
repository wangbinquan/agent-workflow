// Standalone defect fix approved 2026-10-21, following 9956ce39d:
// repoCount=1 does not mean the task root is a Git worktree. A lone member
// mounted at svc must use its persisted repository path/key for diff, code
// intelligence, artifacts, rollback, resume and workspace reclamation.
// The shared real-launch fixture comes from iso-single-nonroot-member-replay.
// Both providers exercise production operations; root and multi-member controls
// also cover root sparse/explicit-directory layouts materialized as groups.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { computeSummary, type StructuralDiff } from '@agent-workflow/shared'
import { gitStashSnapshot } from '@/util/git'
import { createCodeWorkspaceRead } from '@/modules/code-capability/infrastructure/codeWorkspaceRead'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/public/participants'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { selectIsolationWorkspaceFactory } from '@/modules/source-control/public/participants'
import { assertWorktreePresentForResume } from '@/modules/task-execution/application/worktreeResumePreflight'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createOrRebuildWrapperIso } from '@/modules/task-execution/composition/wrapperMechanics'
import { prepareResumeTaskProjection } from '@/modules/task-execution/infrastructure/childTaskLifecycleParticipant'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import { taskDiffProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import { buildNarrativeInput } from '@/services/changeNarrative'
import { getCodeIntel } from '@/services/codeIntel/codeIntel'
import { getTaskFileSymbols } from '@/services/codeIntel/fileSymbols'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { createIsoUnderLock, persistIsoBase, persistIsoNodeTree } from '@/services/isolatedAgentRun'
import { discardNodeIso, snapshotNodeIsoFinal } from '@/services/nodeIsolation'
import {
  loadRollbackTarget,
  planNodeRunRollbackTargets,
  rollbackNodeRunWorktrees,
} from '@/services/nodeRollback'
import { getTaskStructuralDiff } from '@/services/structuralDiff/service'
import { createLogger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import { startGitHttpRemote } from './helpers/gitHttpRemote'
import { singleMemberWorkspaceFixture, workspaceGit } from './helpers/singleMemberWorkspaceFixture'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const TIMEOUT = 60_000
const log = createLogger('single-nonroot-workspace-test')
const shapes = [
  { name: 'single non-root', mounts: ['svc'], scalar: false },
  { name: 'single root', mounts: [''], scalar: true },
  { name: 'multiple members', mounts: ['api', 'svc'], scalar: false },
  { name: 'root sparse', mounts: [''], subdir: 'src', scalar: true },
  { name: 'root with explicit directory', mounts: [''], directories: ['empty'], scalar: true },
] as const

describeEachProvider('single non-root member workspace regression', (harness) => {
  let tmp: string
  let appHome: string
  const cleanup: Array<() => void | Promise<void>> = []
  const priorAppHome = process.env.AGENT_WORKFLOW_HOME
  beforeAll(startGitHttpRemote, TIMEOUT)
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-single-nonroot-workspace-'))
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
  }, TIMEOUT)

  async function fixture(shape: (typeof shapes)[number]) {
    return singleMemberWorkspaceFixture(harness, { ...shape, tmp, appHome, cleanup })
  }
  async function settle(taskId: string, status: 'done' | 'interrupted') {
    const { taskExecutionIntents, tasks } = tablesOf(harness.db)
    await harness.db
      .update(taskExecutionIntents)
      .set({ state: 'completed', completedAt: 1 })
      .where(eq(taskExecutionIntents.taskId, taskId))
    await harness.db.update(tasks).set({ status, finishedAt: 1 }).where(eq(tasks.id, taskId))
  }
  function change(task: Awaited<ReturnType<typeof fixture>>['task']) {
    for (const repo of task.repos) {
      writeFileSync(join(repo.worktreePath, 'src/a.ts'), 'export function value() { return 2 }\n')
      writeFileSync(join(repo.worktreePath, 'notes.md'), 'workspace result\n')
    }
  }
  function storedDiff(taskId: string): StructuralDiff {
    return {
      taskId,
      scope: 'task',
      fromRef: 'multi',
      toRef: 'WORKTREE',
      engine: 'baseline',
      status: 'ok',
      files: [],
      dependencyChanges: [],
      impact: [],
      classEdges: [],
      summary: computeSummary([], []),
    }
  }

  for (const shape of shapes) {
    test(
      `${shape.name}: materialized root and member paths agree with checkpoint layout`,
      async () => {
        const { task, definition } = await fixture(shape)
        expect(existsSync(join(task.worktreePath, '.git'))).toBe(shape.scalar)
        for (const repo of task.repos) {
          expect(repo.worktreePath).toBe(join(task.worktreePath, repo.mountPath))
          expect(
            await workspaceGit(repo.worktreePath, ['rev-parse', '--is-inside-work-tree']),
          ).toBe('true')
        }
        if ('subdir' in shape || 'directories' in shape)
          expect(task.worktreePath).toContain(join('worktrees', 'group'))
        const binding = { persistence: createTaskExecutionPersistence(harness.db) }
        const runId = ulid()
        const { nodeRuns } = tablesOf(harness.db)
        await insertOne(harness.db, nodeRuns, {
          id: runId,
          taskId: task.id,
          nodeId: 'A',
          status: 'running',
        })
        const writeSem = new Semaphore(1)
        const handle = await createIsoUnderLock({
          binding,
          writeSem,
          appHome,
          taskId: task.id,
          isoKeyRunId: runId,
          canonRepos: task.repos,
        })
        cleanup.push(() => discardNodeIso(handle))
        await persistIsoBase(binding, runId, handle)
        const trees = await snapshotNodeIsoFinal(handle)
        await persistIsoNodeTree(binding, runId, trees, handle)
        const row = (await harness.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
        expect(row.isoNodeTreeReposJson === null).toBe(shape.scalar)
        expect(row.isoBaseSnapshotReposJson === null).toBe(shape.scalar)
        expect(
          shape.scalar ? { '': row.isoNodeTree } : JSON.parse(row.isoNodeTreeReposJson!),
        ).toEqual(trees)
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
          log,
          writeSem,
        } as unknown as TaskMechanicsState
        const rebuilt = await createOrRebuildWrapperIso(state, runId, row)
        expect(rebuilt.repos.map((r) => r.baseSnapshot)).toEqual(
          handle.repos.map((r) => r.baseSnapshot),
        )
      },
      TIMEOUT,
    )

    test(
      `${shape.name}: task diff uses each member baseline and canonical prefix`,
      async () => {
        const { task } = await fixture(shape)
        change(task)
        const diff = await taskDiffProjection({ db: harness.db }, task.id)
        expect(diff.diff).toContain('+export function value() { return 2 }')
        expect(diff.baseCommit).toBe(shape.scalar ? task.baseCommit : null)
        expect(diff.diff.includes('# === Repo:')).toBe(!shape.scalar)
        if (!shape.scalar)
          for (const mount of shape.mounts) expect(diff.diff).toContain(`# === Repo: ${mount} ===`)
      },
      TIMEOUT,
    )

    for (const scope of ['task', 'node'] as const) {
      test(
        `${shape.name}: ${scope} structural diff retains every changed member`,
        async () => {
          const { task } = await fixture(shape)
          const runId = ulid()
          const { nodeRuns } = tablesOf(harness.db)
          await insertOne(harness.db, nodeRuns, {
            id: runId,
            taskId: task.id,
            nodeId: 'A',
            status: 'running',
            startedAt: 1,
            preSnapshot: shape.scalar ? task.baseCommit : null,
            preSnapshotReposJson: shape.scalar
              ? null
              : JSON.stringify(
                  Object.fromEntries(task.repos.map((r) => [r.mountPath, r.baseCommit])),
                ),
          })
          change(task)
          const diff = await getTaskStructuralDiff(
            createCodeWorkspaceRead(harness.db),
            task.id,
            scope,
            runId,
          )
          expect(diff.status).toBe('ok')
          expect(diff.files.map((f) => f.filePath).sort()).toEqual(
            shape.mounts.map((mount) => join(mount, 'src/a.ts')).sort(),
          )
          expect(diff.summary.methods.modified).toBe(shape.mounts.length)
        },
        TIMEOUT,
      )
    }

    test(
      `${shape.name}: wrapper structural scope uses the single-root contract`,
      async () => {
        const { task } = await fixture(shape)
        const runId = ulid()
        const { nodeRuns } = tablesOf(harness.db)
        await insertOne(harness.db, nodeRuns, {
          id: runId,
          taskId: task.id,
          nodeId: 'G',
          status: 'running',
          wrapperProgressJson: JSON.stringify({
            kind: 'git',
            baseline: task.baseCommit,
            phase: 'awaiting',
          }),
        })
        change(task)
        const read = getTaskStructuralDiff(
          createCodeWorkspaceRead(harness.db),
          task.id,
          'wrapper',
          runId,
        )
        if (shape.scalar) expect((await read).files.map((f) => f.filePath)).toEqual(['src/a.ts'])
        else
          await expect(read).rejects.toMatchObject({
            code: 'structural-wrapper-scope-multi-repo-unsupported',
          })
      },
      TIMEOUT,
    )

    test(
      `${shape.name}: narrative enumerates member files even with a stored structural artifact`,
      async () => {
        const { task } = await fixture(shape)
        change(task)
        await settle(task.id, 'done')
        await composeLocalCodeReviewArtifacts().writeStructuralDiff(
          { taskId: task.id, scope: 'task', generation: '1' },
          storedDiff(task.id),
        )
        const narrative = await buildNarrativeInput(createCodeWorkspaceRead(harness.db), task)
        const files = narrative.groups.flatMap((g) => g.files)
        expect(files.filter((f) => f.filePath === 'notes.md')).toHaveLength(shape.mounts.length)
        expect(
          files
            .filter((f) => f.filePath === 'notes.md')
            .map((f) => f.repoLabel ?? '')
            .sort(),
        ).toEqual([...shape.mounts].sort())
      },
      TIMEOUT,
    )

    for (const operation of ['symbols', 'intel'] as const) {
      for (const side of ['base', 'worktree'] as const) {
        test(
          `${shape.name}: ${side} ${operation} resolves the selected member`,
          async () => {
            const { task } = await fixture(shape)
            const reads = createCodeWorkspaceRead(harness.db)
            for (const mount of shape.mounts) {
              const repo = mount === '' ? '.' : mount
              if (operation === 'symbols') {
                const symbols = await getTaskFileSymbols(reads, task.id, {
                  path: 'src/a.ts',
                  side,
                  repo,
                })
                expect(symbols.status).toBe('ok')
                expect(symbols.symbols.map((s) => s.name)).toContain('value')
              } else {
                const answer = await getCodeIntel(reads, task.id, {
                  path: 'src/a.ts',
                  side,
                  repo,
                  name: 'value',
                  line: 1,
                  col: 17,
                  mode: 'baseline',
                })
                expect(answer.definitions).toContainEqual(
                  expect.objectContaining({ repoKey: mount, filePath: 'src/a.ts' }),
                )
                expect(answer.degradedReason === 'multi-repo-baseline-limited').toBe(!shape.scalar)
              }
            }
          },
          TIMEOUT,
        )
      }
    }

    test(
      `${shape.name}: legacy path output is read from the first member`,
      async () => {
        const { task } = await fixture(shape)
        const runId = ulid()
        writeFileSync(join(task.repos[0]!.worktreePath, 'notes.md'), 'artifact\n')
        const { nodeRuns, nodeRunOutputs } = tablesOf(harness.db)
        await insertOne(harness.db, nodeRuns, {
          id: runId,
          taskId: task.id,
          nodeId: 'A',
          status: 'done',
        })
        await insertOne(harness.db, nodeRunOutputs, {
          nodeRunId: runId,
          portName: 'result',
          content: 'notes.md',
          kind: 'path<md>',
        })
        const found = await createTaskExecutionReadModels(harness.db).portArtifacts.find({
          taskId: task.id,
          nodeRunId: runId,
          portName: 'result',
          actor: { userId: 'workspace-reader', canReadAllTasks: true },
        })
        expect(found.status).toBe('found')
        if (found.status !== 'found') throw new Error(found.status)
        const { artifact } = found
        const result = await composePortArtifactOperations(undefined, appHome).read({
          ...artifact,
          fallbackWorkspaceRef: artifact.worktreePath,
          only: 0,
        })
        expect(result.items[0]?.body).toBe('artifact\n')
        expect(result.items[0]?.path).toBe(join(shape.mounts[0]!, 'notes.md'))
      },
      TIMEOUT,
    )

    for (const operation of ['plan', 'execute'] as const) {
      for (const resetOnEmptySnapshot of [false, true]) {
        test(
          `${shape.name}: rollback ${operation} uses member snapshots (retry=${resetOnEmptySnapshot})`,
          async () => {
            const { task } = await fixture(shape)
            const snapshots: Record<string, string> = {}
            for (const repo of task.repos) {
              writeFileSync(
                join(repo.worktreePath, 'src/a.ts'),
                'export function value() { return 10 }\n',
              )
              snapshots[repo.mountPath] = await gitStashSnapshot(repo.worktreePath)
              expect(snapshots[repo.mountPath]).not.toBe('')
            }
            change(task)
            const runId = ulid()
            const run = {
              id: runId,
              preSnapshot: shape.scalar ? snapshots['']! : null,
              preSnapshotReposJson: shape.scalar ? null : JSON.stringify(snapshots),
            }
            const { nodeRuns } = tablesOf(harness.db)
            await insertOne(harness.db, nodeRuns, {
              ...run,
              taskId: task.id,
              nodeId: 'A',
              status: 'failed',
            })
            const target = (await loadRollbackTarget(harness.db, task.id))!
            if (operation === 'plan') {
              const plan = planNodeRunRollbackTargets(target, run, { resetOnEmptySnapshot })
              expect(plan.map((r) => [r.worktreePath, r.snapshot])).toEqual(
                task.repos.map((r) => [r.worktreePath, snapshots[r.mountPath]!]),
              )
            } else {
              const result = await rollbackNodeRunWorktrees(
                target,
                run,
                { resetOnEmptySnapshot },
                log,
              )
              expect(result).toEqual({ attempted: true, failures: [] })
              for (const repo of task.repos) {
                expect(readFileSync(join(repo.worktreePath, 'src/a.ts'), 'utf8')).toContain(
                  'return 10',
                )
                expect(existsSync(join(repo.worktreePath, 'notes.md'))).toBe(false)
              }
            }
          },
          TIMEOUT,
        )
      }
    }
    test(
      `${shape.name}: resume preflight rejects a surviving container with no member`,
      async () => {
        const { task } = await fixture(shape)
        const preflight = () =>
          assertWorktreePresentForResume(
            taskRecoveryOperations(harness.db),
            task,
            'resume',
            existsSync,
          )
        await preflight()
        for (const repo of task.repos) rmSync(repo.worktreePath, { recursive: true, force: true })
        await expect(preflight()).rejects.toMatchObject({
          code: 'task-worktree-missing',
          status: 410,
        })
      },
      TIMEOUT,
    )

    test(
      `${shape.name}: child lifecycle resume admission also checks member presence`,
      async () => {
        const { task } = await fixture(shape)
        await settle(task.id, 'interrupted')
        const dependencies = {
          db: harness.db,
          persistence: createTaskExecutionPersistence(harness.db),
          log,
          workspacePresence: { exists: async (path: string) => existsSync(path) },
          activity: { isActive: () => false, awaitReleasedSettled: async () => {} },
          get runtimeSessionLeases(): never {
            throw new Error('admission must not drive runtime')
          },
          get coordinatorFactory(): never {
            throw new Error('admission must not drive runtime')
          },
        }
        const input = { taskId: task.id, runtime: { runConfig: { appHome } } }
        expect((await prepareResumeTaskProjection(dependencies, input)).taskId).toBe(task.id)
        await settle(task.id, 'interrupted')
        for (const repo of task.repos) rmSync(repo.worktreePath, { recursive: true, force: true })
        await expect(prepareResumeTaskProjection(dependencies, input)).rejects.toMatchObject({
          code: 'task-worktree-missing',
          status: 410,
        })
      },
      TIMEOUT,
    )

    for (const onlyMerged of [false, true]) {
      test(
        `${shape.name}: workspace GC removes member worktrees and refs (onlyMerged=${onlyMerged})`,
        async () => {
          const { task } = await fixture(shape)
          await settle(task.id, 'done')
          const ref = `refs/agent-workflow/snapshots/${task.id}/test`
          for (const repo of task.repos)
            await workspaceGit(repo.repoPath, ['update-ref', ref, repo.baseCommit!])
          const command = composeWorkspaceMaintenanceCommand({
            db: harness.db,
            appHome,
            terminalMaintenance: new DrizzleTerminalMaintenancePersistence(harness.db),
            isMaterializingTask: () => false,
            invalidateWorkspacePath: () => {},
          })
          expect(
            await command.runGcPhase({
              phase: 'worktree',
              activeTaskIds: [],
              worktreeAutoGc: { enabled: true, onlyMerged },
              gitCloneTimeoutMs: 30_000,
            }),
          ).toEqual({ scanned: 1, removed: 1, skipped: 0 })
          expect(existsSync(task.worktreePath)).toBe(false)
          for (const repo of task.repos) {
            expect(
              await workspaceGit(repo.repoPath, ['worktree', 'list', '--porcelain']),
            ).not.toContain(repo.worktreePath)
            expect(
              await workspaceGit(repo.repoPath, ['for-each-ref', '--format=%(refname)', ref]),
            ).toBe('')
          }
          const { tasks } = tablesOf(harness.db)
          expect(
            (await harness.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!
              .workspacePrunedAt,
          ).not.toBeNull()
        },
        TIMEOUT,
      )
    }
  }
})
