import { taskBundleInput } from './helpers/daemonTaskExecutionBundle'
import { composeDaemonTaskExecutionModules } from '@/cli/daemonModules/taskExecution'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { workflows, users } from '@/db/schema'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import { admitTransferredWorkspace } from '@/modules/task-execution/infrastructure/transferredWorkspaceAdmission'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
describeEachProvider('RFC-363 transferred workspace admission', (harness) => {
  for (const kind of ['borrowed', 'call', 'fusion'] as const) {
    test(`${kind} hand-off rolls back with Task admission and never removes caller files`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc363-transfer-'))
      roots.push(root)
      writeFileSync(join(root, 'caller.txt'), 'owned by caller')
      const taskId = ulid()
      await expect(
        harness.session.transaction(async (tx) => {
          expect(
            await admitTransferredWorkspace(tx, {
              kind,
              taskId,
              worktreePath: root,
              baseCommit: null,
              ownerRef: ulid(),
            }),
          ).toMatchObject({ kind: 'pre-materialized' })
          expect(await createWorkspacePreparationJournal(tx).forTask(taskId)).toMatchObject({
            state: 'admitted',
            lane: 'pre-materialized',
          })
          throw new Error('rollback task admission')
        }),
      ).rejects.toThrow('rollback task admission')
      expect(await createWorkspacePreparationJournal(harness.db).read(taskId)).toBeNull()
      expect(readFileSync(join(root, 'caller.txt'), 'utf8')).toBe('owned by caller')
    })
  }
  test('the actual selected fusion Task writer atomically accepts the existing KE artifact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc363-fusion-admit-'))
    roots.push(root)
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'fusion')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fusion root',
    )
    writeFileSync(join(root, 'caller.txt'), 'fusion owner')
    const ownerUserId = ulid(),
      workflowId = ulid(),
      taskId = ulid()
    await harness.db.insert(users).values({
      id: ownerUserId,
      username: ownerUserId,
      displayName: 'Fusion',
      gitName: 'Fusion',
      role: 'admin',
      status: 'active',
      email: 'fixture@example.test',
      createdAt: 1,
      updatedAt: 1,
    })
    await harness.db.insert(workflows).values({
      id: workflowId,
      name: workflowId,
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
    })
    const driven: string[] = []
    const schedulerDriver = {
      async drive(input: { taskId: string }) {
        driven.push(input.taskId)
      },
      async cancelChild() {},
      async resumeChild() {},
      isTaskActive() {
        return false
      },
    }
    const baseCommit = git('rev-parse', 'HEAD')
    // RFC-370 §10 V20: the workspace arrives through the selected effects; this
    // fixture hands the existing prepared repository over unchanged.
    const workspaces: FusionWorkspaceEffects = {
      prepare: async () => ({ worktreePath: root, baseCommit }),
      collect: async () => {
        throw new Error('unused')
      },
      release: async () => {},
    }
    const fixture = taskBundleInput(harness, root)
    const operations = composeDaemonTaskExecutionModules({
      ...fixture.input,
      selection: { ...fixture.input.selection, fusionWorkspaces: workspaces },
      testSeams: { schedulerDriver },
    }).fusion
    await operations.launch({
      taskId,
      workflowId,
      name: 'fusion admission',
      inputs: {},
      ownerUserId,
      initiator: 'manual',
      fusionId: ulid(),
      iteration: 1,
      seed: { base: [], overlay: null },
      platformInputPaths: [],
      completionMode: 'await-settle',
    })
    expect(await operations.load(taskId)).not.toBeNull()
    const plan = await createWorkspacePreparationJournal(harness.db).forTask(taskId)
    expect(plan).toMatchObject({ state: 'admitted', lane: 'pre-materialized', operationRef: null })
    expect(JSON.parse(plan!.artifactJson!).artifact).toMatchObject({
      kind: 'fusion',
      worktreePath: root,
      ownerRef: taskId,
    })
    expect(driven).toEqual([taskId])
    expect(existsSync(join(root, 'caller.txt'))).toBe(true)
  }, 60_000)
})
