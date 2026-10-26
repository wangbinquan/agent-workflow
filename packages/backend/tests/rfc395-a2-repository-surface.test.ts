import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-395 II-a A2: repository DTO bytes, RequestedSource and unbound SQL retain epoch-1 behavior on both providers.
import { describe, expect, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  WORKFLOW_SCHEMA_VERSION,
  WorkflowDefinitionSchema,
  isTaskWorkspaceUnbound,
  taskWorkspacePhase,
  type Task,
} from '@agent-workflow/shared'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { projectLaunchedTask } from '@/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import { getTask } from '@/services/task'
import {
  loadTaskProjection,
  taskListSummariesProjection,
} from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { createDatabaseTaskLifecycleWsProjection } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import { createDatabaseTaskListPage } from '@/modules/task-execution/infrastructure/taskListPage'
import {
  mapRows,
  type OperationsSqlRow,
} from '@/modules/task-execution/infrastructure/taskListPage/projection'
import { parseTaskOperationsQuery } from '@/modules/task-execution/infrastructure/taskListPage/filters'
import {
  rootQuery,
  fastDefaultRootQuery,
  fastFilteredRootQuery,
} from '@/modules/task-execution/infrastructure/taskListPage/query'
import { createTaskExecutionCatalogSourceFactory } from '@/modules/task-execution/infrastructure/taskExecutionCatalogSources'
import {
  decodeRequestedSource,
  projectStoredTaskRepositorySurface,
} from '@/modules/task-execution/infrastructure/taskRepositorySurface'
import {
  taskWorkspaceUnboundSql,
  taskWorkspaceRootMatchesSql,
} from '@/modules/task-execution/infrastructure/taskRepositorySql'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/infrastructure/repositoryWorkspaceStore'
import { buildActor } from '@/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import { readStoredTaskRepoFixtures, patchStoredTaskRepoDirectory } from './helpers/model/taskRepo'
import {
  taskFixture,
  workflowFixture,
  readTaskFixtures,
  type TaskFixtureSpec,
} from './helpers/model'

const definition = WorkflowDefinitionSchema.parse({
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [],
  edges: [],
})
const owners = { loadOwnerIdentities: async () => new Map() }
const viewer = { userId: 'viewer', canReadAllTasks: true }

function fixture(id: string, extra: Partial<TaskFixtureSpec> = {}): TaskFixtureSpec {
  return {
    id,
    name: id,
    workflowId: 'repository-workflow',
    workflowSnapshot: definition,
    workflowVersion: 1,
    inputs: {},
    repoPath: '/mirror/repo',
    repoUrl: 'https://example.invalid/repo.git',
    cachedRepoId: 'cache-primary',
    worktreePath: `/workspace/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    baseCommit: 'base',
    status: 'pending',
    startedAt: 10,
    branchStartedAt: 10,
    rootTaskId: id,
    spaceKind: 'remote',
    ...extra,
    ...(extra.repos?.length
      ? (() => {
          const primary = [...extra.repos].sort((a, b) => a.repoIndex - b.repoIndex)[0]!
          // A bound target task's repository mirror comes from ordinal zero.
          return {
            repoPath: primary.repoPath,
            repoUrl: primary.repoUrl,
            cachedRepoId: primary.cachedRepoId,
            branch: primary.branch || `agent-workflow/${id}`,
          }
        })()
      : {}),
  }
}

const mount = (repoIndex: number, mountPath: string, branch = 'agent-workflow/single') => ({
  repoIndex,
  mountPath,
  repoPath: `/mirror/${repoIndex}`,
  repoUrl: `https://example.invalid/${repoIndex}.git`,
  cachedRepoId: `cache-${repoIndex}`,
  baseBranch: 'main',
  branch,
  baseCommit: 'base',
  worktreePath: `/workspace/${mountPath}`,
  readonly: repoIndex > 0,
})
const cases = [
  fixture('single', { repos: [mount(0, '')] }),
  fixture('mismatched', { repos: [mount(0, 'nested/svc')] }),
  fixture('group', {
    repoGroupId: 'group-id',
    repoGroupName: 'Frozen group',
    repos: [mount(1, 'nested/b'), mount(0, 'a')],
  }),
  fixture('internal', {
    spaceKind: 'internal',
    baseBranch: '',
    baseCommit: null,
    repoUrl: null,
    cachedRepoId: null,
    repos: [
      { ...mount(0, '', ''), baseBranch: '', baseCommit: null, repoUrl: null, cachedRepoId: null },
    ],
  }),
  fixture('inherited', { spaceKind: 'inherited', repos: [mount(0, '', 'parent-branch')] }),
  fixture('detached', { baseBranch: '', repos: [{ ...mount(0, '', ''), baseBranch: '' }] }),
  fixture('unborn', {
    baseBranch: '',
    baseCommit: null,
    repos: [{ ...mount(0, '', ''), baseBranch: '', baseCommit: null }],
  }),
  fixture('deferred', {
    repoPath: '',
    worktreePath: '',
    baseBranch: 'requested/tag',
    baseCommit: null,
    repos: [],
  }),
  fixture('materialization-failure', {
    status: 'failed',
    repoPath: '',
    worktreePath: '',
    baseCommit: null,
    errorSummary: 'materialization failed',
    repos: [],
  }),
]

function repositoryFields(value: Task) {
  return {
    repoPath: value.repoPath,
    repoUrl: value.repoUrl,
    cachedRepoId: value.cachedRepoId,
    worktreePath: value.worktreePath,
    baseBranch: value.baseBranch,
    branch: value.branch,
    workingBranch: value.workingBranch,
    baseCommit: value.baseCommit,
    repoCount: value.repoCount,
    repos: value.repos,
    spaceNodes: value.spaceNodes,
    repoGroupId: value.repoGroupId,
    repoGroupName: value.repoGroupName,
  }
}

function oldSurface(
  spec: TaskFixtureSpec,
  storedRepos: readonly (Omit<NonNullable<TaskFixtureSpec['repos']>[number], 'worktreeDirName'> & {
    worktreeDirName: string
  })[],
) {
  const repos = storedRepos.length
    ? [...storedRepos].sort((a, b) => a.repoIndex - b.repoIndex)
    : [{ ...spec, repoIndex: 0, mountPath: '', worktreeDirName: '' }]
  return {
    repoPath: spec.repoPath,
    repoUrl: spec.repoUrl ?? null,
    cachedRepoId: spec.cachedRepoId ?? null,
    worktreePath: spec.worktreePath,
    baseBranch: spec.baseBranch,
    branch: spec.branch,
    workingBranch: spec.workingBranch ?? null,
    baseCommit: spec.baseCommit ?? null,
    repoCount: Math.max(1, spec.repos?.length ?? 0),
    repos: repos.map((repo) => ({
      repoIndex: repo.repoIndex,
      repoPath: repo.repoPath,
      repoUrl: repo.repoUrl ?? null,
      cachedRepoId: repo.cachedRepoId ?? null,
      baseBranch: repo.baseBranch ?? '',
      branch: repo.branch,
      workingBranch: repo.workingBranch ?? null,
      baseCommit: repo.baseCommit ?? null,
      worktreePath: repo.worktreePath,
      worktreeDirName: repo.worktreeDirName,
      mountPath: repo.mountPath ?? '',
      subdir: 'subdir' in repo ? (repo.subdir ?? '') : '',
      readonly: 'readonly' in repo ? (repo.readonly ?? false) : false,
      readonlyDirtyCount: null,
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
    })),
    spaceNodes: (spec.id === 'group'
      ? ['', 'a', 'nested', 'nested/b']
      : spec.id === 'mismatched'
        ? ['', 'svc']
        : ['']
    ).map((path) => ({
      path,
      origins: [],
    })),
    repoGroupId: spec.repoGroupId ?? null,
    repoGroupName: spec.repoGroupName ?? null,
  }
}

describeEachProvider('RFC-395 II-a A2 repository surface', (harness) => {
  for (const spec of cases)
    test(`${spec.id}: both detail mappers retain the old repository bytes`, async () => {
      await workflowFixture(harness.db, {
        id: spec.workflowId,
        name: 'Repository workflow',
        definition,
      })
      await taskFixture(harness.db, spec)
      if (spec.id === 'mismatched') {
        // Replace the fixture's derived mount ancestors along with the mount path.
        const { taskSpaceNodes } = tablesOf(harness.db)
        await harness.db
          .delete(taskSpaceNodes)
          .where(
            and(
              eq(taskSpaceNodes.taskId, spec.id),
              inArray(taskSpaceNodes.nodePath, ['nested', 'nested/svc']),
            ),
          )
        await patchStoredTaskRepoDirectory(harness.db, spec.id, 0, 'svc')
      }
      const storedRepos = await readStoredTaskRepoFixtures(harness.db, spec.id)
      const stored = (await readTaskFixtures(harness.db, { id: spec.id }))[0]!
      expect(stored.repos).toHaveLength(spec.repos!.length)
      for (const actual of [
        await getTask(harness.db, spec.id),
        await loadTaskProjection(harness.db, spec.id),
      ]) {
        expect(actual).not.toBeNull()
        expect(JSON.stringify(repositoryFields(actual!))).toBe(
          JSON.stringify(
            oldSurface(
              spec,
              storedRepos.map((repo) => ({
                ...repo,
                repoIndex: repo.ordinal,
                worktreeDirName: repo.mountPath,
                branch: repo.branch ?? '',
                baseBranch: repo.baseBranch ?? '',
                worktreePath: stored.repos.find((member) => member.mountPath === repo.mountPath)!
                  .worktreePath,
              })),
            ),
          ),
        )
      }
    })

  test('summary, all three raw-SQL page paths, WS and catalog preserve the repository payload', async () => {
    await workflowFixture(harness.db, {
      id: 'repository-workflow',
      name: 'Repository workflow',
      definition,
    })
    await taskFixture(harness.db, cases)
    const summaries = await taskListSummariesProjection(harness.db, {})
    const ws = createDatabaseTaskLifecycleWsProjection(harness.db)
    const page = createDatabaseTaskListPage(harness.db, owners)
    const parsed = parseTaskOperationsQuery(viewer, { view: 'all', limit: '50' })
    for (const query of [rootQuery, fastDefaultRootQuery, fastFilteredRootQuery]) {
      const raw = await rawRows<OperationsSqlRow>(
        harness.db,
        query(harness.db, viewer, parsed, 'public'),
      )
      const items = await mapRows(
        harness.db,
        { owners, failureCodes: async () => new Map() },
        viewer,
        raw,
        'root',
        'public',
      )
      expect(items).toHaveLength(cases.length)
      for (const item of items) {
        // HEAD's list API has no codeRoundId key; the SQL row retains it for subject decoding.
        expect(Object.keys(item).sort()).toEqual(
          [
            'id',
            'name',
            'workflowId',
            'workflowName',
            'repoPath',
            'repoUrl',
            'cachedRepoId',
            'status',
            'startedAt',
            'finishedAt',
            'errorSummary',
            'repoCount',
            'openAlertCount',
            'scheduledTaskId',
            'workgroupId',
            'workgroupName',
            'spaceKind',
            'parentTaskId',
            'invocationDepth',
            'sourceAgentName',
            'sourceAgentId',
            'ownerUserId',
            'owner',
            'childCount',
            'executionClock',
            'listContext',
          ].sort(),
        )
      }
      for (const spec of cases) {
        const expected = {
          repoPath: spec.repoPath,
          repoUrl: spec.repoUrl ?? null,
          cachedRepoId: spec.cachedRepoId ?? null,
          repoCount: Math.max(1, spec.repos!.length),
        }
        expect(items.find((item) => item.id === spec.id)).toMatchObject(expected)
        expect(summaries.find((item) => item.id === spec.id)).toMatchObject(expected)
        const payload = await ws.findCreatedTask(spec.id)
        expect(JSON.stringify(payload)).toBe(
          JSON.stringify({
            id: spec.id,
            name: spec.name,
            workflowId: spec.workflowId,
            workflowName: 'Repository workflow',
            repoPath: expected.repoPath,
            repoUrl: expected.repoUrl,
            cachedRepoId: expected.cachedRepoId,
            status: spec.status,
            startedAt: 10,
            finishedAt: null,
            errorSummary: spec.errorSummary ?? null,
            repoCount: expected.repoCount,
            spaceKind: spec.spaceKind,
            sourceAgentName: null,
          }),
        )
        expect(Object.keys(items.find((item) => item.id === spec.id)!)).not.toContain('repos')
      }
    }
    const actor = buildActor({
      user: {
        id: 'viewer',
        username: 'viewer',
        displayName: 'Viewer',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const listed = await createTaskExecutionCatalogSourceFactory(page)
      .create('workflow')
      .list({ actor, view: 'all', limit: '50' })
    expect(listed.items).toHaveLength(cases.length)
    for (const spec of cases) {
      const item = listed.items.find((entry) => entry.id === spec.id)!
      expect(item.repositoryCount).toBe(Math.max(1, spec.repos!.length))
      expect(item.targetLabel).toBe(spec.repoPath.split('/').at(-1) || 'repo')
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'sourceId',
          'title',
          'subject',
          'targetLabel',
          'status',
          'statusDetail',
          'startedAt',
          'updatedAt',
          'finishedAt',
          'executionClock',
          'ownerUserId',
          'owner',
          'ownerLabel',
          'errorSummary',
          'failureCode',
          'childCount',
          'repositoryCount',
          'scheduledTaskId',
          'openAlertCount',
          'hierarchy',
        ].sort(),
      )
    }
  })

  test('persisted source mirror shapes decode to requestedSource@v1 without reading mount state', async () => {
    await workflowFixture(harness.db, {
      id: 'repository-workflow',
      name: 'Repository workflow',
      definition,
    })
    const shapes: ReadonlyArray<
      readonly [ReturnType<typeof decodeRequestedSource>['kind'], Partial<TaskFixtureSpec>]
    > = [
      ['url', { repoUrl: 'https://example.invalid/source.git' }],
      [
        'cached-repo',
        { cachedRepoId: 'requested-cache', repoUrl: 'https://example.invalid/source.git' },
      ],
      [
        'repo-group',
        {
          repoGroupId: 'requested-group',
          repoGroupName: 'Frozen group',
          cachedRepoId: 'requested-cache',
        },
      ],
      ['scratch', { spaceKind: 'scratch' }],
      ['internal', { spaceKind: 'internal' }],
      ['inherited', { spaceKind: 'inherited', cachedRepoId: 'parent-cache' }],
      ['internal', { spaceKind: 'local' }],
    ]
    for (const [index, [kind, extra]] of shapes.entries()) {
      const spec = fixture(`source-${index}`, {
        repoUrl: null,
        cachedRepoId: null,
        worktreePath: '',
        repoPath: '',
        baseBranch: 'requested-ref',
        ...extra,
        repos: [],
      })
      await taskFixture(harness.db, spec)
      const stored = (await readTaskFixtures(harness.db, { id: spec.id }))[0]!
      expect(decodeRequestedSource(stored)).toEqual({
        codec: 'requestedSource@v1',
        kind,
        repoUrl: spec.repoUrl ?? null,
        cachedRepoId: spec.cachedRepoId ?? null,
        requestedRef: 'requested-ref',
        repoGroupId: spec.repoGroupId ?? null,
        repoGroupName: spec.repoGroupName ?? null,
      })
      expect(stored.repos).toEqual([])
      expect(isTaskWorkspaceUnbound(stored.worktreePath)).toBe(true)
    }
  })

  test('RequestedSource reference counting keeps no-mount requests and excludes conflicting mirrors once mounted', async () => {
    await workflowFixture(harness.db, {
      id: 'repository-workflow',
      name: 'Repository workflow',
      definition,
    })
    await taskFixture(harness.db, [cases[0]!, cases[6]!, cases[7]!])
    const store = composeRepositoryWorkspaceStore(
      harness.db,
      composeSourceControlTaskPorts(harness.db),
    )
    // RFC-395 II-a: only cases[7] has no mounts; cases[0] and cases[6] both reference cache-0.
    expect(await store.cachedRepoReferenceCount('cache-primary')).toBe(1)
    expect(await store.cachedRepoReferenceCount('cache-0')).toBe(2)
    expect(await store.cachedRepoReferenceCounts(['cache-primary', 'cache-0'])).toEqual(
      new Map([
        ['cache-0', 2],
        ['cache-primary', 1],
      ]),
    )
  })

  test('unbound and root CAS SQL use the target NULL sentinel and retain bound roots', async () => {
    for (const root of ['', '/workspace/task', null]) {
      // A typed stand-in for the root column: PostgreSQL cannot infer a bare parameter's type.
      const column = sql`cast(${root} as text)`
      const [row] = await rawRows<{ unbound: number; matches_empty: number }>(
        harness.db,
        sql`
        select case when ${taskWorkspaceUnboundSql(column)} then 1 else 0 end as unbound,
          case when ${taskWorkspaceRootMatchesSql(column, '')} then 1 else 0 end as matches_empty
      `,
      )
      expect(Number(row!.unbound)).toBe(root === null ? 1 : 0)
      expect(Number(row!.matches_empty)).toBe(root === null ? 1 : 0)
    }
  })
})

describe('RFC-395 II-a A2 pure requested source and workspace compatibility', () => {
  for (const [kind, columns] of [
    ['url', { repoUrl: 'https://example.invalid/repo.git' }],
    ['cached-repo', { cachedRepoId: 'cache', repoUrl: 'https://example.invalid/repo.git' }],
    ['repo-group', { cachedRepoId: 'cache', repoGroupId: 'group', repoGroupName: 'Frozen' }],
    ['scratch', { spaceKind: 'scratch' }],
    ['internal', { spaceKind: 'internal' }],
    ['inherited', { spaceKind: 'inherited', cachedRepoId: 'cache' }],
    ['internal', { spaceKind: 'local' }],
  ] as const)
    test(`requestedSource@v1 decodes ${kind} with all frozen source fields`, () => {
      const row = { ...columns, baseBranch: 'requested-ref' }
      expect(decodeRequestedSource(row)).toEqual({
        codec: 'requestedSource@v1',
        kind,
        cachedRepoId: 'cachedRepoId' in columns ? columns.cachedRepoId : null,
        repoUrl: 'repoUrl' in columns ? columns.repoUrl : null,
        requestedRef: 'requested-ref',
        repoGroupId: 'repoGroupId' in columns ? columns.repoGroupId : null,
        repoGroupName: 'repoGroupName' in columns ? columns.repoGroupName : null,
      })
    })
  test('task branch, legacy mirror branch and supplied launch directories remain separate', () => {
    const source = {
      id: 'task',
      repoPath: '/legacy',
      branch: '',
      workingBranch: 'publish',
      baseCommit: 'legacy-base',
    }
    const surface = projectStoredTaskRepositorySurface(source, [], [], 'redacted', 'supplied')
    expect(surface.branch).toBe('')
    expect(surface.repos[0]).toMatchObject({
      repoPath: '/legacy',
      branch: '',
      baseCommit: 'legacy-base',
    })
    expect(surface.spaceNodes).toEqual([])
    expect(
      projectStoredTaskRepositorySurface({ id: 'task', workingBranch: 'publish' }).branch,
    ).toBe('publish')
    expect(projectStoredTaskRepositorySurface({ id: 'task' }).branch).toBe('agent-workflow/task')
  })
  test('workspace phase keeps tombstone precedence and requires a prep row', () => {
    expect(isTaskWorkspaceUnbound('')).toBe(true)
    expect(isTaskWorkspaceUnbound(null)).toBe(true)
    expect(isTaskWorkspaceUnbound('/bound')).toBe(false)
    const row = {
      worktreePath: '',
      workspacePruningAt: null,
      workspacePrunedAt: null,
      hasRepoPrepRow: true,
    }
    expect(taskWorkspacePhase(row)).toBe('preparing')
    expect(taskWorkspacePhase({ ...row, hasRepoPrepRow: false })).toBe('available')
    expect(taskWorkspacePhase({ ...row, workspacePruningAt: 1 })).toBe('pruning')
    expect(taskWorkspacePhase({ ...row, workspacePruningAt: 1, workspacePrunedAt: 2 })).toBe(
      'pruned',
    )
  })
})

describe('RFC-395 II-a A2 launch response projection', () => {
  for (const spec of cases.filter((entry) => entry.spaceKind !== 'inherited'))
    test(`${spec.id}: launch keeps primary, mounts and directory bytes`, () => {
      const expected = oldSurface(
        spec,
        spec.repos!.map((repo) => ({
          ...repo,
          worktreeDirName: spec.id === 'mismatched' ? 'svc' : (repo.mountPath ?? ''),
        })),
      )
      const failed = spec.status === 'failed'
      const actual = projectLaunchedTask({
        taskId: spec.id,
        task: {
          name: spec.name!,
          inputs: {},
        },
        subject: {
          subject: { kind: 'workflow', sourceId: spec.workflowId },
          workflowName: 'Repository workflow',
          workflowVersion: 1,
          workflowSnapshot: definition,
          builtin: false,
        },
        workspace: {
          taskId: spec.id,
          kind: spec.id === 'group' ? 'group' : 'single',
          spaceKind: spec.spaceKind === 'internal' ? 'internal' : 'remote',
          repoPath: spec.repoPath,
          repoUrl: spec.repoUrl ?? null,
          cachedRepoId: spec.cachedRepoId ?? null,
          repoGroupId: spec.repoGroupId ?? null,
          repoGroupName: spec.repoGroupName ?? null,
          worktreePath: spec.worktreePath,
          baseBranch: spec.baseBranch,
          branch: spec.branch,
          baseCommit: spec.baseCommit ?? null,
          earlyError: failed ? 'materialization failed' : null,
          repositories: spec.repos!.length
            ? expected.repos.map((repo) => ({
                ...repo,
                workspaceProfileVersion: null,
                workspaceProfileDigest: null,
              }))
            : [],
          nodePaths: [],
          admit: async () => {
            throw new Error('projection must not admit')
          },
          commit: () => {
            throw new Error('projection must not commit')
          },
          rollback: async () => {
            throw new Error('projection must not roll back')
          },
        },
        gitCommitIdentity: null,
        inputs: {},
        startedAt: 10,
        metadata: {
          provenance: { kind: 'direct-json', initiator: 'manual' },
          launchOrigin: 'manual',
          intentSource: 'rest',
          scheduledTaskId: null,
          webhookTriggerId: null,
          webhookFireId: null,
          eventSubscriptionId: null,
          eventDeliveryId: null,
          triggerContext: null,
          sourceTerminationSnapshot: null,
        },
        digitalEmployeeCaseId: null,
      })
      expect(JSON.stringify(repositoryFields(actual))).toBe(
        JSON.stringify({ ...expected, spaceNodes: [] }),
      )
      expect(actual.workspaceState).toBe(failed ? 'pruned' : 'available')
    })
})
