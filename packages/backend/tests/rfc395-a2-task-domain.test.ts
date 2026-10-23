// RFC-395 II-a A2: pure subject, mount, checkpoint and rollback contracts shared by live adapters and conversion.
import { describe, expect, test } from 'bun:test'
import {
  taskExecutionKind,
  decodeTaskWorkgroupLaunchConfig,
  workgroupLaunchMode,
} from '@agent-workflow/shared'
import {
  decodeTaskSubject,
  isTurnEngineTaskSubject,
  definitionAnchorId,
  projectTaskSubject,
  taskDefinitionOrigin,
  taskSubjectStorageMismatch,
  TASK_DEFINITION_HOSTS,
  type StoredTaskSubject,
  type TaskSubject,
} from '@/modules/task-execution/domain/taskSubject'
import { deriveTaskCreationLineage } from '@/modules/task-execution/domain/taskCreation'
import {
  projectTaskRepositorySurface,
  taskBranch,
  taskRepositoryNodePaths,
  isTaskWorkspaceUnbound,
  type TaskRepositoryMount,
  type RequestedSource,
} from '@/modules/task-execution/domain/taskRepository'
import {
  decodeTaskRepositoryMount,
  taskRepositoryMountColumns,
} from '@/modules/task-execution/infrastructure/taskRepositoryCodec'
import {
  decodeTaskCheckpoints,
  encodeTaskCheckpoints,
  encodeTaskCheckpointPatch,
} from '@/modules/task-execution/infrastructure/taskCheckpointCodec'
import { planTaskCheckpointRollback } from '@/modules/task-execution/domain/taskCheckpointRollback'
import { decodeTaskRollbackPlan } from '@/modules/task-execution/infrastructure/taskRollbackCodec'
import type { TaskRepositoryCheckpoint } from '@/modules/task-execution/domain/taskCheckpoint'

const hosts = TASK_DEFINITION_HOSTS
const subjects: readonly [StoredTaskSubject, TaskSubject['kind'], string][] = [
  [{ workflowId: 'authored' }, 'workflow', 'authored'],
  [
    { workflowId: hosts.agent.id, sourceAgentName: 'writer', sourceAgentId: 'agent-id' },
    'agent',
    hosts.agent.id,
  ],
  [
    { workflowId: hosts.workgroup.id, workgroupId: 'group-id', sourceAgentName: 'writer' },
    'workgroup',
    hosts.workgroup.id,
  ],
  [{ workflowId: hosts['digital-employee'].id }, 'digital-employee', hosts['digital-employee'].id],
  [
    {
      workflowId: hosts['code-round'].id,
      codeRoundId: 'round-id',
      workgroupId: 'group-id',
      sourceAgentName: 'writer',
    },
    'code-round',
    hosts['code-round'].id,
  ],
]

describe('A2 task subject', () => {
  test('the four persisted definition namespaces keep their literal ids and names', () => {
    expect(TASK_DEFINITION_HOSTS).toEqual({
      agent: { id: '00000000000000AGENTHOST00', name: '__agent_host__' },
      workgroup: { id: '00000000000000WORKGROUP00', name: '__workgroup_host__' },
      'digital-employee': { id: '00000000000000DIGEMPHOST0', name: '__digital_employee_host__' },
      'code-round': { id: '00000000000000CODEROUND00', name: '__code_round_host__' },
    })
  })
  for (const [row, kind, anchor] of subjects)
    test(`fixed precedence: ${kind}`, () => {
      const subject = decodeTaskSubject(row)
      expect(subject.kind).toBe(kind)
      expect(definitionAnchorId(subject)).toBe(anchor)
      expect(projectTaskSubject(subject, 'live')).toEqual({
        workflowId: anchor,
        workflowName: kind === 'workflow' ? 'live' : hosts[kind as keyof typeof hosts].name,
      })
      expect(taskDefinitionOrigin(subject, false)).toBe(
        kind === 'workflow' ? 'authored' : 'platform',
      )
    })
  test('empty discriminators and employee provenance do not turn an authored workflow into another subject', () => {
    expect(
      decodeTaskSubject({
        workflowId: 'authored',
        codeRoundId: '',
        workgroupId: '',
        sourceAgentName: '',
      }),
    ).toEqual({ kind: 'workflow', sourceId: 'authored' })
    expect(projectTaskSubject({ kind: 'workflow', sourceId: 'deleted' }, null)).toEqual({
      workflowId: 'deleted',
      workflowName: null,
    })
    expect(taskDefinitionOrigin({ kind: 'workflow', sourceId: 'builtin' }, true)).toBe('platform')
  })
  test('host mismatch evidence does not alter the fixed discriminator', () => {
    for (const host of [hosts.agent, hosts.workgroup, hosts['code-round']]) {
      const row = { workflowId: host.id }
      expect(decodeTaskSubject(row).kind).toBe('workflow')
      expect(taskSubjectStorageMismatch(row)).toBe(true)
    }
    expect(taskSubjectStorageMismatch({ workflowId: hosts.agent.id, workgroupId: 'group' })).toBe(
      true,
    )
    expect(
      taskSubjectStorageMismatch({ workflowId: hosts.workgroup.id, workgroupId: 'group' }),
    ).toBe(false)
    expect(taskSubjectStorageMismatch({ workflowId: hosts['digital-employee'].id })).toBe(false)
  })
  test('API helper agrees on all five subjects and every migration 4.1 rule 5 mismatch', () => {
    for (const workflowId of ['authored', ...Object.values(hosts).map((host) => host.id)])
      for (const codeRoundId of [null, '', 'round'])
        for (const workgroupId of [null, '', 'group'])
          for (const sourceAgentName of [null, '', 'agent']) {
            const row = { workflowId, codeRoundId, workgroupId, sourceAgentName }
            expect(taskExecutionKind(row)).toBe(decodeTaskSubject(row).kind)
          }
    for (const [row] of subjects) expect(taskExecutionKind(row)).toBe(decodeTaskSubject(row).kind)
  })
})

const source: RequestedSource = {
  codec: 'requestedSource@v1',
  kind: 'cached-repo',
  cachedRepoId: 'cache',
  repoUrl: 'https://example.test/repo.git',
  requestedRef: 'main',
  repoGroupId: null,
  repoGroupName: null,
}
function mount(mountPath: string, ordinal = 0): TaskRepositoryMount {
  return {
    ordinal,
    repoPath: `/cache/${ordinal}`,
    repoUrl: source.repoUrl,
    cachedRepoId: source.cachedRepoId,
    baseBranch: 'main',
    branch: 'task-branch',
    workingBranch: null,
    baseCommit: 'base',
    worktreePath: `/workspace/${mountPath}`,
    mountPath,
    subdir: '',
    readonly: false,
    readonlyDirtyCount: null,
    hasSubmodules: null,
    submoduleInitOk: null,
    submoduleInitError: null,
  }
}

describe('A2 repository surface', () => {
  for (const paths of [[''], ['svc'], ['a', 'nested/b']])
    test(`mount projection ${JSON.stringify(paths)}`, () => {
      const mounts = paths.map(mount)
      const nodePaths = taskRepositoryNodePaths(paths, ['empty/leaf'])
      const surface = projectTaskRepositorySurface(
        { requestedSource: source, taskBranch: 'expected', workingBranch: null, nodePaths },
        '/workspace',
        [...mounts].reverse(),
      )
      expect(surface.repoPath).toBe('/cache/0')
      expect(surface.worktreePath).toBe('/workspace')
      expect(surface.repoCount).toBe(paths.length)
      expect(surface.repos.map((repo) => repo.mountPath)).toEqual(paths)
      expect(surface.repos.every((repo) => repo.worktreeDirName === repo.mountPath)).toBe(true)
      expect(surface.spaceNodes.map((node) => node.path)).toEqual(nodePaths)
      for (const entry of mounts)
        expect(decodeTaskRepositoryMount(taskRepositoryMountColumns(entry))).toMatchObject(entry)
    })
  test('writes assert directory identity, reads preserve imported names, and ancestry reaches a fixed point', () => {
    expect(() =>
      taskRepositoryMountColumns(
        decodeTaskRepositoryMount({
          ...taskRepositoryMountColumns(mount('nested/svc')),
          worktreeDirName: 'svc',
        }),
      ),
    ).toThrow('task-repository-mount-mismatch')
    expect(
      decodeTaskRepositoryMount({
        ...taskRepositoryMountColumns(mount('nested/svc')),
        worktreeDirName: 'svc',
      }),
    ).toMatchObject({ mountPath: 'nested/svc', worktreeDirName: 'svc' })
    const paths = taskRepositoryNodePaths(['nested/svc'], ['empty/leaf'])
    expect(paths).toEqual(['', 'empty', 'nested', 'empty/leaf', 'nested/svc'])
    expect(taskRepositoryNodePaths(['nested/svc'], paths)).toEqual(paths)
    expect(taskRepositoryNodePaths([])).toEqual([''])
  })
  for (const kind of ['internal', 'inherited', 'scratch'] as const)
    test(`${kind}: empty actual branch uses task branch without rewriting mount facts`, () => {
      const entry = { ...mount(''), branch: '', baseCommit: null }
      const projected = projectTaskRepositorySurface(
        {
          requestedSource: { ...source, kind },
          taskBranch: taskBranch('t', null),
          workingBranch: null,
          nodePaths: [''],
        },
        '/workspace',
        [entry],
      )
      expect(projected.branch).toBe('agent-workflow/t')
      expect(projected.repos[0]?.branch).toBe('')
      expect(projected.baseCommit).toBeNull()
    })
  for (const name of ['deferred placeholder', 'materialization failure'])
    test(`${name}: request facts produce the synthetic primary`, () => {
      const projected = projectTaskRepositorySurface(
        {
          requestedSource: source,
          taskBranch: taskBranch('t', 'publish'),
          workingBranch: 'publish',
          nodePaths: [''],
        },
        null,
        [],
      )
      expect(projected).toMatchObject({
        worktreePath: '',
        repoPath: '',
        repoUrl: source.repoUrl,
        cachedRepoId: 'cache',
        baseBranch: 'main',
        branch: 'publish',
        baseCommit: null,
        repoCount: 1,
      })
      expect(projected.repos).toHaveLength(1)
      expect(projected.repos[0]).toMatchObject({
        repoIndex: 0,
        mountPath: '',
        worktreeDirName: '',
        branch: 'publish',
      })
    })
  test('binding is independent of branch or repository count', () => {
    expect(isTaskWorkspaceUnbound(null)).toBe(true)
    expect(isTaskWorkspaceUnbound('')).toBe(true)
    expect(isTaskWorkspaceUnbound('/workspace')).toBe(false)
    expect(taskBranch('t', '')).toBe('')
  })
})

describe('A2 checkpoint codec', () => {
  for (const paths of [[], [''], ['svc'], ['a', 'nested/b']])
    test(`tri-state fixed point ${JSON.stringify(paths)}`, () => {
      const mountPath = paths[0] ?? ''
      const checkpoints: TaskRepositoryCheckpoint[] = [
        {
          mountPath,
          preSnapshot: '',
          isolationBase: 'base',
          nodeTree: 'tree',
          submodules: { poolDirs: { lib: '/pool' }, subBases: { lib: 'sub-base' } },
        },
      ]
      const encoded = encodeTaskCheckpoints(checkpoints, paths)
      expect(decodeTaskCheckpoints(encoded, paths)).toEqual(checkpoints)
      expect(encodeTaskCheckpoints(decodeTaskCheckpoints(encoded, paths), paths)).toEqual(encoded)
      expect(decodeTaskCheckpoints(encodeTaskCheckpoints([], paths), paths)).toEqual([])
      if (mountPath !== '') {
        expect(encoded.preSnapshot).toBeNull()
        expect(encoded.preSnapshotReposJson).toBe(JSON.stringify({ [mountPath]: '' }))
      } else expect(encoded.preSnapshot).toBe('')
    })
  test('partial maps and component patches never manufacture checkpoints for untouched repositories', () => {
    const checkpoints = [{ mountPath: 'nested/b', nodeTree: '', isolationBase: 'base' }]
    expect(
      decodeTaskCheckpoints(encodeTaskCheckpoints(checkpoints, ['a', 'nested/b']), [
        'a',
        'nested/b',
      ]),
    ).toEqual(checkpoints)
    const patch = encodeTaskCheckpointPatch(
      [{ mountPath: 'nested/b', nodeTree: undefined }],
      ['a', 'nested/b'],
    )
    expect(patch).toEqual({ isoNodeTree: null, isoNodeTreeReposJson: null })
    expect(Object.keys(encodeTaskCheckpointPatch([], ['a', 'nested/b']))).toHaveLength(8)
  })
  test('historical scalar JSON and map submodule values round trip without double encoding', () => {
    const value = { poolDirs: {}, subBases: {}, pendingSubResolves: ['lib'] }
    for (const path of ['', 'svc']) {
      const encoded = encodeTaskCheckpoints(
        [{ mountPath: path, submodules: JSON.stringify(value) }],
        [path],
      )
      expect(decodeTaskCheckpoints(encoded, [path])).toEqual([
        { mountPath: path, submodules: value },
      ])
    }
  })
})

describe('A2 rollback plan', () => {
  test('only the recorded nonempty pre-snapshot participates, in mount order', () => {
    const mounts = ['a', 'b', 'c'].map((mountPath) => ({
      mountPath,
      worktreePath: `/${mountPath}`,
    }))
    expect(
      planTaskCheckpointRollback(mounts, [
        { mountPath: 'a', preSnapshot: '' },
        { mountPath: 'c', preSnapshot: 'sha' },
        { mountPath: 'outside', preSnapshot: 'unmounted' },
      ]),
    ).toEqual([{ mountPath: 'c', worktreePath: '/c', snapshot: 'sha' }])
  })
  test('durable map request includes the same keys, empty markers and insertion order', () => {
    const target = {
      worktreePath: '/container',
      repos: [{ worktreePath: '/svc', mountPath: 'svc' }],
    }
    const run = {
      id: 'run',
      preSnapshot: null,
      preSnapshotReposJson: '{"svc":"sha","untouched":""}',
    }
    const plan = decodeTaskRollbackPlan(target, run)
    expect(plan.targets).toEqual([{ mountPath: 'svc', worktreePath: '/svc', snapshot: 'sha' }])
    expect(JSON.stringify(plan.request)).toBe(
      '{"v":1,"runId":"run","snapshots":{"svc":"sha","untouched":""}}',
    )
  })
  test('legacy scalar fallback and malformed map retain the existing resume distinction', () => {
    const target = {
      worktreePath: '/legacy',
      repos: [{ worktreePath: '/svc', mountPath: 'svc' }],
    }
    expect(
      decodeTaskRollbackPlan(target, { id: 'r', preSnapshot: 'sha', preSnapshotReposJson: null })
        .targets,
    ).toEqual([{ mountPath: '', worktreePath: '/legacy', snapshot: 'sha' }])
    expect(
      decodeTaskRollbackPlan(target, {
        id: 'r',
        preSnapshot: 'sha',
        preSnapshotReposJson: '{broken',
      }).targets,
    ).toEqual([])
  })
  test('lineage derivation preserves root and child serialized slot values', () => {
    const root = deriveTaskCreationLineage('root', 7, { kind: 'root', launchOrigin: 'webhook' })
    const child = deriveTaskCreationLineage('child', null, {
      kind: 'child',
      parent: { id: 'root', ...root },
      parentNodeRunId: 'call',
      continuationSlotKey: null,
      parentRunLineageSlotPathJson: null,
    })
    expect(child.launchOrigin).toBe('webhook')
    expect(child.executionLineageId).toBe('root')
    expect(child.lineageSlotPathJson).toBe(
      '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"root","workflowRevision":7},{"stableNodeKey":"child-task","frozenOccurrenceKey":"legacy-call:call","workflowRevision":null}]',
    )
  })
})

// RFC-167 discriminator matrix follows the live TaskSubject oracle after removing the raw-row duplicate.
test('task subject and launch mode — the generic-recovery guard discriminator (Codex P1)', () => {
  const isTurnEngineRow = (row: {
    workgroupId: string | null
    workgroupConfigJson: string | null
  }) =>
    isTurnEngineTaskSubject(
      decodeTaskSubject({ workflowId: 'workflow', ...row }),
      workgroupLaunchMode(decodeTaskWorkgroupLaunchConfig(row.workgroupConfigJson)),
    )
  const dyn = JSON.stringify({ mode: 'dynamic_workflow' })
  const lw = JSON.stringify({ mode: 'leader_worker' })
  // not a workgroup task at all → never blocked by the workgroup guards
  expect(isTurnEngineRow({ workgroupId: null, workgroupConfigJson: lw })).toBe(false)
  expect(isTurnEngineRow({ workgroupId: '', workgroupConfigJson: lw })).toBe(false)
  // turn-engine modes → blocked (RFC-164 engine re-entry territory)
  expect(isTurnEngineRow({ workgroupId: 'wg', workgroupConfigJson: lw })).toBe(true)
  expect(
    isTurnEngineRow({
      workgroupId: 'wg',
      workgroupConfigJson: JSON.stringify({ mode: 'free_collab' }),
    }),
  ).toBe(true)
  // dynamic_workflow → generically recoverable
  expect(isTurnEngineRow({ workgroupId: 'wg', workgroupConfigJson: dyn })).toBe(false)
  // corrupt / missing config on a workgroup task → fail-closed (blocked)
  expect(isTurnEngineRow({ workgroupId: 'wg', workgroupConfigJson: null })).toBe(true)
  expect(isTurnEngineRow({ workgroupId: 'wg', workgroupConfigJson: '{{' })).toBe(true)
})
