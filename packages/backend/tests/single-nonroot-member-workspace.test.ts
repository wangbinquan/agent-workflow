// Standalone defect fix approved 2026-10-21, following 9956ce39d:
// repoCount=1 does not mean the task root is a Git worktree. A lone member
// mounted at svc must use its persisted repository path/key for diff, code
// intelligence, artifacts, rollback, resume and workspace reclamation.
// Remaining sites 1–4: call-child roots, call-chain expansion and file content
// follow the same layout, including the legacy zero-row root fallback.
// The shared real-launch fixture comes from iso-single-nonroot-member-replay.
// Both providers exercise production operations; root and multi-member controls
// also cover root sparse/explicit-directory layouts materialized as groups.

import { readStoredCheckpointFixture } from './helpers/model/checkpoint'
import { decodeTaskRollbackCheckpoints } from '@/modules/task-execution/infrastructure/taskCheckpointCodec'
import { legacyStashSnapshotFixture } from './helpers/legacyStashSnapshot'
import {
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  readTaskFixtures,
  readNodeRunFixtures,
  checkpointValues,
  taskFixture,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { computeSummary, repoKeyWire, type StructuralDiff } from '@agent-workflow/shared'

import { createCodeWorkspaceRead } from '@/modules/code-capability/infrastructure/codeWorkspaceRead'
import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/public/participants'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { selectIsolationWorkspaceFactory } from '@/modules/source-control/public/participants'
import { assertWorktreePresentForResume } from '@/modules/task-execution/application/worktreeResumePreflight'
import { composePortArtifactOperations } from '@/modules/task-execution/composition/portArtifacts'
import { inheritedCallSpace } from '@/modules/task-execution/composition/nodeMechanics'
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
import {
  getCallTargets,
  invalidateCallGraphIndex,
} from '@/services/structuralDiff/callGraph/expandService'
import { getTaskFileContent } from '@/services/worktreeFileContent'
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
    const { taskExecutionIntents } = tablesOf(harness.db)
    await harness.db
      .update(taskExecutionIntents)
      .set({ state: 'completed', completedAt: 1 })
      .where(eq(taskExecutionIntents.taskId, taskId))
    await patchTaskFixture(harness.db, { id: taskId }, { status, finishedAt: 1 })
  }
  function change(task: Awaited<ReturnType<typeof fixture>>['task']) {
    for (const repo of task.repos) {
      writeFileSync(join(repo.worktreePath, 'src/a.ts'), 'export function value() { return 2 }\n')
      writeFileSync(join(repo.worktreePath, 'notes.md'), 'workspace result\n')
    }
  }
  function writeCallChain(worktreePath: string) {
    writeFileSync(
      join(worktreePath, 'src/A.java'),
      'class A {\n  private OrderService svc;\n  void run() {\n    svc.charge();\n  }\n}\n',
    )
    writeFileSync(
      join(worktreePath, 'src/OrderService.java'),
      'class OrderService {\n  void charge() {}\n}\n',
    )
    invalidateCallGraphIndex(worktreePath)
    cleanup.push(() => invalidateCallGraphIndex(worktreePath))
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

  test(
    'zero task_repos rows: legacy file content and call chains keep the task root',
    async () => {
      // Single non-root member, sites 3–4: zero rows still mean a legacy root, not a group.
      const { task, definition } = await fixture(shapes[1])
      const legacyId = ulid()
      await taskFixture(harness.db, {
        id: legacyId,
        workflowId: task.workflowId,
        workflowSnapshot: definition,
        repoPath: task.repoPath,
        worktreePath: task.worktreePath,
        baseBranch: task.baseBranch,
        branch: task.branch,
        baseCommit: task.baseCommit,
        status: 'done',
        inputs: '{}',
        startedAt: 1,
      })
      expect((await readTaskFixtures(harness.db, { id: legacyId }))[0]!.repos).toEqual([])
      change(task)
      const store = composeRepositoryWorkspaceStore(harness.db)
      expect((await store.findWorktreeTask(legacyId))!.repos).toEqual([])
      for (const side of ['base', 'worktree'] as const) {
        for (const repo of [undefined, 'ignored-for-root']) {
          expect(
            await getTaskFileContent(store, legacyId, { path: 'src/a.ts', side, repo }),
          ).toMatchObject({
            exists: true,
            content: `export function value() { return ${side === 'base' ? 1 : 2} }\n`,
          })
        }
        expect(await getTaskFileContent(store, legacyId, { path: 'missing.ts', side })).toEqual({
          exists: false,
        })
      }
      writeCallChain(task.worktreePath)
      const readModel = createTaskExecutionReadModels(harness.db).callGraphWorkspace
      const workspace = (await readModel.find(legacyId))!
      expect(workspace.repos.map((repo) => repo.mountPath)).toEqual([''])
      // The port also allows repos: []; retain the same fallback for such callers.
      for (const reads of [readModel, { find: async () => ({ ...workspace, repos: [] }) }]) {
        const targets = await getCallTargets(reads, legacyId, 'src/A.java#A.run')
        expect(targets).toHaveLength(1)
        expect(targets[0]).toMatchObject({
          label: 'charge()',
          resolution: 'resolved',
          ref: 'src/OrderService.java#OrderService.charge',
        })
      }
      for (const worktreePath of [tmp, join(tmp, 'missing-worktree')]) {
        await expect(
          getCallTargets(
            { find: async () => ({ ...workspace, worktreePath, repos: [] }) },
            legacyId,
            'src/A.java#A.run',
          ),
        ).rejects.toMatchObject({ code: 'task-worktree-missing', status: 410 })
      }
    },
    TIMEOUT,
  )

  test(
    'zero task_repos rows: deferred preparation keeps missing-file and no-base answers',
    async () => {
      // Single non-root member, site 4: deferred preparation must not start requiring repo.
      const { task, definition } = await fixture(shapes[1])
      const deferredId = ulid()
      await taskFixture(harness.db, {
        id: deferredId,
        workflowId: task.workflowId,
        workflowSnapshot: definition,
        repoPath: '',
        worktreePath: '',
        baseBranch: task.baseBranch,
        branch: task.branch,
        baseCommit: null,
        status: 'pending',
        inputs: '{}',
        startedAt: 1,
      })
      const store = composeRepositoryWorkspaceStore(harness.db)
      expect((await store.findWorktreeTask(deferredId))!.repos).toEqual([])
      const path = `not-materialized-${deferredId}.ts`
      expect(await getTaskFileContent(store, deferredId, { path, side: 'worktree' })).toEqual({
        exists: false,
      })
      await expect(
        getTaskFileContent(store, deferredId, { path, side: 'base' }),
      ).rejects.toMatchObject({ code: 'task-no-base-commit', status: 409 })
    },
    TIMEOUT,
  )

  for (const shape of shapes) {
    test(
      `${shape.name}: inherited call space preserves the container and member layout`,
      async () => {
        // Single non-root member, sites 1–2: both call launchers must inherit the iso container.
        const { task } = await fixture(shape)
        const runId = ulid()
        await nodeRunFixture(harness.db, {
          id: runId,
          taskId: task.id,
          nodeId: 'call',
          status: 'running',
        })
        const handle = await createIsoUnderLock({
          binding: { persistence: createTaskExecutionPersistence(harness.db) },
          writeSem: new Semaphore(1),
          appHome,
          taskId: task.id,
          isoKeyRunId: runId,
          canonRepos: task.repos,
        })
        cleanup.push(() => discardNodeIso(handle))
        const childId = ulid()
        const space = inheritedCallSpace({
          parentMounts: task.repos.map((repo) => repo.mountPath),
          parentWorktreePath: task.worktreePath,
          branch: task.branch,
          iso: handle,
          childId,
        })
        expect(space.worktreePath).toBe(handle.containerPath)
        expect(space.kind).toBe(shape.scalar ? 'single' : 'multi')
        expect(space.spaceKind).toBe('inherited')
        expect(space.taskId).toBe(childId)
        expect(space.branch).toBe(task.branch)
        expect(space.baseCommit).toBe(handle.repos[0]!.baseSnapshot)
        expect(space.repos.map((repo) => repo.mountPath)).toEqual([...shape.mounts])
        for (const [index, repo] of space.repos.entries()) {
          expect(repo.worktreePath).toBe(join(space.worktreePath, repo.mountPath))
          expect(repo.worktreePath).toBe(handle.repos[index]!.isoWorktreePath)
          expect(repo.baseCommit).toBe(handle.repos[index]!.baseSnapshot)
        }
        expect(space.cleanup).toEqual({
          taskId: childId,
          ownedRoot: null,
          worktrees: [],
          state: 'owned',
          report: null,
        })
      },
      TIMEOUT,
    )

    for (const side of ['base', 'worktree'] as const) {
      test(
        `${shape.name}: ${side} file content reads the selected member`,
        async () => {
          // Single non-root member, site 4: read the member path and its own baseline.
          const { task } = await fixture(shape)
          change(task)
          const store = composeRepositoryWorkspaceStore(harness.db)
          for (const mount of shape.mounts) {
            const answer = await getTaskFileContent(store, task.id, {
              path: 'src/a.ts',
              side,
              repo: repoKeyWire(mount),
            })
            expect(answer).toMatchObject({
              exists: true,
              content: `export function value() { return ${side === 'base' ? 1 : 2} }\n`,
            })
          }
          if (shape.scalar) {
            expect(
              await getTaskFileContent(store, task.id, { path: 'src/a.ts', side }),
            ).toMatchObject({ exists: true })
          }
        },
        TIMEOUT,
      )

      if (!shape.scalar) {
        test(
          `${shape.name}: ${side} file content requires the repo key`,
          async () => {
            // Single non-root member, site 4: omission must reject just as for multiple members.
            const { task } = await fixture(shape)
            const store = composeRepositoryWorkspaceStore(harness.db)
            for (const repo of [undefined, '']) {
              await expect(
                getTaskFileContent(store, task.id, { path: 'src/a.ts', side, repo }),
              ).rejects.toMatchObject({ code: 'file-content-repo-required', status: 422 })
            }
            await expect(
              getTaskFileContent(store, task.id, { path: 'src/a.ts', side, repo: 'missing' }),
            ).rejects.toMatchObject({ code: 'file-content-repo-not-found', status: 404 })
          },
          TIMEOUT,
        )
      }
    }

    test(
      `${shape.name}: call-chain expansion runs in the member named by the ref`,
      async () => {
        // Single non-root member, site 3: strip the mount before expanding, then restore it.
        const { task } = await fixture(shape)
        for (const repo of task.repos) writeCallChain(repo.worktreePath)
        const readModel = createTaskExecutionReadModels(harness.db).callGraphWorkspace
        for (const mount of shape.mounts) {
          const prefix = shape.scalar ? '' : `${mount}/`
          const targets = await getCallTargets(readModel, task.id, `${prefix}src/A.java#A.run`)
          expect(targets).toHaveLength(1)
          expect(targets[0]).toMatchObject({
            label: 'charge()',
            resolution: 'resolved',
            ref: `${prefix}src/OrderService.java#OrderService.charge`,
            ownerClass: `${prefix}src/OrderService.java::OrderService`,
          })
        }
      },
      TIMEOUT,
    )

    if (!shape.scalar) {
      test(
        `${shape.name}: call-chain expansion requires the mount prefix`,
        async () => {
          // Single non-root member, site 3: an unprefixed ref must not fall through to the container.
          const { task } = await fixture(shape)
          await expect(
            getCallTargets(
              createTaskExecutionReadModels(harness.db).callGraphWorkspace,
              task.id,
              'src/A.java#A.run',
            ),
          ).rejects.toMatchObject({ code: 'call-target-repo-unresolved', status: 404 })
        },
        TIMEOUT,
      )
    }

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
        await nodeRunFixture(harness.db, {
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
        const row = (await readNodeRunFixtures(harness.db, { id: runId }))[0]!
        expect(Object.keys(checkpointValues(row.checkpoints, 'nodeTree')).sort()).toEqual(
          [...shape.mounts].sort(),
        )
        expect(Object.keys(checkpointValues(row.checkpoints, 'isolationBase')).sort()).toEqual(
          [...shape.mounts].sort(),
        )
        expect(checkpointValues(row.checkpoints, 'nodeTree')).toEqual(trees)
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
          await nodeRunFixture(harness.db, {
            id: runId,
            taskId: task.id,
            nodeId: 'A',
            status: 'running',
            startedAt: 1,
            checkpoints: task.repos.map((repo) => ({
              mountPath: repo.mountPath,
              preSnapshot: repo.baseCommit ?? undefined,
            })),
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
        await nodeRunFixture(harness.db, {
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
        await nodeRunFixture(harness.db, {
          id: runId,
          taskId: task.id,
          nodeId: 'A',
          status: 'done',
        })
        await nodeRunOutputFixture(harness.db, {
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
      test(
        `${shape.name}: rollback ${operation} uses member snapshots`,
        async () => {
          const { task } = await fixture(shape)
          const snapshots: Record<string, string> = {}
          for (const repo of task.repos) {
            writeFileSync(
              join(repo.worktreePath, 'src/a.ts'),
              'export function value() { return 10 }\n',
            )
            snapshots[repo.mountPath] = await legacyStashSnapshotFixture(repo.worktreePath)
            expect(snapshots[repo.mountPath]).not.toBe('')
          }
          change(task)
          const runId = ulid()
          await nodeRunFixture(harness.db, {
            id: runId,
            checkpoints: Object.entries(snapshots).map(([mountPath, preSnapshot]) => ({
              mountPath,
              preSnapshot,
            })),
            taskId: task.id,
            nodeId: 'A',
            status: 'failed',
          })
          const stored = await readStoredCheckpointFixture(harness.db, runId)
          const run = decodeTaskRollbackCheckpoints(
            stored,
            task.repos.map((repo) => repo.mountPath),
          )
          const target = (await loadRollbackTarget(harness.db, task.id))!
          if (operation === 'plan') {
            const plan = planNodeRunRollbackTargets(target, run)
            expect(plan.map((r) => [r.worktreePath, r.snapshot])).toEqual(
              task.repos.map((r) => [r.worktreePath, snapshots[r.mountPath]!]),
            )
          } else {
            const result = await rollbackNodeRunWorktrees(target, run, {}, log)
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
          expect(
            (await readTaskFixtures(harness.db, { id: task.id }))[0]!.workspacePrunedAt,
          ).not.toBeNull()
        },
        TIMEOUT,
      )
    }
  }
})
