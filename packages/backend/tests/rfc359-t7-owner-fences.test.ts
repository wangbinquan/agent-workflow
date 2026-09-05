// RFC-359 W1-T7（P0-1 / P0-2）—— 两道 owner 围栏在两个引擎上同一规则。
//
// dual-provider-parity-audit-2026-09-04：
// · P0-1：runner 不逐处传 executionContext，依赖 runWithTaskExecutionContext 的环境上下文兜底。SQLite 适配器
//   读它（sqliteOwnedTaskMutation / taskLifecycle），PG 适配器把 undefined 当「无主」→ assertPostgresqlTaskOwnerlessTx
//   撞上自己 claimed 的 owner，节点的第一次写就被拒，任务以 task-execution-stale-owner 收场。
// · P0-2：PG effect 账本私有 assertOwner 额外要求 revision / leaseUntil 与 attach 时冻结的 token 等值，
//   首次心跳后所有 effect 写入被拒；同仓公共 assertPostgresqlTaskOwnerTx 注释逐字写着「故意不做等值谓词」。
// 这里在两个引擎上各验：环境上下文内不传 executionContext 的写入成功；心跳之后旧 token 仍能开 effect。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider } from './helpers/eachProvider'

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

async function seedClaimedTask(db: ProviderNeutralDatabase) {
  const taskId = `t7_${ulid()}`
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-t7',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'pending',
    retryIndex: 0,
    iteration: 0,
  })
  const persistence = createTaskExecutionPersistence(db)
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `gen-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await module.claimPersisted({ intentId })
  module.claimGate.leave(claimed.permit)
  const context = createTaskExecutionContext({ intentId, token: claimed.token, persistence })
  return { taskId, runId, intentId, persistence, module, token: claimed.token, context }
}

describeEachProvider('RFC-359 T7 —— owner 围栏同一规则（P0-1 / P0-2）', (harness) => {
  test('P0-1：drive 上下文内不传 executionContext 的节点写入按 owner token 放行', async () => {
    const db = harness.db
    const seeded = await seedClaimedTask(db)
    expect((await seeded.persistence.ownership.read(seeded.taskId))?.state).toBe('claimed')
    await runWithTaskExecutionContext(seeded.context, async () => {
      await seeded.persistence.nodeRuns.transition({
        nodeRunId: seeded.runId,
        event: { kind: 'mark-running' },
        extra: { startedAt: Date.now() },
      })
      await seeded.persistence.nodeExecution.upsertOutputs({
        nodeRunId: seeded.runId,
        outputs: [{ portName: 'out', content: 'written under the ambient owner context' }],
      })
      await seeded.persistence.nodeExecution.patch({
        nodeRunId: seeded.runId,
        values: { envelopeNonce: 'nonce-under-ambient-context' },
      })
    })
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, seeded.runId)))[0]!
    expect(run.status).toBe('running')
    expect(run.envelopeNonce).toBe('nonce-under-ambient-context')
    const outputs = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, seeded.runId))
    expect(outputs.map((row) => row.content)).toEqual(['written under the ambient owner context'])
    seeded.module.resetForTesting()
  })

  test('P0-1：显式 executionContext 仍然优先于环境上下文', async () => {
    const db = harness.db
    const seeded = await seedClaimedTask(db)
    await seeded.persistence.nodeExecution.upsertOutputs({
      nodeRunId: seeded.runId,
      outputs: [{ portName: 'explicit', content: 'x' }],
      executionContext: seeded.context,
    })
    const outputs = await db
      .select({ portName: nodeRunOutputs.portName })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, seeded.runId))
    expect(outputs.map((row) => row.portName)).toEqual(['explicit'])
    seeded.module.resetForTesting()
  })

  test('P0-2：心跳推进 revision / lease 之后，attach 时冻结的 token 仍能开 effect 并结算', async () => {
    const db = harness.db
    const seeded = await seedClaimedTask(db)
    const refreshed = await seeded.persistence.ownership.heartbeat({
      token: seeded.token,
      now: Date.now() + 5,
      leaseMs: 120_000,
    })
    expect(refreshed.ownerRevision).toBeGreaterThan(seeded.token.ownerRevision)
    const pathJson = canonicalJson(rootPath(seeded.taskId))
    const prepared = await seeded.persistence.effects.prepareAndAcquire({
      token: seeded.token,
      intentId: seeded.intentId,
      operationKey: `${seeded.taskId}:process:agent`,
      executionLineageId: seeded.taskId,
      operationFamilyKey: operationFamilyKey({
        executionLineageId: seeded.taskId,
        slotPath: rootPath(seeded.taskId),
        effectKind: 'process',
        stableActionOrdinal: 'managed-agent',
      }),
      operationGeneration: 0,
      kind: 'process',
      requestHash: requestHash({ argv: ['/opt/opencode'] }),
      slotPathJson: pathJson,
      slotPathDigest: requestHash(pathJson),
      candidateId: `agent:${seeded.runId}`,
      recoveryClass: 'managed-process-preactivation',
      classifierVersion: 'rfc328-managed-process-v1',
      transportPolicyVersion: 'rfc328-preactivation-v1',
      retryAuthority: 'none',
      resourceKeys: [`process:${seeded.taskId}:${seeded.runId}`],
    })
    await seeded.persistence.effects.settle({
      token: seeded.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: 'failed-not-applied',
      applicationEvidence: 'definitely-not-applied',
      retryAuthority: 'none',
      failureCode: 'test-settled-after-heartbeat',
    })
    seeded.module.resetForTesting()
  })
})

test('源码锁：每个 PG owner 围栏都先读环境上下文；effect 账本围栏不再对 revision / lease 做等值', () => {
  const infrastructure = resolve(
    import.meta.dir,
    '..',
    'src',
    'modules',
    'task-execution',
    'infrastructure',
  )
  for (const file of [
    // RFC-359 W4-B1 批 2c：wrapper run / node-run runtime / scheduler completion 的围栏合到中立原语。
    'ownedTaskExecution.ts',
    'postgresqlRuntimeSessionLeaseOperations.ts',
  ]) {
    const source = readFileSync(resolve(infrastructure, file), 'utf8')
    expect(source, file).toContain('currentTaskExecutionContext(')
  }
  const effects = readFileSync(
    resolve(infrastructure, 'postgresqlTaskExecutionEffectPersistence.ts'),
    'utf8',
  )
  expect(effects).not.toContain('token.ownerRevision')
  expect(effects).not.toContain('token.leaseUntil')
  const collaboration = readFileSync(
    resolve(
      import.meta.dir,
      '..',
      'src',
      'modules',
      'collaboration',
      'infrastructure',
      'postgresqlCollaborationRuntimeMechanics.ts',
    ),
    'utf8',
  )
  expect(collaboration).toContain('currentTaskExecutionContext(input.taskId)')
})
