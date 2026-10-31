// RFC-397 — CI run 41052627131: proposal §1.2 traced exhausted 40001 retries to
// SERIALIZABLE owner-fenced writers; §1.3 showed that removing the fence kept stale
// snapshots. These tests retain the fence and prove fresh reads, family locking,
// lease rechecks and whole-transaction replay (design §4.1, 1a, 2–7).
import { expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type PostgresqlTransactionConnection,
} from '@/platform/persistence/postgresqlRuntime'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import type {
  TaskEffectAttemptPreparation,
  TaskEffectAttemptIdentity,
} from '@/modules/task-execution/application/ports/taskExecutionEffectStore'
import {
  createExclusiveDaemonLockProof,
  createOwnershipToken,
  createVerifiedOutcomeUnknownClosure,
  createVerifiedStopProof,
  createWorkerIdentity,
  ownershipTuple,
} from '@/modules/task-execution/domain/ownership'
import { buildCodeHostRecoveryDescriptor } from '@/modules/task-execution/domain/codeHostRecovery'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleTaskExecutionEffectPersistence } from '@/modules/task-execution/infrastructure/taskExecutionEffectPersistence'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { createHostedProcessEffectProjection } from '@/modules/task-execution/infrastructure/crewstation/processEffectProjection'
import {
  closeOutcomeUnknownAndRelease,
  closeRecoveredOutcomeUnknownAndRelease,
  lockEffectFamiliesTx,
  resolveQuiescedCodeHostMutations,
  resolveQuiescedManagedProcesses,
} from '@/modules/task-execution/infrastructure/effectQuiescence'
import {
  describeEachProvider,
  recordPostgresqlStatements,
  resolveTestProviders,
  type ProviderHarness,
} from './helpers/eachProvider'
import { statementFailureCode, type StatementRecording } from './helpers/statementRecorder'
import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'

const normalized = (text: string) => text.toLowerCase().replaceAll('"agent_workflow".', '')
const effects = (db: PersistenceDb) => new DrizzleTaskExecutionEffectPersistence(db)
const leases = (db: PersistenceDb) => createRuntimeSessionLeaseOperations(db)
const familyKey = (lineage: string, family: string) =>
  `task-execution-effect-family:${lineage}:${family}`

async function seed(db: PersistenceDb, taskId = 't', lineage = 'lineage') {
  const snapshot = '{"$schema_version":2,"nodes":[],"edges":[],"inputs":[]}'
  const slotPathJson = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: lineage, workflowRevision: 1 },
  ])
  await workflowFixture(db, { id: `w-${taskId}`, name: taskId, definition: snapshot })
  await taskFixture(db, {
    id: taskId,
    workflowId: `w-${taskId}`,
    workflowSnapshot: snapshot,
    status: 'running',
    repoPath: '',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'task',
    inputs: '{}',
    startedAt: 1,
    executionLineageId: lineage,
    lineageSlotPathJson: slotPathJson,
  })
  const runId = `r-${taskId}`
  await nodeRunFixture(db, { id: runId, taskId, nodeId: 'worker', status: 'running' })
  const identity = createWorkerIdentity({ ownerId: `owner-${taskId}`, daemonGeneration: 'old' })
  const token = createOwnershipToken({
    taskId,
    identity,
    epoch: 1,
    leaseUntil: Date.now() + 60_000,
    ownerRevision: 1,
  })
  const intentId = `i-${taskId}`
  const { taskExecutionOwners, taskExecutionIntents } = tablesOf(db)
  await insertOne(db, taskExecutionOwners, {
    ...ownershipTuple(token),
    state: 'claimed',
    leaseUntil: token.leaseUntil,
    revision: 1,
    lastHeartbeatAt: 1,
    updatedAt: 1,
  })
  await insertOne(db, taskExecutionIntents, {
    id: intentId,
    taskId,
    kind: 'launch',
    state: 'claimed',
    source: 'rest',
    requestHash: 'request',
    payloadJson: '{}',
    executionLineageId: lineage,
    continuationSlotKey: 'root',
    slotPathJson,
    operationGeneration: 0,
    expectedTaskRevision: 1,
    claimedEpoch: 1,
    createdAt: 1,
    claimedAt: 1,
    updatedAt: 1,
  })
  const persistence = createTaskExecutionPersistence(db, {
    historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
  })
  const context = createTaskExecutionContext({ token, intentId, persistence })
  return { taskId, runId, lineage, token, intentId, context, slotPathJson }
}
type Fixture = Awaited<ReturnType<typeof seed>>

function preparation(
  f: Fixture,
  overrides: Partial<TaskEffectAttemptPreparation> = {},
): TaskEffectAttemptPreparation {
  return {
    token: f.token,
    intentId: f.intentId,
    executionLineageId: f.lineage,
    operationFamilyKey: 'family',
    operationGeneration: 0,
    operationKey: 'operation',
    kind: 'process',
    requestHash: 'request',
    slotPathJson: f.slotPathJson,
    slotPathDigest: 'slot',
    candidateId: `agent:${f.runId}`,
    recoveryClass: 'managed-process-preactivation',
    classifierVersion: 'rfc397',
    transportPolicyVersion: 'rfc397',
    retryAuthority: 'none',
    resourceKeys: [`process:${f.taskId}`],
    now: 10,
    ...overrides,
  }
}
function claim(f: Fixture, sessionId = 'session', runId = f.runId) {
  return {
    protocol: 'opencode' as const,
    sessionId,
    taskId: f.taskId,
    nodeId: 'worker',
    currentNodeRunId: runId,
    leaseNonceDigest: `nonce-${runId}`,
    leasedAt: 20,
  }
}
function settled(f: Fixture, attempt: TaskEffectAttemptIdentity) {
  return {
    token: f.token,
    ...attempt,
    state: 'succeeded' as const,
    applicationEvidence: 'applied' as const,
    retryAuthority: 'none' as const,
    now: 30,
  }
}
function spawn(f: Fixture, attempt: TaskEffectAttemptIdentity) {
  return {
    token: f.token,
    ...attempt,
    nodeRunId: f.runId,
    pid: 397,
    spawnBinaryPath: '/rfc397/runtime',
    launchNonce: 'spawn-nonce',
    now: 30,
  }
}
async function owner(db: PersistenceDb, f: Fixture) {
  const { taskExecutionOwners } = tablesOf(db)
  return (
    await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, f.taskId))
  )[0]!
}
async function patch(db: PersistenceDb, f: Fixture) {
  expect(
    await new DrizzleNodeExecutionPersistence(db).patch({
      nodeRunId: f.runId,
      executionContext: f.context,
      values: { runtime: { pid: 123 } },
      now: 25,
    }),
  ).toBe(true)
}
async function snapshot(db: PersistenceDb) {
  const t = tablesOf(db)
  // Includes owner/intent, the failed attempt's fences/watermarks, and node output projections.
  const tables = [
    t.taskExecutionOwners,
    t.taskExecutionIntents,
    t.taskExecutionEffects,
    t.taskExecutionEffectAttempts,
    t.taskExecutionEffectFences,
    t.taskExecutionLineageOperationRecords,
    t.nodeRuns,
    t.nodeRunRuntimeStates,
    t.nodeRunConfigs,
    t.nodeRunOutputs,
  ]
  const result: unknown[] = []
  for (const table of tables) {
    const rows = await db.select().from(table)
    result.push(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  }
  return result
}
function assertSingleAttempt(recording: StatementRecording, ownerUpdate = true) {
  expect(recording.dispatched.filter((s) => /^begin\b/i.test(s.sql))).toHaveLength(1)
  expect(recording.dispatched.filter((s) => s.failedWith !== undefined)).toEqual([])
  if (ownerUpdate)
    expect(
      recording.dispatched.filter((s) =>
        normalized(s.sql).startsWith('update "task_execution_owners"'),
      ),
    ).toHaveLength(1)
  expect(
    recording.dispatched.some((s) => /set transaction isolation level serializable/i.test(s.sql)),
  ).toBe(false)
}
async function captured<T>(h: ProviderHarness, body: () => Promise<T>) {
  const recording = h.recordStatements()
  try {
    return { value: await body(), recording }
  } finally {
    recording.stop()
  }
}

/** One physical connection and ORM client belong exclusively to the tested call. */
async function dedicated(h: ProviderHarness) {
  const binding = h.applicationBinding
  if (binding.provider !== 'postgresql') throw new Error('PostgreSQL barrier requires PostgreSQL')
  const connection = await binding.runtime.providerPool().reserve()
  const [backend] = await connection.unsafe('select pg_backend_pid() as pid')
  await connection.unsafe("set statement_timeout = '10s'")
  let beforeBegin: ((ordinal: number) => Promise<void>) | undefined
  let ordinal = 0
  const reserved = {
    unsafe: connection.unsafe.bind(connection),
    release() {},
    async begin<T>(body: Parameters<typeof connection.begin<T>>[0]) {
      await beforeBegin?.(++ordinal)
      return connection.begin(body)
    },
  }
  const { runtime, recording } = recordPostgresqlStatements({
    ...binding.runtime,
    providerPool: () => ({
      unsafe: connection.unsafe.bind(connection),
      reserve: async () => reserved,
      close: async () => {},
    }),
  })
  return {
    db: createPostgresqlDatabaseClient(runtime),
    recording,
    pid: Number(backend!.pid),
    beforeBegin(callback: (ordinal: number) => Promise<void>) {
      beforeBegin = callback
    },
    async close() {
      recording.stop()
      await connection.unsafe('reset statement_timeout')
      connection.release()
    },
  }
}
type Dedicated = Awaited<ReturnType<typeof dedicated>>
function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type WaitPoint = 'owner-update' | 'owner-read' | 'family' | 'fence'
async function waitAt(h: ProviderHarness, client: Dedicated, point: WaitPoint) {
  const deadline = Date.now() + 8_000
  let last: unknown
  while (Date.now() < deadline) {
    const rows = (await rawRows(
      h.db,
      sql`select a.query, a.wait_event_type, a.wait_event,
      exists(select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'advisory' and not l.granted) as advisory
      from pg_stat_activity a where a.pid = ${client.pid}`,
    )) as {
      query: string
      wait_event_type: string | null
      wait_event: string | null
      advisory: boolean
    }[]
    last = rows
    const row = rows[0]
    if (row?.wait_event_type === 'Lock') {
      const query = normalized(row.query)
      const matches =
        point === 'family'
          ? row.advisory && query.includes('pg_advisory_xact_lock')
          : point === 'owner-update'
            ? query.startsWith('update "task_execution_owners"')
            : point === 'owner-read'
              ? query.includes('from "task_execution_owners"') && query.includes('for update')
              : query.includes('insert into "task_execution_effect_fences"')
      if (matches) return
    }
    await Bun.sleep(20)
  }
  throw new Error(`RFC-397 barrier did not reach ${point}: ${JSON.stringify(last)}`)
}
/** Real writer in an outer frame keeps its locks until the tested statement is observed waiting. */
async function race<T>(
  h: ProviderHarness,
  client: Dedicated,
  input: {
    competitor: (tx: PersistenceTx) => Promise<unknown>
    tested: () => Promise<T>
    point: WaitPoint
    afterBlocked?: (tx: PersistenceTx) => Promise<unknown>
  },
) {
  const ready = signal(),
    release = signal()
  const competing = databaseSessionFor(h.db).transaction(async (tx) => {
    await input.competitor(tx)
    ready.resolve()
    await release.promise
    await input.afterBlocked?.(tx)
  })
  // Attach handlers immediately: a domain rejection is an expected outcome in several races.
  const competingResult = competing.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  )
  let pending: Promise<{ value: T; error?: never } | { error: unknown; value?: never }> | undefined
  try {
    await Promise.race([
      ready.promise,
      competing.then(() => {
        throw new Error('competitor did not hold')
      }),
    ])
    pending = input.tested().then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    await waitAt(h, client, input.point)
    release.resolve()
    const result = await competingResult
    if (!result.ok) throw result.error
    return await pending
  } finally {
    release.resolve()
    await competingResult
    await pending
  }
}

const eqKinds = ['managed', 'close', 'recovered-close', 'code-host'] as const
type EqKind = (typeof eqKinds)[number]
async function seedQuiescence(
  h: ProviderHarness,
  kind: EqKind,
  f: Fixture,
  families = ['z', 'a'],
  generation = 0,
) {
  const prepared: (TaskEffectAttemptIdentity & { family: string; runId: string })[] = []
  for (const [index, family] of families.entries()) {
    const runId = `${f.runId}-${index}`
    await nodeRunFixture(h.db, {
      id: runId,
      taskId: f.taskId,
      nodeId: `node-${index}`,
      status: kind === 'code-host' ? 'interrupted' : 'done',
    })
    const descriptor = buildCodeHostRecoveryDescriptor(
      {
        provider: 'gitlab',
        action: 'comment.update',
        candidateId: 'comment.update:c0',
        method: 'PUT',
        pathname: '/projects/1/notes/1',
        query: {},
        body: { body: 'desired' },
        baseUrl: 'https://code.invalid',
      },
      runId,
    )
    const attempt = await effects(h.db).prepareAndAcquire(
      preparation(f, {
        operationFamilyKey: family,
        operationKey: `op-${family}`,
        operationGeneration: generation,
        kind: kind === 'code-host' ? 'code-host-mutation' : 'process',
        candidateId: kind === 'code-host' ? 'comment.update:c0:t1' : `agent:${runId}`,
        recoveryClass: kind === 'code-host' ? 'R-EXACT' : 'managed-process-preactivation',
        recoveryDescriptorJson: kind === 'code-host' ? JSON.stringify(descriptor) : null,
        resourceKeys: [`resource:${f.taskId}:${family}`],
      }),
    )
    prepared.push({ ...attempt, family, runId })
  }
  if (kind === 'recovered-close' || kind === 'code-host') {
    const { taskExecutionOwners } = tablesOf(h.db)
    await h.db
      .update(taskExecutionOwners)
      .set({ state: 'revoked' })
      .where(eq(taskExecutionOwners.taskId, f.taskId))
  }
  const current = await owner(h.db, f)
  const lockProof = createExclusiveDaemonLockProof({
    daemonGeneration: 'successor',
    acquiredAt: 40,
    lockReceiptDigest: 'lock-proof',
  })
  const proof = createVerifiedOutcomeUnknownClosure({
    taskId: f.taskId,
    epoch: f.token.epoch,
    ownerRevision: current.revision,
    quiescenceDigest: 'quiet',
    unresolvedEffectIds: prepared.map((p) => p.effectId),
    verifiedAt: 40,
  })
  const call = async (db: PersistenceDb): Promise<unknown> => {
    switch (kind) {
      case 'managed':
        return resolveQuiescedManagedProcesses(db, {
          authority: 'exact-stop',
          token: f.token,
          expectedRevision: current.revision,
          proof: createVerifiedStopProof({
            taskId: f.taskId,
            epoch: 1,
            ownerRevision: current.revision,
            evidenceDigest: 'quiet',
            verifiedAt: 40,
          }),
          quiescenceEvidenceDigest: 'quiet',
          now: 50,
        })
      case 'close':
        return closeOutcomeUnknownAndRelease(db, {
          token: f.token,
          intentId: f.intentId,
          proof,
          now: 50,
        })
      case 'recovered-close':
        return closeRecoveredOutcomeUnknownAndRelease(db, {
          owner: ownershipTuple(f.token),
          expectedRevision: current.revision,
          lockProof,
          proof,
          now: 50,
        })
      case 'code-host':
        return resolveQuiescedCodeHostMutations(db, {
          owner: ownershipTuple(f.token),
          expectedRevision: current.revision,
          lockProof,
          quiescenceEvidenceDigest: 'quiet',
          now: 50,
          resolutions: prepared.map((p) => ({
            effectId: p.effectId,
            attemptId: p.attemptId,
            nodeRunId: p.runId,
            outcome: 'applied',
            receiptJson: '{"probe":"applied"}',
            responseStatus: 200,
            responseBody: 'applied-output',
          })),
        })
    }
  }
  return { prepared, current, call }
}
function assertEqOrder(recording: StatementRecording, keys: string[]) {
  const statements = recording.dispatched
  const index = (pattern: RegExp) => statements.findIndex((s) => pattern.test(normalized(s.sql)))
  const ownerIndex = index(/from "task_execution_owners".*for update/)
  const rootIndex = index(/from "tasks".*for update/)
  const locks = statements.flatMap((s, i) =>
    /pg_advisory_xact_lock\(/.test(s.sql) ? [{ ...s, index: i }] : [],
  )
  const firstWrite = index(/^update "task_execution_effect(?:_attempts|s)"/)
  expect(ownerIndex).toBeGreaterThanOrEqual(0)
  expect(rootIndex).toBeGreaterThan(ownerIndex)
  expect(locks.map((s) => s.values[0])).toEqual([...new Set(keys)].sort())
  expect(locks[0]!.index).toBeGreaterThan(rootIndex)
  expect(firstWrite).toBeGreaterThan(locks.at(-1)!.index)
}

/** Trigger DDL is deliberately outside the transaction under test. */
async function trigger(
  h: ProviderHarness,
  table: string,
  pgBody: string,
  sqliteBody: string,
  when = '1',
) {
  const name = 'rfc397_inject'
  const pg = h.applicationBinding.provider === 'postgresql'
  if (pg) {
    await h.executeFixtureDdl(
      `create function public.${name}() returns trigger language plpgsql as $$ begin ${pgBody} end $$`,
    )
    await h.executeFixtureDdl(
      `create trigger ${name} before update on agent_workflow.${table} for each row execute function public.${name}()`,
    )
  } else {
    await h.executeFixtureDdl(
      `create trigger ${name} before update on ${table} when ${when} begin ${sqliteBody} end`,
    )
  }
  return async () => {
    await h.executeFixtureDdl(`drop trigger ${name}${pg ? ` on agent_workflow.${table}` : ''}`)
    if (pg) await h.executeFixtureDdl(`drop function public.${name}()`)
  }
}

describeEachProvider('RFC-397 functional contracts', (h) => {
  test('seven lease operations retain atomic semantics and use the aggregate isolation level', async () => {
    const f = await seed(h.db)
    await nodeRunFixture(h.db, {
      id: 'resume',
      taskId: f.taskId,
      nodeId: 'worker',
      status: 'running',
    })
    const steps: StatementRecording[] = []
    const run = async <T>(body: () => Promise<T>) => {
      const result = await captured(h, () => runWithTaskExecutionContext(f.context, body))
      steps.push(result.recording)
      return result.value
    }
    const token = await run(() => leases(h.db).claimNew(claim(f)))
    expect(await run(() => leases(h.db).release(token))).toBe(true)
    const resumed = await run(() =>
      leases(h.db).preclaimResume(claim(f, token.sessionId, 'resume')),
    )
    const update = steps
      .at(-1)!
      .dispatched.find((s) => normalized(s.sql).startsWith('update "runtime_session_leases"'))!
    const whereOffset = normalized(update.sql).indexOf(' where ')
    const where = normalized(update.sql).slice(whereOffset)
    for (const [column, expected] of [
      ['task_id', f.taskId],
      ['node_id', 'worker'],
      ['reset_pending', h.applicationBinding.provider === 'postgresql' ? false : 0],
    ] as const) {
      const match = new RegExp(`"${column}" = (\\$\\d+|\\?)`).exec(where)
      expect(match).not.toBeNull()
      const parameter = match![1]!
      const index = parameter.startsWith('$')
        ? Number(parameter.slice(1)) - 1
        : (normalized(update.sql)
            .slice(0, whereOffset + match!.index)
            .match(/\?/g)?.length ?? 0)
      expect(update.values[index]).toBe(expected)
    }
    expect(await run(() => leases(h.db).confirmResume(resumed))).toBe(true)
    expect(await run(() => leases(h.db).markResetPending(resumed))).toBe(true)
    const rotated = await run(() => leases(h.db).rotate(resumed, 'rotated'))
    const deletion = steps
      .at(-1)!
      .dispatched.find((s) => normalized(s.sql).startsWith('delete from "runtime_session_leases"'))!
    expect(normalized(deletion.sql)).toContain('returning')
    expect(normalized(deletion.sql)).toContain('"reset_pending"')
    expect(normalized(deletion.sql)).toContain('"leased_at" is not null')
    expect(await run(() => leases(h.db).discard(rotated))).toBe(true)
    for (const recording of steps) assertSingleAttempt(recording)
    if (h.applicationBinding.provider === 'sqlite')
      for (const recording of steps) expect(recording.dispatched[0]!.sql).toBe('BEGIN IMMEDIATE')
  })

  test.each([
    'prepareAndAcquire',
    'settle',
    'settleGateRollback',
    'settleCodeHostNode',
    'settleWorkspacePreparation',
    'recordProcessSpawn',
  ] as const)(
    '%s uses READ COMMITTED / BEGIN IMMEDIATE and advances the owner once',
    async (operation) => {
      const f = await seed(h.db)
      const attempt =
        operation === 'prepareAndAcquire'
          ? undefined
          : await effects(h.db).prepareAndAcquire(preparation(f))
      const before = await owner(h.db, f)
      const { recording } = await captured(h, async () => {
        switch (operation) {
          case 'prepareAndAcquire':
            return effects(h.db).prepareAndAcquire(preparation(f))
          case 'settle':
            return effects(h.db).settle(settled(f, attempt!))
          case 'recordProcessSpawn':
            return effects(h.db).recordProcessSpawn(spawn(f, attempt!))
          case 'settleGateRollback':
            return effects(h.db).settleGateRollback({
              token: f.token,
              ...attempt!,
              operationId: 'rollback',
              planDigest: 'plan',
              sourceNodeRunIds: [f.runId],
              outcome: {
                kind: 'completed',
                rolledBack: true,
                applicationEvidence: 'applied',
                receipt: {},
                successfulSourceNodeRunIds: [f.runId],
              },
            })
          case 'settleCodeHostNode':
            return effects(h.db).settleCodeHostNode({
              settlement: settled(f, attempt!),
              projection: {
                nodeRunId: f.runId,
                status: 'done',
                reason: 'done',
                finishedAt: 30,
                outputs: [{ portName: 'response', content: 'accepted' }],
              },
            })
          case 'settleWorkspacePreparation':
            return effects(h.db).settleWorkspacePreparation({
              settlement: settled(f, attempt!),
              projection: {
                taskId: f.taskId,
                prepNodeRunId: f.runId,
                finishedAt: 30,
                task: {
                  worktreePath: '/tmp/rfc397',
                  branch: 'main',
                  baseCommit: null,
                  repoPath: '',
                  repoUrl: null,
                  cachedRepoId: null,
                  baseBranch: 'main',
                  repoCount: 0,
                },
                repositories: [],
                nodePaths: [],
              },
            })
        }
      })
      assertSingleAttempt(recording)
      expect((await owner(h.db, f)).revision).toBe(before.revision + 1)
      if (h.applicationBinding.provider === 'sqlite')
        expect(recording.dispatched[0]!.sql).toBe('BEGIN IMMEDIATE')
    },
  )

  test.each(['duplicate', 'other-unique', 'lease-check'] as const)(
    'lease error mapping: %s',
    async (kind) => {
      const f = await seed(h.db)
      await nodeRunFixture(h.db, {
        id: 'other-run',
        taskId: f.taskId,
        nodeId: 'worker',
        status: 'running',
      })
      let cleanup = async () => {}
      const pg = h.applicationBinding.provider === 'postgresql'
      if (kind === 'duplicate') {
        await runWithTaskExecutionContext(f.context, () => leases(h.db).claimNew(claim(f)))
      } else {
        if (kind === 'other-unique') {
          await h.executeFixtureDdl('create table rfc397_other (id integer primary key)')
          await h.executeFixtureDdl('insert into rfc397_other values (1)')
        }
        if (pg) {
          await h.executeFixtureDdl(
            `create function public.rfc397_constraint() returns trigger language plpgsql as $$ begin ${kind === 'other-unique' ? 'insert into public.rfc397_other values (1);' : "raise exception 'CHECK constraint failed: runtime_session_leases.other' using errcode='23514', constraint='runtime_session_leases_other';"} return new; end $$`,
          )
          await h.executeFixtureDdl(
            'create trigger rfc397_constraint before insert on agent_workflow.runtime_session_leases for each row execute function public.rfc397_constraint()',
          )
        } else {
          await h.executeFixtureDdl(
            `create trigger rfc397_constraint before insert on runtime_session_leases begin ${kind === 'other-unique' ? 'insert into rfc397_other values (1);' : "select raise(abort, 'CHECK constraint failed: runtime_session_leases.other');"} end`,
          )
        }
        cleanup = async () => {
          await h.executeFixtureDdl(
            `drop trigger rfc397_constraint${pg ? ' on agent_workflow.runtime_session_leases' : ''}`,
          )
          if (pg) await h.executeFixtureDdl('drop function public.rfc397_constraint()')
          if (kind === 'other-unique') await h.executeFixtureDdl('drop table rfc397_other')
        }
      }
      const before = await snapshot(h.db)
      const recording = h.recordStatements()
      try {
        const error = await runWithTaskExecutionContext(f.context, () =>
          leases(h.db).claimNew(claim(f, 'session', 'other-run')),
        ).then(
          () => null,
          (e) => e as Error,
        )
        expect(error).not.toBeNull()
        if (kind === 'duplicate') expect(error).toMatchObject({ reason: 'owner-conflict' })
        else {
          expect(error).not.toHaveProperty('reason', 'owner-conflict')
          expect(statementFailureCode(error)).toBeDefined()
          expect(recording.dispatched.some((s) => s.failedWith !== undefined)).toBe(true)
        }
        expect(await snapshot(h.db)).toEqual(before)
      } finally {
        recording.stop()
        await cleanup()
      }
    },
  )

  test.each(['non-acting', 'zero-row', 'accepted'] as const)(
    'hosted receipt %s: CAS precedes projection and rolls back on refusal',
    async (mode) => {
      const f = await seed(h.db)
      const attempt = await effects(h.db).prepareAndAcquire(preparation(f))
      if (mode === 'non-acting')
        await effects(h.db).settle({
          ...settled(f, attempt),
          state: 'recovery-required',
          applicationEvidence: 'ambiguous',
        })
      let cleanup = async () => {}
      if (mode === 'zero-row')
        cleanup = await trigger(
          h,
          'task_execution_effect_attempts',
          `if new.id = '${attempt.attemptId}' then return null; end if; return new;`,
          'select raise(ignore);',
          `new.id = '${attempt.attemptId}'`,
        )
      const before = await snapshot(h.db)
      const hosted = createHostedProcessEffectProjection({
        db: h.db,
        request: {},
        fence: {
          current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
          assertHeld: async () => {},
        },
      })
      const recording = h.recordStatements()
      try {
        const promise = hosted.recordSpawnReceipt({
          ...spawn(f, attempt),
          runtimeParamsJson: '{"model":"hosted"}',
          receipt: {
            executionId: 'execution',
            businessTaskId: 'business',
            subtaskId: 'subtask',
            attempt: 1,
          },
        })
        if (mode === 'accepted') await promise
        else await expect(promise).rejects.toThrow('hosted-execution-owner-receipt-fenced')
        recording.stop()
        if (mode !== 'non-acting') {
          const update = recording.dispatched.find((s) =>
            normalized(s.sql).startsWith('update "task_execution_effect_attempts"'),
          )!
          const where = normalized(update.sql).split(' where ')[1]!
          for (const column of ['id', 'state', 'epoch']) expect(where).toContain(`"${column}"`)
          expect(update.values).toContain('acting')
          expect(update.values).toContain(f.token.epoch)
        }
        if (mode !== 'accepted') expect(await snapshot(h.db)).toEqual(before)
        else {
          assertSingleAttempt(recording)
          expect((await owner(h.db, f)).revision).toBe(f.token.ownerRevision + 2)
          const { nodeRunConfigs } = tablesOf(h.db)
          expect((await h.db.select().from(nodeRunConfigs))[0]!.runtimeParamsJson).toBe(
            '{"model":"hosted"}',
          )
        }
      } finally {
        recording.stop()
        await cleanup()
      }
    },
  )

  test.each(['code-host', 'workspace'] as const)(
    'settlement refuses a foreign %s task before taking its root',
    async (kind) => {
      const f = await seed(h.db),
        other = await seed(h.db, 'other')
      const attempt = await effects(h.db).prepareAndAcquire(preparation(f))
      const before = await snapshot(h.db)
      const recording = h.recordStatements()
      try {
        if (kind === 'code-host')
          await expect(
            effects(h.db).settleCodeHostNode({
              settlement: settled(f, attempt),
              projection: {
                nodeRunId: other.runId,
                status: 'done',
                reason: 'done',
                finishedAt: 30,
              },
            }),
          ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
        else
          await expect(
            effects(h.db).settleWorkspacePreparation({
              settlement: settled(f, attempt),
              projection: {
                taskId: other.taskId,
                prepNodeRunId: other.runId,
                finishedAt: 30,
                task: {
                  worktreePath: '/tmp',
                  branch: 'main',
                  baseCommit: null,
                  repoPath: '/tmp',
                  repoUrl: null,
                  cachedRepoId: null,
                  baseBranch: 'main',
                  repoCount: 0,
                },
                repositories: [],
                nodePaths: [],
              },
            }),
          ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
      } finally {
        recording.stop()
      }
      expect(
        recording.dispatched
          .filter((s) => /from "tasks".*for update/.test(normalized(s.sql)))
          .some((s) => s.values.includes(other.taskId)),
      ).toBe(false)
      expect(await snapshot(h.db)).toEqual(before)
    },
  )

  test.each(eqKinds)('EQ %s retains exact revision and functional settlement', async (kind) => {
    const f = await seed(h.db)
    const q = await seedQuiescence(h, kind, f)
    const result = await captured(h, () => q.call(h.db))
    assertSingleAttempt(result.recording, false)
    const { taskExecutionEffects, taskExecutionLineageOperationRecords } = tablesOf(h.db)
    expect(
      (await h.db.select().from(taskExecutionEffects)).every((row) => row.state !== 'open'),
    ).toBe(true)
    expect(
      (await h.db.select().from(taskExecutionLineageOperationRecords))
        .filter((row) => row.recordKind === 'generation-watermark')
        .map((row) => row.recordRevision),
    ).toEqual([1, 1])
    if (h.applicationBinding.provider === 'postgresql')
      assertEqOrder(
        result.recording,
        ['z', 'a'].map((key) => familyKey(f.lineage, key)),
      )
  })

  test.each(eqKinds)('EQ %s rejects a stale proof without writes', async (kind) => {
    const f = await seed(h.db),
      q = await seedQuiescence(h, kind, f)
    const { taskExecutionOwners } = tablesOf(h.db)
    await h.db
      .update(taskExecutionOwners)
      .set({ revision: q.current.revision + 1 })
      .where(eq(taskExecutionOwners.taskId, f.taskId))
    const before = await snapshot(h.db)
    await expect(q.call(h.db)).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
    expect(await snapshot(h.db)).toEqual(before)
  })

  test('dispatch recording keeps failed statements and BEGIN alongside the success-only view', async () => {
    const recording = h.recordStatements()
    try {
      await expect(
        h.session.transaction(async (tx) => {
          await rawRows(tx, sql`select 397 as value`)
          await rawRows(tx, sql`select * from rfc397_missing_table`)
        }),
      ).rejects.toThrow()
    } finally {
      recording.stop()
    }
    expect(recording.dispatched.filter((s) => /^begin\b/i.test(s.sql))).toHaveLength(1)
    expect(recording.statements.some((s) => s.sql.includes('rfc397_missing_table'))).toBe(false)
    expect(
      recording.dispatched.find((s) => s.sql.includes('rfc397_missing_table'))?.failedWith,
    ).toBeDefined()
    expect(
      statementFailureCode({ cause: { errno: '40P01', code: 'ERR_POSTGRES_SERVER_ERROR' } }),
    ).toBe('40P01')
  })
})

// Driver-boundary fixture only: it proves the recorder itself without claiming PostgreSQL execution.
test.each(['BEGIN', 'statement', 'values', 'COMMIT', 'SAVEPOINT', 'RELEASE SAVEPOINT'] as const)(
  'dispatch recorder retains %s failure before the driver returns',
  async (phase) => {
    const code = phase === 'COMMIT' ? '40001' : '40P01'
    const failure = new Error('RFC-397 driver failure', {
      cause: phase === 'COMMIT' ? { code } : { errno: code },
    })
    const transaction: PostgresqlTransactionConnection = {
      unsafe(query) {
        expect(recording.dispatched.at(-1)?.sql).toBe(query)
        const pending =
          phase === 'statement' || phase === 'values'
            ? Promise.reject(failure)
            : Promise.resolve([])
        return Object.assign(pending, { values: async () => await pending })
      },
      async savepoint(body) {
        expect(recording.dispatched.at(-1)?.sql).toBe('SAVEPOINT')
        if (phase === 'SAVEPOINT') throw failure
        const value = await body(transaction)
        expect(recording.dispatched.at(-1)?.sql).toBe('RELEASE SAVEPOINT')
        if (phase === 'RELEASE SAVEPOINT') throw failure
        return value
      },
    }
    const pool: PostgresqlPool = {
      unsafe: transaction.unsafe,
      reserve: async () => ({
        unsafe: transaction.unsafe,
        release() {},
        async begin(body) {
          expect(recording.dispatched.at(-1)?.sql).toBe('BEGIN')
          if (phase === 'BEGIN') throw failure
          const value = await body(transaction)
          expect(recording.dispatched.at(-1)?.sql).toBe('COMMIT')
          if (phase === 'COMMIT') throw failure
          return value
        },
      }),
      close: async () => {},
    }
    const source = createPostgresqlDatabaseRuntime({
      config: {
        provider: 'postgresql',
        urlEnv: 'RFC397_RECORDER_URL',
        poolMax: 1,
        connectTimeoutMs: 1_000,
        statementTimeoutMs: 1_000,
        idleTimeoutMs: 1_000,
      },
      generationId: 'dbg_rfc397_recorder',
      env: { RFC397_RECORDER_URL: 'postgresql://fixture:fixture@localhost/fixture' },
      poolFactory: () => pool,
    })
    const probe = recordPostgresqlStatements(source)
    const { recording } = probe
    const connection = await probe.runtime.providerPool().reserve()
    try {
      const result = await connection
        .begin(async (tx) => {
          if (phase === 'SAVEPOINT' || phase === 'RELEASE SAVEPOINT')
            await tx.savepoint(async () => {})
          else if (phase === 'values') await tx.unsafe('select 397').values()
          else await tx.unsafe('select 397')
        })
        .catch((error: unknown) => error)
      expect(result).toBe(failure)
      const failedSql = phase === 'statement' || phase === 'values' ? 'select 397' : phase
      expect(recording.dispatched.filter((entry) => entry.failedWith !== undefined)).toEqual([
        { sql: failedSql, values: [], failedWith: code },
      ])
      expect(recording.statements.some((entry) => entry.sql === failedSql)).toBe(false)
      expect(recording.dispatched.filter((entry) => entry.sql === 'BEGIN')).toHaveLength(1)
    } finally {
      recording.stop()
      connection.release()
      await source.close()
    }
  },
)

const pgProviders = resolveTestProviders(process.env).filter((p) => p === 'postgresql')
describeEachProvider(
  'RFC-397 PostgreSQL deterministic interleavings',
  (h) => {
    test.each(['claimNew', 'prepareAndAcquire', 'settle', 'recordProcessSpawn'] as const)(
      '%s waits at the owner UPDATE and completes on its first attempt',
      async (operation) => {
        const f = await seed(h.db)
        const attempt =
          operation === 'settle' || operation === 'recordProcessSpawn'
            ? await effects(h.db).prepareAndAcquire(preparation(f))
            : undefined
        // §4.2: patch must create the companion that claimNew will subsequently update.
        const { nodeRunRuntimeStates } = tablesOf(h.db)
        await h.db.delete(nodeRunRuntimeStates).where(eq(nodeRunRuntimeStates.nodeRunId, f.runId))
        const client = await dedicated(h)
        try {
          const result = await race(h, client, {
            competitor: (tx) => patch(tx, f),
            point: 'owner-update',
            tested: async () => {
              switch (operation) {
                case 'claimNew':
                  return runWithTaskExecutionContext(f.context, () =>
                    leases(client.db).claimNew(claim(f)),
                  )
                case 'prepareAndAcquire':
                  return effects(client.db).prepareAndAcquire(preparation(f))
                case 'settle':
                  return effects(client.db).settle(settled(f, attempt!))
                case 'recordProcessSpawn':
                  return effects(client.db).recordProcessSpawn(spawn(f, attempt!))
              }
            },
          })
          expect(result.error).toBeUndefined()
          assertSingleAttempt(client.recording)
          if (operation === 'claimNew')
            expect(
              (
                await h.db
                  .select()
                  .from(nodeRunRuntimeStates)
                  .where(eq(nodeRunRuntimeStates.nodeRunId, f.runId))
              )[0],
            ).toMatchObject({ pid: 123, sessionId: 'session' })
        } finally {
          await client.close()
        }
      },
      30_000,
    )

    test('preclaimResume sees the terminal transition committed while it waited at the fence', async () => {
      const f = await seed(h.db)
      const token = await runWithTaskExecutionContext(f.context, () =>
        leases(h.db).claimNew(claim(f)),
      )
      await runWithTaskExecutionContext(f.context, () => leases(h.db).release(token))
      await nodeRunFixture(h.db, {
        id: 'resume',
        taskId: f.taskId,
        nodeId: 'worker',
        status: 'running',
      })
      const client = await dedicated(h)
      try {
        const result = await race(h, client, {
          competitor: (tx) =>
            new DrizzleNodeRunLifecyclePersistence(tx).set({
              nodeRunId: 'resume',
              to: 'done',
              allowedFrom: ['running'],
              reason: 'finished',
              executionContext: f.context,
            }),
          point: 'owner-update',
          tested: () =>
            runWithTaskExecutionContext(f.context, () =>
              leases(client.db).preclaimResume(claim(f, 'session', 'resume')),
            ),
        })
        expect(result.error).toMatchObject({ reason: 'run-not-claimable' })
        assertSingleAttempt(client.recording)
        expect((await leases(h.db).load('opencode', 'session'))!.leaseNodeRunId).toBeNull()
      } finally {
        await client.close()
      }
    }, 30_000)

    test.each(['confirmResume', 'rotate', 'markResetPending'] as const)(
      '%s rechecks the lease changed after its pre-fence read',
      async (operation) => {
        const f = await seed(h.db)
        let token = await runWithTaskExecutionContext(f.context, () =>
          leases(h.db).claimNew(claim(f)),
        )
        if (operation === 'confirmResume') {
          await runWithTaskExecutionContext(f.context, () => leases(h.db).release(token))
          await nodeRunFixture(h.db, {
            id: 'resume',
            taskId: f.taskId,
            nodeId: 'worker',
            status: 'running',
          })
          token = await runWithTaskExecutionContext(f.context, () =>
            leases(h.db).preclaimResume(claim(f, 'session', 'resume')),
          )
        } else
          await runWithTaskExecutionContext(f.context, () => leases(h.db).markResetPending(token))
        const client = await dedicated(h)
        try {
          const result = await race(h, client, {
            competitor: (tx) => patch(tx, f),
            point: 'owner-update',
            afterBlocked: (tx) =>
              runWithTaskExecutionContext(f.context, () =>
                operation === 'confirmResume'
                  ? leases(tx).release(token)
                  : leases(tx).discard(token),
              ),
            tested: () =>
              runWithTaskExecutionContext(f.context, async () =>
                operation === 'rotate'
                  ? leases(client.db).rotate(token, 'next')
                  : leases(client.db)[operation](token),
              ),
          })
          expect(result.error).toMatchObject({ reason: 'lease-mismatch' })
          assertSingleAttempt(client.recording)
          const { nodeRunRuntimeStates } = tablesOf(h.db)
          const [runtime] = await h.db
            .select()
            .from(nodeRunRuntimeStates)
            .where(eq(nodeRunRuntimeStates.nodeRunId, token.nodeRunId))
          expect(runtime?.sessionId ?? null).toBeNull()
          expect(await leases(h.db).load('opencode', 'next')).toBeUndefined()
          if (operation === 'confirmResume')
            expect(
              client.recording.dispatched.some((s) =>
                /from "runtime_session_leases".*for update/.test(normalized(s.sql)),
              ),
            ).toBe(true)
        } finally {
          await client.close()
        }
      },
      30_000,
    )

    test('two tasks preparing one family serialize at the advisory lock and return a typed conflict', async () => {
      const a = await seed(h.db, 'a'),
        b = await seed(h.db, 'b')
      const client = await dedicated(h)
      try {
        const result = await race(h, client, {
          competitor: (tx) => effects(tx).prepareAndAcquire(preparation(a)),
          point: 'family',
          tested: () => effects(client.db).prepareAndAcquire(preparation(b)),
        })
        expect(result.error).toMatchObject({ code: 'task-continuation-conflict' })
        assertSingleAttempt(client.recording)
        expect(await h.db.select().from(tablesOf(h.db).taskExecutionEffects)).toHaveLength(1)
      } finally {
        await client.close()
      }
    }, 30_000)

    for (const kind of eqKinds) {
      test(`EQ ${kind} waits at the family lock, reads all resolutions first, and starts once`, async () => {
        const f = await seed(h.db),
          q = await seedQuiescence(h, kind, f)
        const client = await dedicated(h)
        try {
          const result = await race(h, client, {
            competitor: (tx) =>
              lockEffectFamiliesTx(tx, [preparation(f, { operationFamilyKey: 'a' })]),
            point: 'family',
            tested: () => q.call(client.db),
          })
          expect(result.error).toBeUndefined()
          assertSingleAttempt(client.recording, false)
          assertEqOrder(
            client.recording,
            ['a', 'z'].map((family) => familyKey(f.lineage, family)),
          )
          if (kind === 'code-host') {
            const firstLock = client.recording.dispatched.findIndex((s) =>
              /pg_advisory_xact_lock/.test(s.sql),
            )
            for (const p of q.prepared)
              expect(
                client.recording.dispatched
                  .slice(0, firstLock)
                  .some(
                    (s) =>
                      /from "task_execution_effect_attempts"/.test(normalized(s.sql)) &&
                      s.values.includes(p.attemptId),
                  ),
              ).toBe(true)
          }
        } finally {
          await client.close()
        }
      }, 30_000)

      for (const failAt of [1, 2])
        test(`EQ ${kind} replays 40P01 at attempt UPDATE ${failAt} with no partial writes`, async () => {
          const f = await seed(h.db),
            q = await seedQuiescence(h, kind, f)
          const before = await snapshot(h.db)
          await h.executeFixtureDdl('create sequence public.rfc397_once')
          const cleanup = await trigger(
            h,
            'task_execution_effect_attempts',
            `if nextval('public.rfc397_once') = ${failAt} then raise exception 'RFC-397 one-shot deadlock' using errcode='40P01'; end if; return new;`,
            '',
          )
          const client = await dedicated(h)
          let rollbackObserved = false
          client.beforeBegin(async (ordinal) => {
            if (ordinal === 2) {
              expect(await snapshot(h.db)).toEqual(before)
              rollbackObserved = true
            }
          })
          try {
            await q.call(client.db)
            expect(rollbackObserved).toBe(true)
            expect(client.recording.dispatched.filter((s) => /^begin$/i.test(s.sql))).toHaveLength(
              2,
            )
            expect(
              client.recording.dispatched
                .filter((s) => s.failedWith !== undefined)
                .map((s) => s.failedWith),
            ).toEqual(['40P01'])
            const failedIndex = client.recording.dispatched.findIndex(
              (s) => s.failedWith === '40P01',
            )
            const failedWrites = client.recording.dispatched.slice(0, failedIndex)
            if (failAt === 2) {
              for (const table of ['task_execution_effects', 'task_execution_effect_fences'])
                expect(
                  failedWrites.some((s) => normalized(s.sql).startsWith(`update "${table}"`)),
                ).toBe(true)
              expect(
                failedWrites.some((s) =>
                  normalized(s.sql).includes(
                    'insert into "task_execution_lineage_operation_records"',
                  ),
                ),
              ).toBe(true)
              if (kind === 'code-host')
                expect(
                  failedWrites.some((s) =>
                    normalized(s.sql).includes('insert into "node_run_outputs"'),
                  ),
                ).toBe(true)
            }
            const {
              taskExecutionLineageOperationRecords,
              taskExecutionEffects,
              taskExecutionEffectFences,
              nodeRunOutputs,
            } = tablesOf(h.db)
            const watermarks = await h.db
              .select()
              .from(taskExecutionLineageOperationRecords)
              .where(eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'))
            expect(watermarks).toHaveLength(2)
            expect(watermarks.map((row) => row.recordRevision)).toEqual([1, 1])
            expect(
              (await h.db.select().from(taskExecutionEffects)).every((row) => row.state !== 'open'),
            ).toBe(true)
            expect(
              (await h.db.select().from(taskExecutionEffectFences)).every(
                (row) => row.releasedAt === 50,
              ),
            ).toBe(true)
            expect((await owner(h.db, f)).revision).toBe(
              q.current.revision + (kind.includes('close') ? 1 : 0),
            )
            expect(await h.db.select().from(nodeRunOutputs)).toHaveLength(
              kind === 'code-host' ? 4 : 0,
            )
          } finally {
            await client.close()
            await cleanup()
            await h.executeFixtureDdl('drop sequence public.rfc397_once')
          }
        }, 30_000)

      for (const first of ['settle', 'eq'] as const)
        test(`settle and EQ ${kind}: ${first} commits first in the same family`, async () => {
          const a = await seed(h.db, 'a'),
            b = await seed(h.db, 'b')
          let settleCall: (db: PersistenceDb) => Promise<unknown>
          let q: Awaited<ReturnType<typeof seedQuiescence>>
          if (first === 'settle') {
            const prepared = await effects(h.db).prepareAndAcquire(preparation(a))
            settleCall = (db) => effects(db).settle(settled(a, prepared))
            q = await seedQuiescence(h, kind, b, ['family'], 1)
          } else {
            q = await seedQuiescence(h, kind, a, ['family'])
            const prepared = await effects(h.db).prepareAndAcquire(
              preparation(b, { operationGeneration: 1 }),
            )
            settleCall = (db) => effects(db).settle(settled(b, prepared))
          }
          const client = await dedicated(h)
          try {
            const result = await race(h, client, {
              competitor: (tx) => (first === 'settle' ? settleCall(tx) : q.call(tx)),
              point: 'family',
              tested: () => (first === 'settle' ? q.call(client.db) : settleCall(client.db)),
            })
            expect(result.error).toBeUndefined()
            assertSingleAttempt(client.recording, first === 'eq')
            const records = await h.db
              .select()
              .from(tablesOf(h.db).taskExecutionLineageOperationRecords)
            expect(records.filter((r) => r.recordKind === 'generation-watermark')).toMatchObject([
              { highestSettledGeneration: 1, recordRevision: 2 },
            ])
          } finally {
            await client.close()
          }
        }, 30_000)
    }

    test('different families sharing a fence key finish after the release commits', async () => {
      const a = await seed(h.db, 'a'),
        b = await seed(h.db, 'b')
      const held = await effects(h.db).prepareAndAcquire(
        preparation(a, { resourceKeys: ['shared-fence'] }),
      )
      const client = await dedicated(h)
      try {
        const result = await race(h, client, {
          competitor: (tx) => effects(tx).settle(settled(a, held)),
          point: 'fence',
          tested: () =>
            effects(client.db).prepareAndAcquire(
              preparation(b, { operationFamilyKey: 'other', resourceKeys: ['shared-fence'] }),
            ),
        })
        expect(result.error).toBeUndefined()
        assertSingleAttempt(client.recording)
        const fences = await h.db.select().from(tablesOf(h.db).taskExecutionEffectFences)
        expect(fences.filter((row) => row.releasedAt === null)).toHaveLength(1)
        expect(fences.filter((row) => row.releasedAt !== null)).toHaveLength(1)
      } finally {
        await client.close()
      }
    }, 30_000)

    test('EQ two-family settlements take the same sorted locks despite reversed input order', async () => {
      const a = await seed(h.db, 'a'),
        b = await seed(h.db, 'b')
      const left = await seedQuiescence(h, 'code-host', a, ['z', 'a'])
      const right = await seedQuiescence(h, 'code-host', b, ['a', 'z'], 1)
      const client = await dedicated(h)
      try {
        const result = await race(h, client, {
          competitor: (tx) => left.call(tx),
          point: 'family',
          tested: () => right.call(client.db),
        })
        expect(result.error).toBeUndefined()
        assertSingleAttempt(client.recording, false)
        assertEqOrder(
          client.recording,
          ['a', 'z'].map((family) => familyKey(a.lineage, family)),
        )
        const records = await h.db
          .select()
          .from(tablesOf(h.db).taskExecutionLineageOperationRecords)
        expect(records).toHaveLength(2)
        expect(
          records.every((row) => row.highestSettledGeneration === 1 && row.recordRevision === 2),
        ).toBe(true)
      } finally {
        await client.close()
      }
    }, 30_000)

    test('retry-authorized settlement waits on the family before its first UPDATE or fence release', async () => {
      const a = await seed(h.db, 'a'),
        b = await seed(h.db, 'b')
      const held = await effects(h.db).prepareAndAcquire(preparation(a))
      const client = await dedicated(h)
      try {
        const result = await race(h, client, {
          competitor: (tx) =>
            effects(tx).prepareAndAcquire(preparation(b, { operationGeneration: 1 })),
          point: 'family',
          tested: () =>
            effects(client.db).settle({
              ...settled(a, held),
              state: 'retry-authorized',
              applicationEvidence: 'definitely-not-applied',
              retryAuthority: 'probe',
            }),
        })
        expect(result.error).toBeUndefined()
        assertSingleAttempt(client.recording)
        const statements = client.recording.dispatched
        const lock = statements.findIndex((s) => /pg_advisory_xact_lock/.test(s.sql))
        for (const table of ['task_execution_effect_attempts', 'task_execution_effect_fences'])
          expect(
            statements.findIndex((s) => normalized(s.sql).startsWith(`update "${table}"`)),
          ).toBeGreaterThan(lock)
        const { taskExecutionEffects, taskExecutionEffectAttempts } = tablesOf(h.db)
        expect(
          (
            await h.db
              .select()
              .from(taskExecutionEffects)
              .where(eq(taskExecutionEffects.id, held.effectId))
          )[0]!.state,
        ).toBe('open')
        expect(
          (
            await h.db
              .select()
              .from(taskExecutionEffectAttempts)
              .where(eq(taskExecutionEffectAttempts.id, held.attemptId))
          )[0]!.state,
        ).toBe('retry-authorized')
      } finally {
        await client.close()
      }
    }, 30_000)

    test('family helper de-duplicates and sorts the full lineage/family key', async () => {
      const result = await captured(h, () =>
        h.session.transaction((tx) =>
          lockEffectFamiliesTx(tx, [
            { executionLineageId: 'z', operationFamilyKey: 'a' },
            { executionLineageId: 'a', operationFamilyKey: 'z' },
            { executionLineageId: 'z', operationFamilyKey: 'a' },
          ]),
        ),
      )
      expect(
        result.recording.dispatched
          .filter((s) => /pg_advisory_xact_lock\(/.test(s.sql))
          .map((s) => s.values[0]),
      ).toEqual([familyKey('a', 'z'), familyKey('z', 'a')])
    })
  },
  { providers: pgProviders },
)
