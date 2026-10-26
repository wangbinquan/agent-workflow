import { deleteWorkflow } from './helpers/resourceCatalogDeletion'
import { withSourceControlTaskPorts } from './helpers/sourceControlTaskPorts'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-395 II-pre：版本 / 删除拒绝改接生产 participant；工作区补偿改接生产 materializer，提交后删除走真实内核。

// RFC-199 B3/T6.5 regression locks.
// A workflow can be updated or deleted while its launch is being prepared. The
// production launch kernel refuses the stale or missing workflow, and the
// materialization ledger must remove every scratch/worktree artifact without
// deleting shared URL cache mirrors. Conversely, a task-row insert that commits
// first must make the fenced workflow delete report in-use.

import { readTaskFixtures } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { StartTask, WorkflowDefinition } from '@agent-workflow/shared'
import { beforeAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startGitHttpRemote, remoteUrlFor } from './helpers/gitHttpRemote'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { removeTempDirSync } from './fixtures/tempDir'
import { repoGroupNodesFromAttachments } from './helpers/repoGroupFixture'

import { materializeSpace } from './helpers/legacyTaskWorkspace'
import {
  materializeWorktree,
  materializeSpaceWithProvider,
  cleanupMaterializedSpace,
  cleanupMaterializedSpaceLease,
  createMaterializedSpaceCleanup,
  type MaterializedSpace,
} from '@/modules/source-control/infrastructure/workspaceMaterializer'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { loadFrozenSpaceLayout } from '@/modules/task-execution/infrastructure/frozenWorkspaceLayout'
import { launchTestTask } from './helpers/productionTaskLaunch'
import { ulid } from 'ulid'
import { createFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import {
  createFileFusionWorkspaceEffects,
  fusionWorkDirectory,
} from '@/modules/source-control/infrastructure/local/fileFusionWorkspaceEffects'
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowDraftSnapshotOf,
  type WorkflowWritePrincipal,
} from '@/services/workflow'

import { createRepoGroup } from '@/services/repoGroup'
import { runGit } from '../src/util/git'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'

interface Harness {
  tmp: string
  appHome: string
  db: DbClient
  sourcePaths: string[]
}

async function buildHarness(sourceCount: number): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc199-launch-race-'))
  const appHome = join(tmp, 'home')
  const sourcesRoot = join(tmp, 'sources')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(sourcesRoot, { recursive: true })
  const sourcePaths: string[] = []
  for (let i = 0; i < sourceCount; i += 1) {
    const repoPath = join(sourcesRoot, `repo-${i}`)
    mkdirSync(repoPath, { recursive: true })
    expect((await runGit(repoPath, ['init', '-q', '-b', 'main'])).exitCode).toBe(0)
    expect((await runGit(repoPath, ['config', 'user.email', 'rfc199@example.test'])).exitCode).toBe(
      0,
    )
    expect((await runGit(repoPath, ['config', 'user.name', 'RFC 199'])).exitCode).toBe(0)
    writeFileSync(join(repoPath, 'README.md'), `# source ${i}\n`)
    expect((await runGit(repoPath, ['add', '.'])).exitCode).toBe(0)
    expect((await runGit(repoPath, ['commit', '-q', '-m', 'init'])).exitCode).toBe(0)
    sourcePaths.push(repoPath)
  }
  return { tmp, appHome, db: createInMemoryDb(), sourcePaths }
}

const SYSTEM: WorkflowWritePrincipal = { kind: 'system', reason: 'rfc199-launch-race-test' }
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}
const seedWorkflow = (db: DbClient, name: string) =>
  createWorkflow(db, { name, description: '', definition: EMPTY_DEFINITION })

function launch(harness: Harness, request: StartTask) {
  return launchTestTask(request, {
    db: harness.db,
    appHome: harness.appHome,
    schedulerDriver: { async drive() {} },
    coordinator: {
      async submit({ taskId }) {
        return { kind: 'accepted', taskId }
      },
    },
  })
}
function prepare(harness: Harness, task: StartTask) {
  return composeRepositoryPreparation(
    withSourceControlTaskPorts({ db: harness.db, appHome: harness.appHome }),
  ).legacy.prepare({
    task,
    taskId: ulid(),
    gitCommitIdentity: null,
    loadFrozenSpaceLayout: (id) => loadFrozenSpaceLayout(harness.db, id),
  })
}
function prepareLocal(harness: Harness, workingBranch?: string) {
  return materializeSpaceWithProvider(
    { workingBranch },
    {
      appHome: harness.appHome,
      repositoryWorkspace: composeSqliteRepositoryWorkspaceStore(
        harness.db,
        composeSourceControlTaskPorts(harness.db),
      ),
      internalSource: { kind: 'local-path', repoPath: harness.sourcePaths[0]!, baseBranch: 'main' },
      loadFrozenSpaceLayout: (id) => loadFrozenSpaceLayout(harness.db, id),
    },
    ulid(),
  )
}
async function expectWorktreeFullyRemoved(space: MaterializedSpace, db: DbClient) {
  for (const repo of space.repos) {
    expect(existsSync(repo.worktreePath)).toBe(false)
    const registered = await runGit(repo.repoPath, ['worktree', 'list', '--porcelain'])
    expect(registered.exitCode).toBe(0)
    expect(registered.stdout).not.toContain(repo.worktreePath.replace(/\\/g, '/'))
    const branch = await runGit(repo.repoPath, ['branch', '--list', repo.branch])
    expect(branch.exitCode).toBe(0)
    expect(branch.stdout.trim()).toBe('')
  }
  const { cachedRepos } = tablesOf(db)
  for (const cache of await db.select().from(cachedRepos))
    expect(existsSync(cache.localPath)).toBe(true)
}

// RFC-254: multi-repo materialize does file:// clones (slow on Windows); default 5s
// timeout kills the in-flight clone. 60s headroom.
setDefaultTimeout(60_000)

beforeAll(async () => {
  await startGitHttpRemote()
})

describe('RFC-199 production materialization cleanup', () => {
  let harness: Harness | undefined

  afterEach(() => {
    if (harness !== undefined) removeTempDirSync(harness.tmp)
    harness = undefined
  })

  test('version writer after URL materialization rejects the stale request; cleanup removes only task-owned worktree', async () => {
    harness = await buildHarness(1)
    const workflow = await seedWorkflow(harness.db, 'normal-version-race')
    const request: StartTask = {
      workflowId: workflow.id,
      expectedWorkflowVersion: workflow.version,
      name: 'normal-race',
      repoUrl: remoteUrlFor(harness.sourcePaths[0]!),
      inputs: {},
    }
    const space = await prepare(harness, request)
    expect(existsSync(space.repos[0]!.worktreePath)).toBe(true)
    await updateWorkflow(
      harness.db,
      workflow.id,
      {
        expectedVersion: workflow.version,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(workflow), description: 'concurrent v2' },
      },
      SYSTEM,
    )
    await expect(launch(harness, request)).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      status: 409,
      details: { expectedVersion: workflow.version, currentVersion: workflow.version + 1 },
    })
    // 生产 participant 在准备前拒绝版本；已由调用方物化的资源仍由其持有的 SC 租约清理。
    // 不把这两条生产合同包装成已不存在的「插入事务二次版本检查」。
    expect(await cleanupMaterializedSpace(space)).toMatchObject({ complete: true, failures: [] })
    const { cachedRepos } = tablesOf(harness.db)
    expect(await readTaskFixtures(harness.db)).toHaveLength(0)
    expect((await getWorkflow(harness.db, workflow.id))?.version).toBe(workflow.version + 1)
    expect(await harness.db.select().from(cachedRepos)).toHaveLength(1)
    expect(existsSync(harness.sourcePaths[0]!)).toBe(true)
    await expectWorktreeFullyRemoved(space, harness.db)
  })

  test('delete-first after scratch materialization rejects the missing workflow and removes scratch repo + lease', async () => {
    harness = await buildHarness(0)
    const workflow = await seedWorkflow(harness.db, 'scratch-delete-race')
    const request: StartTask = {
      workflowId: workflow.id,
      name: 'scratch-race',
      scratch: true,
      inputs: {},
    }
    const space = await prepare(harness, request)
    expect(existsSync(space.worktreePath)).toBe(true)
    expect(materializingSpaces.has(space.taskId)).toBe(true)
    await deleteWorkflow(
      harness.db,
      workflow.id,
      {
        expectedVersion: workflow.version,
        clientMutationId: ulid(),
      },
      SYSTEM,
    )
    // 删除发生在生产资源快照读取前，公开错误是 not-found，而非旧事务钩子的 null-version mismatch。
    await expect(launch(harness, request)).rejects.toMatchObject({
      code: 'workflow-not-found',
      status: 404,
    })
    expect(await cleanupMaterializedSpace(space)).toMatchObject({ complete: true, failures: [] })
    expect(existsSync(space.worktreePath)).toBe(false)
    expect(materializingSpaces.has(space.taskId)).toBe(false)
    expect(await getWorkflow(harness.db, workflow.id)).toBeNull()
    expect(await readTaskFixtures(harness.db)).toHaveLength(0)
  })

  test('delete-first after multi-repo materialization unregisters every worktree and removes container', async () => {
    harness = await buildHarness(2)
    const workflow = await seedWorkflow(harness.db, 'multi-delete-race')
    const store = composeSqliteRepositoryWorkspaceStore(
      harness.db,
      composeSourceControlTaskPorts(harness.db),
    )
    const group = await createRepoGroup(
      { store, cache: { store, appHome: harness.appHome } },
      {
        name: 'rfc199-multi',
        description: '',
        nodes: repoGroupNodesFromAttachments(
          harness.sourcePaths.map((repoPath, i) => ({
            kind: 'repo' as const,
            repoUrl: remoteUrlFor(repoPath),
            ref: '',
            subdir: '',
            mountPath: `r${i}`,
            readonly: false,
          })),
        ),
      },
      null,
    )
    const request: StartTask = {
      workflowId: workflow.id,
      name: 'multi-race',
      repoGroupId: group.id,
      inputs: {},
    }
    const space = await prepare(harness, request)
    expect(space.repos).toHaveLength(2)
    for (const repo of space.repos) expect(existsSync(repo.worktreePath)).toBe(true)
    await deleteWorkflow(
      harness.db,
      workflow.id,
      {
        expectedVersion: workflow.version,
        clientMutationId: ulid(),
      },
      SYSTEM,
    )
    await expect(launch(harness, request)).rejects.toMatchObject({
      code: 'workflow-not-found',
      status: 404,
    })
    expect(await cleanupMaterializedSpace(space)).toMatchObject({ complete: true, failures: [] })
    expect(existsSync(space.worktreePath)).toBe(false)
    const { cachedRepos } = tablesOf(harness.db)
    expect(await readTaskFixtures(harness.db)).toHaveLength(0)
    expect(await harness.db.select().from(cachedRepos)).toHaveLength(2)
    for (const source of harness.sourcePaths) expect(existsSync(source)).toBe(true)
    await expectWorktreeFullyRemoved(space, harness.db)
  })

  test('new user working branch is deleted only when its ref still equals the materialized SHA', async () => {
    harness = await buildHarness(1)
    const workingBranch = 'feature/rfc199-new'
    const space = await prepareLocal(harness, workingBranch)
    const repo = space.repos[0]!
    expect(
      (await runGit(repo.repoPath, ['rev-parse', `refs/heads/${workingBranch}`])).stdout.trim(),
    ).toBe(repo.baseCommit!)
    expect(await cleanupMaterializedSpace(space)).toMatchObject({ complete: true, failures: [] })
    expect(existsSync(repo.worktreePath)).toBe(false)
    expect(
      (
        await runGit(repo.repoPath, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${workingBranch}`,
        ])
      ).exitCode,
    ).not.toBe(0)
  })

  test('existing user working branch advanced by base merge is CAS-restored to its original ref', async () => {
    harness = await buildHarness(1)
    const source = harness.sourcePaths[0]!
    const workingBranch = 'feature/rfc199-existing'
    expect((await runGit(source, ['branch', workingBranch, 'main'])).exitCode).toBe(0)
    const before = (
      await runGit(source, ['rev-parse', `refs/heads/${workingBranch}`])
    ).stdout.trim()
    writeFileSync(join(source, 'base-advanced.txt'), 'base v2\n')
    expect((await runGit(source, ['add', '.'])).exitCode).toBe(0)
    expect((await runGit(source, ['commit', '-q', '-m', 'advance base'])).exitCode).toBe(0)
    const mainAfter = (await runGit(source, ['rev-parse', 'main'])).stdout.trim()
    expect(mainAfter).not.toBe(before)
    const space = await prepareLocal(harness, workingBranch)
    expect((await runGit(source, ['rev-parse', `refs/heads/${workingBranch}`])).stdout.trim()).toBe(
      mainAfter,
    )
    expect(await cleanupMaterializedSpace(space)).toMatchObject({ complete: true, failures: [] })
    expect(existsSync(space.repos[0]!.worktreePath)).toBe(false)
    expect((await runGit(source, ['rev-parse', `refs/heads/${workingBranch}`])).stdout.trim()).toBe(
      before,
    )
  })

  test('fusion-style owned root is removed when production workflow lookup fails', async () => {
    harness = await buildHarness(0)
    const fusionId = ulid(),
      taskId = ulid()
    const ownedRoot = fusionWorkDirectory(harness.appHome, fusionId, 1)
    const effects = createFileFusionWorkspaceEffects({ appHome: harness.appHome })
    let prepared = false
    const operations = createFusionEngineTaskOperations({
      db: harness.db,
      workspaces: {
        ...effects,
        async prepare(request) {
          const result = await effects.prepare(request)
          prepared = true
          expect(existsSync(join(result.worktreePath, 'proposal.md'))).toBe(true)
          return result
        },
      },
      coordinator: {
        async submit() {
          throw new Error('missing workflow must not drive')
        },
      },
      cancellation: {
        async cancel() {
          throw new Error('unexpected cancel')
        },
      },
    })
    await expect(
      operations.launch({
        fusionId,
        taskId,
        iteration: 1,
        workflowId: 'missing-workflow',
        ownerUserId: '__system__',
        name: 'fusion-style',
        inputs: {},
        initiator: 'manual',
        platformInputPaths: [],
        seed: {
          base: [{ path: 'proposal.md', content: new TextEncoder().encode('ephemeral\n') }],
          overlay: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'workflow-not-found' })
    expect(prepared).toBe(true)
    expect(existsSync(ownedRoot)).toBe(false)
    expect(await readTaskFixtures(harness.db)).toHaveLength(0)
  })

  test('owned-root cleanup failure is structured and never reported as zero residue', async () => {
    harness = await buildHarness(0)
    const ownedRoot = join(harness.tmp, 'fusion-cleanup-failure')
    mkdirSync(ownedRoot, { recursive: true })
    const lease = createMaterializedSpaceCleanup(ulid(), ownedRoot)
    const report = await cleanupMaterializedSpaceLease(lease, (event) => {
      if (event.stage === 'owned-root-remove') throw new Error('injected rm failure')
    })
    expect(report).toMatchObject({
      complete: false,
      failures: [{ stage: 'owned-root-remove', message: 'injected rm failure', path: ownedRoot }],
    })
    expect(existsSync(ownedRoot)).toBe(true)
  })

  test('worktree-remove cleanup failure is structured and retains registration for recovery', async () => {
    harness = await buildHarness(1)
    const space = await prepareLocal(harness)
    const repo = space.repos[0]!
    expect(
      await cleanupMaterializedSpace(space, (event) => {
        if (event.stage === 'worktree-remove') throw new Error('injected remove failure')
      }),
    ).toMatchObject({
      complete: false,
      failures: [{ stage: 'worktree-remove', message: 'injected remove failure' }],
    })
    expect(existsSync(repo.worktreePath)).toBe(true)
    expect((await runGit(repo.repoPath, ['worktree', 'list', '--porcelain'])).stdout).toContain(
      repo.worktreePath.replace(/\\/g, '/'),
    )
    expect((await runGit(repo.repoPath, ['branch', '--list', repo.branch])).stdout.trim()).not.toBe(
      '',
    )
  })

  test('branch-restore cleanup hook failure is structured after worktree unregister', async () => {
    harness = await buildHarness(1)
    const space = await prepareLocal(harness)
    const repo = space.repos[0]!
    expect(
      await cleanupMaterializedSpace(space, (event) => {
        if (event.stage === 'branch-restore') throw new Error('injected ref failure')
      }),
    ).toMatchObject({
      complete: false,
      failures: [{ stage: 'branch-restore', message: 'injected ref failure' }],
    })
    expect(existsSync(repo.worktreePath)).toBe(false)
    expect((await runGit(repo.repoPath, ['worktree', 'list', '--porcelain'])).stdout).not.toContain(
      repo.worktreePath.replace(/\\/g, '/'),
    )
    expect(
      (await runGit(repo.repoPath, ['rev-parse', '--verify', `refs/heads/${repo.branch}`]))
        .exitCode,
    ).toBe(0)
  })

  test('concurrent branch CAS advance is retained and never force-reset', async () => {
    harness = await buildHarness(1)
    const space = await prepareLocal(harness)
    const repo = space.repos[0]!
    const before = (
      await runGit(repo.repoPath, ['rev-parse', `refs/heads/${repo.branch}`])
    ).stdout.trim()
    const tree = (await runGit(repo.repoPath, ['rev-parse', `${before}^{tree}`])).stdout.trim()
    const commit = await runGit(repo.repoPath, [
      'commit-tree',
      tree,
      '-p',
      before,
      '-m',
      'concurrent ref writer',
    ])
    expect(commit.exitCode).toBe(0)
    const concurrentCommit = commit.stdout.trim()
    expect(
      (
        await runGit(repo.repoPath, [
          'update-ref',
          `refs/heads/${repo.branch}`,
          concurrentCommit,
          before,
        ])
      ).exitCode,
    ).toBe(0)
    expect(await cleanupMaterializedSpace(space)).toMatchObject({
      complete: false,
      failures: [{ stage: 'branch-restore' }],
    })
    expect(existsSync(repo.worktreePath)).toBe(false)
    expect(
      (await runGit(repo.repoPath, ['rev-parse', `refs/heads/${repo.branch}`])).stdout.trim(),
    ).toBe(concurrentCommit)
  })

  test('task insert first makes concurrent fenced delete report workflow-in-use', async () => {
    harness = await buildHarness(0)
    const workflow = await seedWorkflow(harness.db, 'task-first-race')
    let deleteFailure: unknown
    let committedTaskId: string | undefined
    const task = await launchTestTask(
      {
        workflowId: workflow.id,
        expectedWorkflowVersion: workflow.version,
        name: 'task-first',
        scratch: true,
        inputs: {},
      },
      {
        db: harness.db,
        appHome: harness.appHome,
        schedulerDriver: { async drive() {} },
        coordinator: {
          async submit(request) {
            committedTaskId = request.taskId
            expect((await readTaskFixtures(harness!.db)).map((row) => row.id)).toEqual([
              request.taskId,
            ])
            try {
              await deleteWorkflow(
                harness!.db,
                workflow.id,
                {
                  expectedVersion: workflow.version,
                  clientMutationId: ulid(),
                },
                SYSTEM,
              )
            } catch (error) {
              deleteFailure = error
            }
            return { kind: 'accepted', taskId: request.taskId }
          },
        },
      },
    )
    expect(committedTaskId).toBe(task.id)
    expect(deleteFailure).toMatchObject({
      code: 'workflow-in-use',
      status: 409,
      details: { referenceCount: 1 },
    })
    expect(await getWorkflow(harness.db, workflow.id)).not.toBeNull()
    expect(await readTaskFixtures(harness.db)).toHaveLength(1)
    expect(existsSync(task.worktreePath)).toBe(true)
  })

  test('multi-repo hard failure on a later repo cleans prior worktree, branch, and owned container', async () => {
    harness = await buildHarness(2)
    const blockedBranch = 'feature/rfc199-blocked'
    expect(
      (await runGit(harness.sourcePaths[1]!, ['checkout', '-q', '-b', blockedBranch, 'main']))
        .exitCode,
    ).toBe(0)

    // RFC-248 T32: 入口换成仓库组（`repos[]` 已退役），不变量照旧——第二个成员
    // 物化失败必须把**已经建好的**第一个成员的工作树 / 分支 / 容器目录全回收。
    const group = await createRepoGroup(
      {
        store: composeSqliteRepositoryWorkspaceStore(
          harness.db,
          composeSourceControlTaskPorts(harness.db),
        ),
        cache: {
          store: composeSqliteRepositoryWorkspaceStore(
            harness.db,
            composeSourceControlTaskPorts(harness.db),
          ),
          appHome: harness.appHome,
        },
      },
      {
        name: 'rfc199-partial',
        description: '',
        nodes: repoGroupNodesFromAttachments(
          harness.sourcePaths.map((repoPath, i) => ({
            kind: 'repo' as const,
            repoUrl: remoteUrlFor(repoPath),
            ref: '',
            subdir: '',
            mountPath: `r${i}`,
            readonly: false,
          })),
        ),
      },
      null,
    )

    await expect(
      materializeSpace(
        {
          workflowId: 'not-read-by-materialize',
          name: 'multi-partial-hard-failure',
          inputs: {},
          workingBranch: blockedBranch,
          repoGroupId: group.id,
        } as unknown as StartTask,
        {
          db: harness.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: harness.db, driver: 'real' })
            .schedulerDriver,
          appHome: harness.appHome,
        },
        harness.appHome,
      ),
    ).rejects.toMatchObject({ code: 'working-branch-in-use' })

    const firstBranch = await runGit(harness.sourcePaths[0]!, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${blockedBranch}`,
    ])
    expect(firstBranch.exitCode).not.toBe(0)
    const firstWorktrees = await runGit(harness.sourcePaths[0]!, [
      'worktree',
      'list',
      '--porcelain',
    ])
    expect(firstWorktrees.stdout).not.toContain(harness.appHome)
    const groupRoot = join(harness.appHome, 'worktrees', 'group')
    if (existsSync(groupRoot)) expect(readdirSync(groupRoot)).toHaveLength(0)
    // The second repo's pre-existing checked-out branch was never ours.
    expect(
      (await runGit(harness.sourcePaths[1]!, ['branch', '--show-current'])).stdout.trim(),
    ).toBe(blockedBranch)
  })

  test('post-add cleanup-incomplete remains a structured hard error, never earlyError', async () => {
    harness = await buildHarness(1)
    const source = harness.sourcePaths[0]!
    let residuePath = ''
    let residueBranch = ''

    await expect(
      materializeWorktree({
        repoPath: source,
        baseBranch: 'main',
        taskId: 'post-add-cleanup-incomplete',
        appHome: harness.appHome,
        lifecycleHook: (event) => {
          if (event.stage === 'post-add-before-submodules') {
            residuePath = event.worktreePath
            residueBranch = event.branch
            throw new Error('injected post-add failure')
          }
          if (event.stage === 'post-add-cleanup-worktree-remove') {
            throw new Error('injected post-add remove failure')
          }
        },
      }),
    ).rejects.toMatchObject({
      code: 'worktree-post-add-cleanup-incomplete',
      status: 500,
      message: 'injected post-add failure',
      details: {
        cleanup: {
          worktreeRemoved: false,
          branchRestored: false,
          failures: [{ stage: 'worktree-remove', message: 'injected post-add remove failure' }],
        },
      },
    })

    // The error's exact code/details identify a recoverable linked-worktree
    // residue; materializeWorktree must not turn it into cleanup:null.
    expect(existsSync(residuePath)).toBe(true)
    const registered = await runGit(source, ['worktree', 'list', '--porcelain'])
    // RFC-254: git prints forward-slash worktree paths even on Windows.
    expect(registered.stdout).toContain(residuePath.replace(/\\/g, '/'))
    expect((await runGit(source, ['branch', '--list', residueBranch])).stdout.trim()).not.toBe('')
    expect(await readTaskFixtures(harness.db)).toHaveLength(0)
  })
})
