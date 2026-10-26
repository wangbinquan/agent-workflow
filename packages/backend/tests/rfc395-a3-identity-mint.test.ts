import { tablesOf } from '@/platform/persistence/sessionTables'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
// RFC-395 II-a A3: explicit mint roles must match stored facts without conflating historical parent and container.
import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture, nodeRunFixture, readNodeRunFixtures } from './helpers/model'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import type { NodeRunMintInput } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import { deriveNodeRunRole } from '@/modules/task-execution/domain/nodeRunRole'
import { buildNodeRunMintRecord } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { installAbortTrigger, dropAbortTrigger, abortMessages } from './helpers/faultTrigger'

const roles: readonly Pick<NodeRunMintInput, 'nodeId' | 'cause' | 'role' | 'syntheticKind'>[] = [
  { nodeId: 'agent', cause: 'initial', role: 'node-attempt', syntheticKind: null },
  { nodeId: 'wrapper', cause: 'wrapper-init', role: 'container', syntheticKind: null },
  { nodeId: '__repo_prep__', cause: 'initial', role: 'synthetic', syntheticKind: 'repo-prep' },
  {
    nodeId: '__commit_push__:agent',
    cause: 'commit-push',
    role: 'synthetic',
    syntheticKind: 'commit-push',
  },
  {
    nodeId: 'agent',
    cause: 'commit-push-session',
    role: 'synthetic',
    syntheticKind: 'commit-session',
  },
  {
    nodeId: '__merge_resolve__:agent',
    cause: 'merge-resolve',
    role: 'synthetic',
    syntheticKind: 'merge-resolve',
  },
  { nodeId: '__dw_orchestrator__', cause: 'dw-gate', role: 'synthetic', syntheticKind: 'dw-gate' },
  { nodeId: '__wg_leader__', cause: 'wg-gate', role: 'synthetic', syntheticKind: 'wg-gate' },
  {
    nodeId: '__dw_orchestrator__',
    cause: 'dw-generate',
    role: 'synthetic',
    syntheticKind: 'dw-orchestrator',
  },
  {
    nodeId: '__wg_member__',
    cause: 'wg-assignment',
    role: 'synthetic',
    syntheticKind: 'workgroup-host',
  },
  { nodeId: 'input', cause: 'io-virtual', role: 'node-attempt', syntheticKind: null },
  { nodeId: 'review', cause: 'review-park', role: 'node-attempt', syntheticKind: null },
  { nodeId: 'clarify', cause: 'clarify-park', role: 'node-attempt', syntheticKind: null },
]

describeEachProvider('RFC-395 II-a A3 identity mint', (harness) => {
  async function seed() {
    const taskId = ulid()
    await workflowFixture(harness.db, { id: taskId, name: 'identity', definition: '{}' })
    await taskFixture(harness.db, {
      id: taskId,
      workflowId: taskId,
      status: 'running',
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/work',
      baseBranch: 'main',
      branch: 'task',
      inputs: '{}',
      startedAt: 1,
    })
    return {
      taskId,
      mint: new DrizzleNodeRunLifecyclePersistence(harness.db),
      nodes: new DrizzleNodeExecutionPersistence(harness.db),
    }
  }

  test('every role retains stored bytes, a mint nonce and the single shared role derivation', async () => {
    const { taskId, mint, nodes } = await seed()
    for (const shape of roles) {
      const id = await mint.mint(
        withTargetMintIdentity({
          ...shape,
          ...(shape.syntheticKind === 'commit-session'
            ? {
                slot: {
                  kind: 'synthetic' as const,
                  owner: { kind: 'attempt' as const, id: 'origin' },
                  syntheticKind: 'commit-session' as const,
                  discriminator: shape.nodeId,
                },
              }
            : {}),
          taskId,
          status: 'pending',
          overrides: { identity: { startedAt: 17 } },
        }),
      )
      const row = (await readNodeRunFixtures(harness.db, { id }))[0]!
      const snapshot = (await nodes.read(id))!
      expect({ role: snapshot.role, syntheticKind: snapshot.syntheticKind }).toEqual({
        role: shape.role,
        syntheticKind: shape.syntheticKind,
      })
      const derived = deriveNodeRunRole(row)
      expect(derived.role).toBe(shape.role)
      expect(derived.syntheticKind).toBe(shape.syntheticKind)
      expect(row.envelopeNonce).toMatch(/^[0-9a-f]{16}$/)
      expect(row.startedAt).toBe(17)
      expect(row.parentNodeRunId).toBeNull()
      expect(row.containerRunId).toBeNull()
      expect(snapshot.attemptIndex).toBe(row.retryIndex)
      expect(snapshot.pid).toBeNull()
      expect(snapshot.opencodeSessionId).toBeNull()
      expect(snapshot.mergeState).toBeNull()
    }
  })

  test('born-running node attempt requires a container even when historical parent exists', async () => {
    const { taskId, mint, nodes } = await seed()
    const parent = await mint.mint(
      withTargetMintIdentity({
        taskId,
        nodeId: 'loop',
        cause: 'wrapper-init',
        role: 'container',
        syntheticKind: null,
        status: 'pending',
      }),
    )
    const base = {
      taskId,
      nodeId: 'body',
      cause: 'initial',
      role: 'node-attempt',
      syntheticKind: null,
      status: 'running',
    } as const
    const before = await readNodeRunFixtures(harness.db, { taskId })
    await expect(mint.mint(withTargetMintIdentity(base))).rejects.toThrow('containerRunId')
    await expect(
      mint.mint(
        withTargetMintIdentity({ ...base, overrides: { identity: { parentNodeRunId: parent } } }),
      ),
    ).rejects.toThrow('containerRunId')
    expect(await readNodeRunFixtures(harness.db, { taskId })).toEqual(before)
    const body = await mint.mint(
      withTargetMintIdentity({
        ...base,
        containerRunId: parent,
        iteration: 2,
        overrides: { identity: { parentNodeRunId: parent } },
      }),
    )
    expect(await nodes.read(body)).toMatchObject({
      role: 'node-attempt',
      parentNodeRunId: parent,
      containerRunId: parent,
      scopePath: 'loop:2',
    })
  })

  test('mismatched role or synthetic kind is rejected before allocation and insert', async () => {
    const { taskId, mint } = await seed()
    const input: NodeRunMintInput = withTargetMintIdentity({
      taskId,
      nodeId: 'plain',
      slot: { kind: 'node', nodeId: 'plain', frame: { containerRunId: null, iteration: 0 } },
      cause: 'initial',
      role: 'container',
      syntheticKind: null,
      status: 'pending',
    })
    await expect(mint.mint(withTargetMintIdentity(input))).rejects.toThrow(
      'node-run-role-slot-mismatch',
    )
    await expect(
      mint.mint(
        withTargetMintIdentity({
          ...input,
          nodeId: '__repo_prep__',
          role: 'synthetic',
          syntheticKind: 'commit-push',
        }),
      ),
    ).rejects.toThrow('node-run-role-slot-mismatch')
    expect(await readNodeRunFixtures(harness.db, { taskId })).toEqual([])
  })

  test('identity, config, input and scalar checkpoint inheritance preserve the old formulas', async () => {
    const { taskId, mint, nodes } = await seed()
    const nonce = '0123456789abcdef'
    const consumed = '{ "z" : "prior", "a": "earlier" }'
    await nodeRunFixture(harness.db, [
      { id: 'prior', taskId, nodeId: 'z', status: 'done' },
      { id: 'earlier', taskId, nodeId: 'a', status: 'done' },
      { id: 'historical', taskId, nodeId: 'parent', status: 'done' },
    ])
    const id = await mint.mint(
      withTargetMintIdentity({
        taskId,
        nodeId: 'body',
        cause: 'process-retry',
        role: 'node-attempt',
        syntheticKind: null,
        status: 'pending',
        retryIndex: 7,
        iteration: 3,
        inheritFrom: {
          reviewIteration: 2,
          shardKey: 's',
          parentNodeRunId: 'historical',
          containerRunId: null,
          checkpointInheritance: [{ mountPath: '', preSnapshot: '' }],
          operationGeneration: 4,
        },
        overrides: {
          identity: { envelopeNonce: nonce, startedAt: null, wgRound: 8 },
          config: {
            agentOverrideName: 'borrowed',
            agentOverrideId: 'agent-id',
            shardValueHash: 'hash',
          },
          inputs: { consumedUpstreamRunsJson: consumed },
        },
      }),
    )
    const row = (await readNodeRunFixtures(harness.db, { id }))[0]!
    expect(row).toMatchObject({
      reviewIteration: 2,
      shardKey: 's',
      parentNodeRunId: 'historical',
      retryIndex: 7,
      iteration: 3,
      operationGeneration: 5,
      startedAt: null,
      envelopeNonce: nonce,
      wgRound: 8,
      agentOverrideName: 'borrowed',
      agentOverrideId: 'agent-id',
      shardValueHash: 'hash',
    })
    expect(row.continuationSlotKey).toBe(
      createHash('sha256')
        .update(JSON.stringify({ nodeId: 'body', iteration: 3, shardKey: 's' }))
        .digest('hex'),
    )
    expect(row.checkpoints).toEqual([{ mountPath: '', preSnapshot: '' }])
    expect(JSON.parse((await nodes.read(id))!.consumedUpstreamRunsJson!)).toEqual(
      JSON.parse(consumed),
    )
    expect(await mint.loadEnvelopeNonce(id)).toBe(nonce)
  })

  test('history without a nonce is readable only as history and cannot supply an execution envelope', async () => {
    const { taskId, mint, nodes } = await seed()
    const { nodeRuns } = tablesOf(harness.db)
    await harness.db.insert(nodeRuns).values({
      id: 'historical-wrapper',
      taskId,
      nodeId: 'historical-wrapper',
      seq: 0,
      generationSeq: 0,
      status: 'done',
      role: null,
      slotKey: null,
      attemptIndex: null,
      scopePath: null,
      envelopeNonce: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
    })
    await expect(mint.loadEnvelopeNonce('historical-wrapper')).rejects.toThrow(
      'no executable envelope',
    )
    expect(await nodes.read('historical-wrapper')).toBeNull()
    expect(await createRunSelectionReader(harness.db).familyHistory(taskId, {})).toMatchObject([
      { id: 'historical-wrapper', identity: 'unknown' },
    ])
  })

  test('an initial-output failure still rolls mint and allocation back in the original transaction', async () => {
    const { taskId, mint } = await seed()
    const trigger = {
      name: 'rfc395_a3_mint_output_abort',
      table: 'node_run_outputs',
      error: 'output-abort',
    }
    await installAbortTrigger(harness, trigger)
    try {
      const error = await mint
        .mint(
          withTargetMintIdentity({
            taskId,
            nodeId: 'input',
            role: 'node-attempt',
            syntheticKind: null,
            cause: 'io-virtual',
            status: 'done',
            outputs: [{ portName: 'value', content: 'body' }],
          }),
        )
        .then(
          () => undefined,
          (cause: unknown) => cause,
        )
      // PostgreSQL 把触发器异常包成 `Failed query`，原文在 cause 上；两个引擎都须由这条触发器中止。
      expect(abortMessages(error)).toContain('output-abort')
    } finally {
      await dropAbortTrigger(harness, trigger)
    }
    expect(await readNodeRunFixtures(harness.db, { taskId })).toEqual([])
  })
})

test('RFC-395 II-a A3 explicit null and undefined keep mint default precedence', () => {
  const input: NodeRunMintInput = withTargetMintIdentity({
    taskId: 't',
    nodeId: 'n',
    role: 'node-attempt',
    syntheticKind: null,
    status: 'done',
    cause: 'initial',
    overrides: {
      identity: {
        startedAt: null,
        finishedAt: 0,
        envelopeNonce: 'fedcba9876543210',
        operationGeneration: 0,
      },
    },
  })
  const row = buildNodeRunMintRecord(withTargetMintIdentity(input))
  expect(row.startedAt).toBeNull()
  expect(row.finishedAt).toBe(0)
  expect(row.operationGeneration).toBe(0)
  expect(row.envelopeNonce).toBe('fedcba9876543210')
})
