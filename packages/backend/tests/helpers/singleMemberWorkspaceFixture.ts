import { withSourceControlTaskPorts } from './sourceControlTaskPorts'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// Real repository-group launch fixture shared by the 9956ce39d checkpoint
// regression and the 2026-10-21 single non-root workspace discriminator fix.
import { agentFixture, workflowFixture } from './model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect } from 'bun:test'
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@agent-workflow/shared'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { createRootTaskLaunchKernel } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { createTaskRouteWorkspaceParticipant } from '@/modules/task-execution/infrastructure/taskRouteWorkspaceParticipant'
import { rememberVolatileRepoUrl } from '@/services/repoCredentials'
import { createRepoGroup } from '@/services/repoGroup'
import { runGit } from '@/util/git'
import type { ProviderHarness } from './eachProvider'
import { createEachProviderTaskExecution } from './eachProviderTaskExecution'
import { remoteUrlFor } from './gitHttpRemote'
import { repoGroupNodesFromAttachments } from './repoGroupFixture'

export async function workspaceGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

export async function singleMemberWorkspaceFixture(
  harness: ProviderHarness,
  options: {
    tmp: string
    appHome: string
    mounts: readonly string[]
    subdir?: string
    directories?: readonly string[]
    cleanup: Array<() => void | Promise<void>>
  },
) {
  const { tmp, appHome, mounts, cleanup } = options
  const db = harness.db
  const userId = ulid(),
    agentId = ulid(),
    workflowId = ulid()
  const { users, cachedRepos } = tablesOf(db)
  await insertOne(db, users, {
    id: userId,
    username: userId,
    displayName: userId,
    gitName: 'iso-regression',
    email: `${userId}@test.local`,
    role: 'admin',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await agentFixture(db, { id: agentId, name: agentId, outputs: '["summary"]' })
  const definition: WorkflowDefinition = {
    $schema_version: WORKFLOW_SCHEMA_VERSION,
    inputs: [],
    nodes: [{ id: 'A', kind: 'agent-single', agentId, agentName: agentId }],
    edges: [],
  }
  await workflowFixture(db, {
    id: workflowId,
    name: workflowId,
    definition: JSON.stringify(definition),
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
  })
  const attachments = []
  for (const [index, mountPath] of mounts.entries()) {
    const repoPath = join(tmp, `src-${index}`)
    mkdirSync(repoPath, { recursive: true })
    await workspaceGit(repoPath, ['init', '-q', '-b', 'main'])
    await workspaceGit(repoPath, ['config', 'user.name', 'iso-regression'])
    await workspaceGit(repoPath, ['config', 'user.email', 'iso@test.local'])
    writeFileSync(join(repoPath, 'base.txt'), 'base\n')
    mkdirSync(join(repoPath, 'src'))
    writeFileSync(join(repoPath, 'src', 'a.ts'), 'export function value() { return 1 }\n')
    await workspaceGit(repoPath, ['add', '.'])
    await workspaceGit(repoPath, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-qm',
      'base',
    ])
    const id = ulid(),
      url = remoteUrlFor(repoPath)
    await insertOne(db, cachedRepos, {
      id,
      urlHash: id,
      urlRedacted: url,
      localPath: repoPath,
      defaultBranch: 'main',
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    rememberVolatileRepoUrl(db, id, url)
    attachments.push({
      kind: 'repo' as const,
      cachedRepoId: id,
      mountPath,
      ref: '',
      subdir: options.subdir ?? '',
      readonly: false,
    })
  }
  const group = await createRepoGroup(
    { store: composeRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db)) },
    {
      name: ulid(),
      description: '',
      nodes: [
        ...repoGroupNodesFromAttachments(attachments),
        ...(options.directories ?? []).map((path) => ({ path, attachment: null })),
      ],
    },
    null,
  )
  const execution = await createEachProviderTaskExecution(harness, { appHome }, userId)
  cleanup.push(() => execution.shutdown())
  const submitted: string[] = []
  const kernel = createRootTaskLaunchKernel({
    db,
    gitCommitIdentity: execution.identityAccess.getUserGitCommitIdentity,
    workspace: createTaskRouteWorkspaceParticipant({
      db,
      appHome,
      sourceContexts: execution.identityAccess.taskPreparationContext,
      repositoryPreparation: composeRepositoryPreparation(
        withSourceControlTaskPorts({ db, appHome }),
      ),
    }),
    coordinator: {
      async submit(request) {
        submitted.push(request.taskId)
        return { kind: 'accepted', taskId: request.taskId }
      },
    },
  })
  const task = await kernel.launch({
    actor: execution.actor,
    resourceAuthority: execution.launchResources,
    invoker: { type: 'user', launchKind: 'direct-json' },
    task: { name: 'iso regression', inputs: {}, repoGroupId: group.id },
    subject: {
      subject: { kind: 'workflow' as const, sourceId: workflowId },
      workflowName: workflowId,
      workflowVersion: 1,
      workflowSnapshot: definition,
      builtin: false,
    },
  })
  expect(submitted).toEqual([task.id])
  expect(task.status).toBe('pending')
  expect(task.repoCount).toBe(mounts.length)
  expect(task.repos.map((repo) => repo.mountPath)).toEqual([...mounts])
  expect(task.repos.map((repo) => repo.worktreeDirName)).toEqual([...mounts])
  return { task, definition, execution }
}
