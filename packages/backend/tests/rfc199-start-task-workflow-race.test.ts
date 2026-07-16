// RFC-199 B3/T6.5 regression locks.
// A workflow can be updated or deleted after startTask's first read but before
// its task-row transaction. The final transaction must fail closed and the
// launch-owned materialization ledger must remove every scratch/worktree
// artifact without deleting shared URL cache mirrors. Conversely, a task-row
// insert that commits first must make the fenced workflow delete report in-use.

import type { StartTask, WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, tasks } from '../src/db/schema'
import { materializingSpaces } from '../src/services/gc'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowDraftSnapshotOf,
  type WorkflowWritePrincipal,
} from '../src/services/workflow'
import {
  materializeSpace,
  materializeWorktree,
  startTask,
  startTaskWithLocalRepo,
  type WorkflowLaunchCommitHookEvent,
} from '../src/services/task'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SYSTEM: WorkflowWritePrincipal = { kind: 'system', reason: 'rfc199-launch-race-test' }
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}

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
  return { tmp, appHome, db: createInMemoryDb(MIGRATIONS), sourcePaths }
}

async function seedWorkflow(db: DbClient, name: string) {
  return createWorkflow(db, { name, description: '', definition: EMPTY_DEFINITION })
}

async function expectWorktreeFullyRemoved(
  event: WorkflowLaunchCommitHookEvent,
  db: DbClient,
): Promise<void> {
  for (const repo of event.repoWorktrees) {
    expect(existsSync(repo.worktreePath)).toBe(false)
    const registered = await runGit(repo.repoPath, ['worktree', 'list', '--porcelain'])
    expect(registered.exitCode).toBe(0)
    expect(registered.stdout).not.toContain(repo.worktreePath)
    const branch = await runGit(repo.repoPath, ['branch', '--list', repo.branch])
    expect(branch.exitCode).toBe(0)
    expect(branch.stdout.trim()).toBe('')
  }

  // URL cache rows/mirrors are shared and intentionally outlive a failed
  // launch. Their task-owned worktree registrations/branches do not.
  const caches = await db.select().from(cachedRepos)
  for (const cache of caches) expect(existsSync(cache.localPath)).toBe(true)
}

describe('RFC-199 startTask workflow delete/version race', () => {
  let harness: Harness | undefined

  afterEach(() => {
    if (harness !== undefined) rmSync(harness.tmp, { recursive: true, force: true })
    harness = undefined
  })

  test('version writer after normal URL materialization returns mismatch and cleans only task-owned worktree', async () => {
    harness = await buildHarness(1)
    const workflow = await seedWorkflow(harness.db, 'normal-version-race')
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTask(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'normal-race',
          repoUrl: pathToFileURL(harness.sourcePaths[0]!).href,
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            expect(existsSync(event.repoWorktrees[0]!.worktreePath)).toBe(true)
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'concurrent v2',
                },
              },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      status: 409,
      details: { expectedVersion: workflow.version, currentVersion: workflow.version + 1 },
    })

    expect(captured).toBeDefined()
    expect(await harness.db.select().from(tasks)).toHaveLength(0)
    expect((await getWorkflow(harness.db, workflow.id))?.version).toBe(workflow.version + 1)
    expect(await harness.db.select().from(cachedRepos)).toHaveLength(1)
    expect(existsSync(harness.sourcePaths[0]!)).toBe(true)
    await expectWorktreeFullyRemoved(captured!, harness.db)
  })

  test('delete-first after scratch materialization returns mismatch and removes scratch repo + lease', async () => {
    harness = await buildHarness(0)
    const workflow = await seedWorkflow(harness.db, 'scratch-delete-race')
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTask(
        {
          workflowId: workflow.id,
          name: 'scratch-race',
          scratch: true,
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            expect(existsSync(event.worktreePath)).toBe(true)
            await deleteWorkflow(
              harness!.db,
              workflow.id,
              { expectedVersion: workflow.version, clientMutationId: ulid() },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      status: 409,
      details: { expectedVersion: workflow.version, currentVersion: null },
    })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.worktreePath)).toBe(false)
    expect(materializingSpaces.has(captured!.taskId)).toBe(false)
    expect(await getWorkflow(harness.db, workflow.id)).toBeNull()
    expect(await harness.db.select().from(tasks)).toHaveLength(0)
  })

  test('delete-first after multi-repo materialization unregisters every worktree and removes container', async () => {
    harness = await buildHarness(2)
    const workflow = await seedWorkflow(harness.db, 'multi-delete-race')
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTask(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'multi-race',
          repos: harness.sourcePaths.map((repoPath) => ({ repoUrl: pathToFileURL(repoPath).href })),
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            expect(event.repoWorktrees).toHaveLength(2)
            for (const repo of event.repoWorktrees) expect(existsSync(repo.worktreePath)).toBe(true)
            await deleteWorkflow(
              harness!.db,
              workflow.id,
              { expectedVersion: workflow.version, clientMutationId: ulid() },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workflow-version-mismatch', status: 409 })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.worktreePath)).toBe(false)
    expect(await harness.db.select().from(tasks)).toHaveLength(0)
    expect(await harness.db.select().from(cachedRepos)).toHaveLength(2)
    for (const sourcePath of harness.sourcePaths) expect(existsSync(sourcePath)).toBe(true)
    await expectWorktreeFullyRemoved(captured!, harness.db)
  })

  test('new user working branch is deleted only when its ref still equals the materialized SHA', async () => {
    harness = await buildHarness(1)
    const workflow = await seedWorkflow(harness.db, 'new-working-branch-race')
    const workingBranch = 'feature/rfc199-new'
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTaskWithLocalRepo(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'new-working-branch',
          repoPath: harness.sourcePaths[0]!,
          baseBranch: 'main',
          workingBranch,
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'force exact mismatch',
                },
              },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workflow-version-mismatch' })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.repoWorktrees[0]!.worktreePath)).toBe(false)
    const branch = await runGit(harness.sourcePaths[0]!, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${workingBranch}`,
    ])
    expect(branch.exitCode).not.toBe(0)
  })

  test('existing user working branch advanced by base merge is CAS-restored to its original ref', async () => {
    harness = await buildHarness(1)
    const source = harness.sourcePaths[0]!
    const workflow = await seedWorkflow(harness.db, 'existing-working-branch-race')
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

    let captured: WorkflowLaunchCommitHookEvent | undefined
    await expect(
      startTaskWithLocalRepo(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'existing-working-branch',
          repoPath: source,
          baseBranch: 'main',
          workingBranch,
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            expect(
              (await runGit(source, ['rev-parse', `refs/heads/${workingBranch}`])).stdout.trim(),
            ).toBe(mainAfter)
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'force exact mismatch',
                },
              },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workflow-version-mismatch' })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.repoWorktrees[0]!.worktreePath)).toBe(false)
    expect((await runGit(source, ['rev-parse', `refs/heads/${workingBranch}`])).stdout.trim()).toBe(
      before,
    )
  })

  test('multi-repo hard failure on a later repo cleans prior worktree, branch, and owned container', async () => {
    harness = await buildHarness(2)
    const blockedBranch = 'feature/rfc199-blocked'
    expect(
      (await runGit(harness.sourcePaths[1]!, ['checkout', '-q', '-b', blockedBranch, 'main']))
        .exitCode,
    ).toBe(0)

    await expect(
      materializeSpace(
        {
          workflowId: 'not-read-by-materialize',
          name: 'multi-partial-hard-failure',
          inputs: {},
          workingBranch: blockedBranch,
          repos: harness.sourcePaths.map((repoPath) => ({ repoPath, baseBranch: 'main' })),
        } as unknown as StartTask,
        { db: harness.db, appHome: harness.appHome },
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
    const multiRoot = join(harness.appHome, 'worktrees', 'multi')
    if (existsSync(multiRoot)) expect(readdirSync(multiRoot)).toHaveLength(0)
    // The second repo's pre-existing checked-out branch was never ours.
    expect(
      (await runGit(harness.sourcePaths[1]!, ['branch', '--show-current'])).stdout.trim(),
    ).toBe(blockedBranch)
  })

  test('fusion-style preCreated owned root is removed when workflow lookup fails before handoff conversion', async () => {
    harness = await buildHarness(0)
    const ownedRoot = join(harness.tmp, 'fusion-ephemeral')
    mkdirSync(ownedRoot, { recursive: true })
    writeFileSync(join(ownedRoot, 'proposal.md'), 'ephemeral\n')

    await expect(
      startTask(
        { workflowId: 'missing-workflow', name: 'fusion-style', inputs: {} },
        {
          db: harness.db,
          appHome: harness.appHome,
          internalSource: { kind: 'local-path', repoPath: ownedRoot, baseBranch: 'fusion' },
          preCreatedWorktree: {
            taskId: ulid(),
            worktreePath: ownedRoot,
            branch: 'fusion',
            baseCommit: null,
            cleanup: { kind: 'owned-root', path: ownedRoot },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workflow-not-found' })
    expect(existsSync(ownedRoot)).toBe(false)
  })

  test('owned-root cleanup failure is structured and never reported as zero residue', async () => {
    harness = await buildHarness(0)
    const ownedRoot = join(harness.tmp, 'fusion-cleanup-failure')
    mkdirSync(ownedRoot, { recursive: true })

    await expect(
      startTask(
        { workflowId: 'missing-workflow', name: 'fusion-style', inputs: {} },
        {
          db: harness.db,
          appHome: harness.appHome,
          internalSource: { kind: 'local-path', repoPath: ownedRoot, baseBranch: 'fusion' },
          preCreatedWorktree: {
            taskId: ulid(),
            worktreePath: ownedRoot,
            branch: 'fusion',
            baseCommit: null,
            cleanup: { kind: 'owned-root', path: ownedRoot },
          },
          workspaceCleanupHook: (event) => {
            if (event.stage === 'owned-root-remove') throw new Error('injected rm failure')
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-not-found',
      details: {
        workspaceCleanup: {
          complete: false,
          failures: [{ stage: 'owned-root-remove', message: 'injected rm failure' }],
        },
      },
    })
    expect(existsSync(ownedRoot)).toBe(true)
  })

  test('worktree-remove cleanup failure is structured and retains registration for recovery', async () => {
    harness = await buildHarness(1)
    const workflow = await seedWorkflow(harness.db, 'cleanup-remove-failure')
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTaskWithLocalRepo(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'remove-failure',
          repoPath: harness.sourcePaths[0]!,
          baseBranch: 'main',
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'force exact mismatch',
                },
              },
              SYSTEM,
            )
          },
          workspaceCleanupHook: (event) => {
            if (event.stage === 'worktree-remove') throw new Error('injected remove failure')
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      details: {
        workspaceCleanup: {
          complete: false,
          failures: [{ stage: 'worktree-remove', message: 'injected remove failure' }],
        },
      },
    })
    expect(captured).toBeDefined()
    expect(existsSync(captured!.repoWorktrees[0]!.worktreePath)).toBe(true)
    expect(
      (await runGit(harness.sourcePaths[0]!, ['worktree', 'list', '--porcelain'])).stdout,
    ).toContain(captured!.repoWorktrees[0]!.worktreePath)
  })

  test('branch-restore cleanup hook failure is structured after worktree unregister', async () => {
    harness = await buildHarness(1)
    const workflow = await seedWorkflow(harness.db, 'cleanup-ref-failure')
    let captured: WorkflowLaunchCommitHookEvent | undefined

    await expect(
      startTaskWithLocalRepo(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'ref-failure',
          repoPath: harness.sourcePaths[0]!,
          baseBranch: 'main',
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'force exact mismatch',
                },
              },
              SYSTEM,
            )
          },
          workspaceCleanupHook: (event) => {
            if (event.stage === 'branch-restore') throw new Error('injected ref failure')
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      details: {
        workspaceCleanup: {
          complete: false,
          failures: [{ stage: 'branch-restore', message: 'injected ref failure' }],
        },
      },
    })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.repoWorktrees[0]!.worktreePath)).toBe(false)
    const branch = await runGit(harness.sourcePaths[0]!, [
      'rev-parse',
      '--verify',
      `refs/heads/${captured!.repoWorktrees[0]!.branch}`,
    ])
    expect(branch.exitCode).toBe(0)
  })

  test('concurrent branch CAS advance is retained and never force-reset', async () => {
    harness = await buildHarness(1)
    const source = harness.sourcePaths[0]!
    const workflow = await seedWorkflow(harness.db, 'cleanup-ref-cas')
    let captured: WorkflowLaunchCommitHookEvent | undefined
    let concurrentCommit = ''

    await expect(
      startTaskWithLocalRepo(
        {
          workflowId: workflow.id,
          expectedWorkflowVersion: workflow.version,
          name: 'ref-cas',
          repoPath: source,
          baseBranch: 'main',
          inputs: {},
        },
        {
          db: harness.db,
          appHome: harness.appHome,
          workflowLaunchCommitHook: async (event) => {
            if (event.stage !== 'materialized-before-task-commit') return
            captured = event
            const branch = event.repoWorktrees[0]!.branch
            const before = (
              await runGit(source, ['rev-parse', `refs/heads/${branch}`])
            ).stdout.trim()
            const tree = (await runGit(source, ['rev-parse', `${before}^{tree}`])).stdout.trim()
            const commit = await runGit(source, [
              'commit-tree',
              tree,
              '-p',
              before,
              '-m',
              'concurrent ref writer',
            ])
            expect(commit.exitCode).toBe(0)
            concurrentCommit = commit.stdout.trim()
            expect(
              (
                await runGit(source, [
                  'update-ref',
                  `refs/heads/${branch}`,
                  concurrentCommit,
                  before,
                ])
              ).exitCode,
            ).toBe(0)
            await updateWorkflow(
              harness!.db,
              workflow.id,
              {
                expectedVersion: workflow.version,
                clientMutationId: ulid(),
                snapshot: {
                  ...workflowDraftSnapshotOf(workflow),
                  description: 'force exact mismatch',
                },
              },
              SYSTEM,
            )
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'workflow-version-mismatch',
      details: {
        workspaceCleanup: {
          complete: false,
          failures: [{ stage: 'branch-restore' }],
        },
      },
    })

    expect(captured).toBeDefined()
    expect(existsSync(captured!.repoWorktrees[0]!.worktreePath)).toBe(false)
    expect(
      (
        await runGit(source, ['rev-parse', `refs/heads/${captured!.repoWorktrees[0]!.branch}`])
      ).stdout.trim(),
    ).toBe(concurrentCommit)
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
    expect(registered.stdout).toContain(residuePath)
    expect((await runGit(source, ['branch', '--list', residueBranch])).stdout.trim()).not.toBe('')
    expect(await harness.db.select().from(tasks)).toHaveLength(0)
  })

  test('task insert first makes concurrent fenced delete report workflow-in-use', async () => {
    harness = await buildHarness(0)
    const workflow = await seedWorkflow(harness.db, 'task-first-race')
    let deleteFailure: unknown
    let committedEvent: WorkflowLaunchCommitHookEvent | undefined

    const task = await startTask(
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
        awaitScheduler: true,
        workflowLaunchCommitHook: async (event) => {
          if (event.stage !== 'task-committed') return
          committedEvent = event
          try {
            await deleteWorkflow(
              harness!.db,
              workflow.id,
              { expectedVersion: workflow.version, clientMutationId: ulid() },
              SYSTEM,
            )
          } catch (error) {
            deleteFailure = error
          }
        },
      },
    )

    expect(committedEvent?.taskId).toBe(task.id)
    expect(deleteFailure).toMatchObject({
      code: 'workflow-in-use',
      status: 409,
      details: { referenceCount: 1 },
    })
    expect(await getWorkflow(harness.db, workflow.id)).not.toBeNull()
    expect(await harness.db.select().from(tasks)).toHaveLength(1)
    expect(existsSync(task.worktreePath)).toBe(true)
  })
})
