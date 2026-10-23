// RFC-395 II-a A2: checkpoint/mount ports must preserve v1 fence, hosted and effect identity bytes.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  isolationCreateRequest,
  isolationMergeRequest,
  isolationCleanupRequest,
} from '@/modules/task-execution/infrastructure/isolationEffectRequest'
import { humanGateNodeProjectionFence } from '@/modules/task-execution/domain/humanGateContinuation'
import {
  humanGateCheckpointProjectionMember,
  humanGateNodeProjectionMember,
} from '@/modules/task-execution/infrastructure/humanGateProjection'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import { sha256Hex } from '@/util/hash'
import {
  decodeTaskCheckpoints,
  decodeTaskCheckpointInheritance,
} from '@/modules/task-execution/infrastructure/taskCheckpointCodec'
import { decodeTaskRollbackPlan } from '@/modules/task-execution/infrastructure/taskRollbackCodec'
import { wrapperRunSnapshot } from '@/modules/task-execution/infrastructure/wrapperRunPersistenceShared'
import { GitStrategy } from '@/modules/task-execution/engine/wrapper/gitStrategy'
import type { WrapperExecutionRequest } from '@/modules/task-execution/domain/wrapperExecution'
import { hostedAgentNodeContext } from '@/modules/task-execution/infrastructure/crewstation/agentContext'
import { commitPushNodeId } from '@/services/commitPush'
import { toContainerRelative } from '@/modules/task-execution/application/portArtifacts'
import { repositoryPublicationOrdinal } from '@/modules/task-execution/domain/repositoryExecutionIdentity'
import { isoWorktreePathFor } from '@/platform/workspace/local/isolationReferences'
import { prepareWorkspaceRollbackPlan } from '@/modules/collaboration/application/prepareWorkspaceRollbackPlan'

const member = {
  id: 'run',
  taskId: 'task',
  nodeId: 'node',
  parentNodeRunId: null,
  iteration: 0,
  shardKey: null,
  retryIndex: 0,
  reviewIteration: 0,
  status: 'done',
  failureCode: null,
  rerunCause: null,
  supersededByReview: null,
  rolledBack: null,
  continuationSlotKey: null,
  lineageSlotPathJson: null,
  operationGeneration: 0,
} as const

describe('RFC-395 II-a A2 persisted checkpoint bytes', () => {
  for (const mounts of [[''], ['svc'], ['', 'nested/svc']]) {
    test(`fence and hosted context ${JSON.stringify(mounts)}`, () => {
      const mountPath = mounts[0]!
      const single = mounts.length === 1 && mounts[0] === ''
      const legacy = {
        ...member,
        preSnapshot: single ? 'sha' : null,
        preSnapshotReposJson: single ? null : JSON.stringify({ [mountPath]: 'sha' }),
      }
      const projected = humanGateCheckpointProjectionMember(
        { ...member, checkpoints: [{ mountPath, preSnapshot: 'sha' }] },
        mounts,
      )
      expect(projected).toEqual(legacy)
      expect(humanGateNodeProjectionFence([projected]).digest).toBe(
        sha256Hex(canonicalJson({ v: 1, members: [legacy] })),
      )
      const node = {
        id: 'run',
        nodeId: 'node',
        iteration: 0,
        retryIndex: 0,
        containerRunId: null,
        parentNodeRunId: null,
        shardKey: null,
        envelopeNonce: null,
      }
      expect(
        JSON.stringify(
          hostedAgentNodeContext({
            ...node,
            checkpointInheritance: decodeTaskCheckpointInheritance(legacy),
          }),
        ),
      ).toBe(JSON.stringify({ ...node, preSnapshot: single ? 'sha' : null }))
    })
  }
  test('continuation and hosted v1 context preserve scalar-only inheritance even beside a map', () => {
    const row = { preSnapshot: 'historic-workspace', preSnapshotReposJson: '{"svc":"mapped"}' }
    const inherited = decodeTaskCheckpointInheritance(row)
    expect(inherited).toEqual([{ mountPath: '', preSnapshot: 'historic-workspace' }])
    expect(decodeTaskCheckpointInheritance({ ...row, preSnapshot: null })).toEqual([])
    const node = {
      id: 'run',
      nodeId: 'node',
      iteration: 0,
      retryIndex: 0,
      containerRunId: null,
      parentNodeRunId: null,
      shardKey: null,
      envelopeNonce: null,
    }
    expect(
      JSON.stringify(hostedAgentNodeContext({ ...node, checkpointInheritance: inherited })),
    ).toBe(JSON.stringify({ ...node, preSnapshot: row.preSnapshot }))
  })
  test('raw historical fence JSON remains byte-identical at the epoch-1 boundary', () => {
    const legacy = { ...member, preSnapshot: null, preSnapshotReposJson: '{ "b": "B", "a": "A" }' }
    expect(humanGateNodeProjectionFence([humanGateNodeProjectionMember(legacy)]).digest).toBe(
      sha256Hex(canonicalJson({ v: 1, members: [legacy] })),
    )
  })
  for (const mountPath of ['', 'svc', 'nested/仓库']) {
    test(`mount identity preserves publication and directory bytes ${mountPath}`, () => {
      const oldDirectoryName = mountPath
      const oldNodeId = `__commit_push__:agent${oldDirectoryName === '' ? '' : `:${oldDirectoryName}`}`
      expect(commitPushNodeId('agent', mountPath)).toBe(oldNodeId)
      expect(repositoryPublicationOrdinal('agent', mountPath)).toBe(
        `repository-publication:agent:${oldDirectoryName}`,
      )
      expect(toContainerRelative(mountPath, 'out.txt')).toBe(
        oldDirectoryName === '' ? 'out.txt' : `${oldDirectoryName}/out.txt`,
      )
      const oldRoot = join('/home', 'iso', 'task', 'run-2')
      expect(isoWorktreePathFor('/home', 'task', 'run-2', mountPath)).toBe(
        oldDirectoryName === '' ? oldRoot : join(oldRoot, oldDirectoryName),
      )
      const before = {
        v: 1,
        isoKeyRunId: 'run',
        repos: [{ worktreeDirName: oldDirectoryName, worktreePathDigest: sha256Hex('/workspace') }],
        forcedContainerPaths: ['out.txt'],
      }
      const after = isolationCreateRequest(
        'run',
        [{ mountPath, worktreePath: '/workspace' }],
        ['out.txt'],
      )
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      expect(sha256Hex(canonicalJson(after))).toBe(sha256Hex(canonicalJson(before)))
      const beforeMerge = {
        v: 1,
        nodeRunId: 'run',
        via: 'replay',
        suppliedNodeTrees: true,
        repos: [{ worktreeDirName: oldDirectoryName, baseSnapshot: 'base' }],
      }
      const afterMerge = isolationMergeRequest('run', 'replay', true, [
        { mountPath, baseSnapshot: 'base' },
      ])
      expect(JSON.stringify(afterMerge)).toBe(JSON.stringify(beforeMerge))
      expect(sha256Hex(canonicalJson(afterMerge))).toBe(sha256Hex(canonicalJson(beforeMerge)))
      const beforeCleanup = {
        v: 1,
        dbNodeRunId: 'run',
        isoKey: 'run-2',
        repos: [{ worktreeDirName: oldDirectoryName, isoWorktreePathDigest: sha256Hex('/iso') }],
      }
      const afterCleanup = isolationCleanupRequest('run', 'run-2', [
        { mountPath, isoWorktreePath: '/iso' },
      ])
      expect(JSON.stringify(afterCleanup)).toBe(JSON.stringify(beforeCleanup))
      expect(sha256Hex(canonicalJson(afterCleanup))).toBe(sha256Hex(canonicalJson(beforeCleanup)))
    })
  }
  test('workspace rollback candidates serialize the same v1 keys and digest', async () => {
    const plan = await prepareWorkspaceRollbackPlan({
      taskId: 'task',
      candidates: [
        {
          sourceNodeRunId: 'run',
          targets: [{ mountPath: 'svc', worktreePath: '/workspace/svc', snapshot: 'sha' }],
        },
      ],
      inspector: { snapshotExists: async () => true },
    })
    const expected = {
      schemaVersion: 1,
      kind: 'workspace-rollback-plan',
      taskId: 'task',
      targets: [
        {
          sourceNodeRunId: 'run',
          worktreePath: '/workspace/svc',
          worktreeDirName: 'svc',
          snapshot: 'sha',
          ordinal: 0,
        },
      ],
      resourceKeys: [`workspace:${sha256Hex('/workspace/svc')}`],
    }
    expect(JSON.stringify(plan)).toBe(
      JSON.stringify({ ...expected, digest: sha256Hex(canonicalJson(expected)) }),
    )
  })
})

describe('RFC-395 II-a malformed historical checkpoint bytes', () => {
  test('non-object JSON maps cannot invent mounts from primitive values', () => {
    for (const raw of ['"abc"', '42', 'true', 'null', '{broken']) {
      expect(
        decodeTaskCheckpoints(
          {
            preSnapshotReposJson: raw,
            isoBaseSnapshotReposJson: raw,
            isoNodeTreeReposJson: raw,
            isoSubmodulesReposJson: raw,
          },
          ['svc'],
        ),
      ).toEqual([])
    }
    // parseIsoJsonMap historically accepted arrays as objects, with numeric keys.
    expect(decodeTaskCheckpoints({ isoNodeTreeReposJson: '["tree"]' }, ['0'])).toEqual([
      { mountPath: '0', nodeTree: 'tree' },
    ])
  })
  test('the durable request retains parsed null entries and arrays; review targets skip non-strings', () => {
    const target = {
      worktreePath: '/workspace',
      repos: [{ mountPath: 'svc', worktreePath: '/workspace/svc' }],
    }
    for (const raw of [
      '{"svc":"sha","empty":null}',
      '[null,"sha"]',
      '{"svc":7}',
      '{"svc":false}',
      '{"svc":{}}',
      'null',
    ]) {
      const plan = decodeTaskRollbackPlan(target, {
        id: 'run',
        preSnapshot: null,
        preSnapshotReposJson: raw,
      })
      const expected = { v: 1, runId: 'run', snapshots: JSON.parse(raw) as unknown }
      expect(JSON.stringify(plan.request)).toBe(JSON.stringify(expected))
      expect(sha256Hex(canonicalJson(plan.request))).toBe(sha256Hex(canonicalJson(expected)))
      expect(plan.targets).toEqual(
        raw.includes('"svc":"sha"')
          ? [{ mountPath: 'svc', worktreePath: '/workspace/svc', snapshot: 'sha' }]
          : [],
      )
    }
  })
})

test('Git wrapper reuses progress when either historical base column exists', async () => {
  for (const [scalar, map, fresh] of [
    ['old-scalar', null, false],
    [null, '{}', false],
    [null, null, true],
  ] as const) {
    const previous = wrapperRunSnapshot(
      {
        id: 'run',
        status: 'running',
        mergeState: 'isolating',
        wrapperProgressJson: JSON.stringify({
          kind: 'git',
          baseline: 'original',
          phase: 'inner-running',
        }),
        consumedUpstreamRunsJson: null,
        isoBaseSnapshot: scalar,
        isoBaseSnapshotReposJson: map,
        isoSubmodulesJson: null,
        isoSubmodulesReposJson: null,
      },
      ['svc'],
    )
    expect(previous.hasIsolationBase).toBe(!fresh)
    const captured: boolean[] = [],
      persisted: string[] = [],
      compared: unknown[] = []
    const strategy = new GitStrategy(
      {
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
        fanoutMaxShardTotal: 1,
        fanoutAgentKey() {
          throw new Error('unused fanout operation')
        },
        async resolveFanoutAgent() {
          throw new Error('unused fanout operation')
        },
        async sourcePortKind() {
          throw new Error('unused input operation')
        },
        consumedProvenanceMatches() {
          throw new Error('unused provenance operation')
        },
        async readPort() {
          throw new Error('unused input operation')
        },
        async resolveInputs() {
          throw new Error('unused input operation')
        },
        async recordConsumed() {
          throw new Error('unused provenance operation')
        },
        async priorFanoutConsumed() {
          throw new Error('unused fanout operation')
        },
        async outputOf() {
          throw new Error('unused output lookup')
        },
        reportDiagnostic() {},
        async persistProgress(_id, progress) {
          persisted.push(progress.baseline!)
        },
        async upsertOutput() {},
      },
      {
        async drive() {
          return { kind: 'ok' }
        },
      },
      {
        async open() {
          return { key: Symbol(), kind: 'wrapper-git', passthrough: true }
        },
        async captureGitEntry(_scene, start) {
          captured.push(start)
          return { baselines: { '': 'new' }, preDirtyByRepo: {}, primaryMount: '' }
        },
        async changedFiles(_scene, baselines) {
          compared.push(baselines)
          return []
        },
        async merge() {
          return { kind: 'merged' }
        },
      },
    )
    const request = {
      node: { id: 'wrapper', kind: 'wrapper-git' },
      iteration: 0,
      containerRunId: null,
      task: { taskId: 'task' },
      execution: {},
      scope: {
        wrapperId: 'wrapper',
        kind: 'wrapper-git',
        parentScopeId: null,
        directNodeIds: ['child'],
        path: [{ wrapperId: 'wrapper', kind: 'wrapper-git' }],
      },
    } satisfies WrapperExecutionRequest<'wrapper-git'>
    const prepared = await strategy.prepare(request)
    if (prepared.kind !== 'ready') throw new Error('wrapper unexpectedly rejected')
    await prepared.execute({
      kind: 'wrapper-git',
      runId: 'run',
      resumed: true,
      enteredRunning: true,
      previous,
    })
    expect(captured).toEqual(fresh ? [true] : [])
    expect(persisted).toEqual(fresh ? ['new'] : [])
    expect(compared).toEqual([{ '': fresh ? 'new' : 'original' }])
  }
})
