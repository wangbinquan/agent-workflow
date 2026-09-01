// RFC-349 T10-C — real PostgreSQL target faults. Ordinary backend runs skip
// this file; postgresql-evidence.yml supplies one disposable external server.

import { describe, expect, test } from 'bun:test'

import { classifyDatabaseMigrationFailure } from '@/modules/system-operations/application/databaseMigrationRunner'
import {
  createLogicalTableChunk,
  encodeLogicalRow,
  type LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import {
  openPostgresqlLogicalTarget,
  PostgresqlLogicalTargetError,
  type PostgresqlLogicalTarget,
} from '@/platform/persistence/postgresqlLogicalTarget'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlDatabaseRuntime,
  type PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  buildLogicalSchemaContract,
  type LogicalSchemaContract,
  type LogicalTableContract,
} from '@/platform/persistence/schemaContract'

const realTest = process.env.RFC349_TARGET_FAULTS_DATABASE_URL === undefined ? test.skip : test
const OPERATION_ID = 'dbm_real_target_faults_01'
const SOURCE_GENERATION_ID = 'dbg_real_target_faults_source_01'
const TARGET_TABLE = 'agent_workflow.agents'
const RECEIPT_TABLE = 'agent_workflow_meta.logical_copy_chunks'

function databaseConfig(statementTimeoutMs: number) {
  return {
    provider: 'postgresql' as const,
    urlEnv: 'RFC349_TARGET_FAULTS_DATABASE_URL',
    poolMax: 6,
    connectTimeoutMs: 5_000,
    statementTimeoutMs,
    idleTimeoutMs: 30_000,
  }
}

function errorCodes(error: unknown): readonly string[] {
  const codes: string[] = []
  const seen = new Set<object>()
  let current = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if (
      'sqlState' in current &&
      (typeof current.sqlState === 'string' || typeof current.sqlState === 'number')
    ) {
      codes.push(String(current.sqlState).toUpperCase())
    }
    if (
      'code' in current &&
      (typeof current.code === 'string' || typeof current.code === 'number')
    ) {
      codes.push(String(current.code).toUpperCase())
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return codes
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('expected the real PostgreSQL target operation to fail')
}

function agentChunk(input: {
  readonly contract: LogicalSchemaContract
  readonly table: LogicalTableContract
  readonly chunkIndex: number
  readonly id: string
  readonly name: string
}): LogicalTableChunk {
  const timestamp = 1_800_000_000_000 + input.chunkIndex
  return createLogicalTableChunk({
    operationId: OPERATION_ID,
    contract: input.contract,
    table: input.table,
    chunkIndex: input.chunkIndex,
    rows: [
      encodeLogicalRow(input.table, {
        id: input.id,
        name: input.name,
        description: 'RFC-349 real target fault fixture',
        outputs: '[]',
        inputs: '[]',
        sync_outputs_on_iterate: true,
        runtime: null,
        permission: '{}',
        skills: '[]',
        depends_on: '[]',
        mcp: '[]',
        plugins: '[]',
        frontmatter_extra: '{}',
        body_md: '',
        owner_user_id: null,
        visibility: 'public',
        acl_revision: 0,
        builtin: false,
        schema_version: 1,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    ],
  })
}

async function copyState(
  runtime: PostgresqlDatabaseRuntime,
  chunk: LogicalTableChunk,
): Promise<{ readonly rows: number; readonly receipts: number }> {
  const key = chunk.payload.rows[0]!.key[0]!
  if (key.type !== 'text') throw new Error('RFC-349 agents migration key is not text')
  const rowCount = await runtime
    .providerPool()
    .unsafe(`SELECT count(*) AS count FROM ${TARGET_TABLE} WHERE id = $1`, [key.value])
  const receiptCount = await runtime
    .providerPool()
    .unsafe(
      `SELECT count(*) AS count FROM ${RECEIPT_TABLE} WHERE operation_id = $1 AND table_id = $2 AND chunk_index = $3`,
      [OPERATION_ID, chunk.payload.table, chunk.payload.chunkIndex],
    )
  return {
    rows: Number(rowCount[0]?.count ?? -1),
    receipts: Number(receiptCount[0]?.count ?? -1),
  }
}

async function assertRolledBack(
  runtime: PostgresqlDatabaseRuntime,
  chunk: LogicalTableChunk,
): Promise<void> {
  expect(await copyState(runtime, chunk)).toEqual({ rows: 0, receipts: 0 })
}

async function retryAndAssertCommitted(
  target: PostgresqlLogicalTarget,
  runtime: PostgresqlDatabaseRuntime,
  table: LogicalTableContract,
  chunk: LogicalTableChunk,
): Promise<void> {
  await target.copyChunk(table, chunk, Date.now())
  expect(await copyState(runtime, chunk)).toEqual({ rows: 1, receipts: 1 })
  await target.copyChunk(table, chunk, Date.now())
  expect(await copyState(runtime, chunk)).toEqual({ rows: 1, receipts: 1 })
}

async function installTrigger(
  runtime: PostgresqlDatabaseRuntime,
  input: { readonly functionName: string; readonly body: string },
): Promise<void> {
  await runtime.providerPool().unsafe(`
    CREATE OR REPLACE FUNCTION agent_workflow_meta.${input.functionName}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      ${input.body}
      RETURN NEW;
    END
    $function$
  `)
  await runtime.providerPool().unsafe(`
    CREATE TRIGGER ${input.functionName}
    BEFORE INSERT ON ${TARGET_TABLE}
    FOR EACH ROW
    EXECUTE FUNCTION agent_workflow_meta.${input.functionName}()
  `)
}

async function removeTrigger(
  runtime: PostgresqlDatabaseRuntime,
  functionName: string,
): Promise<void> {
  await runtime.providerPool().unsafe(`DROP TRIGGER IF EXISTS ${functionName} ON ${TARGET_TABLE}`)
  await runtime
    .providerPool()
    .unsafe(`DROP FUNCTION IF EXISTS agent_workflow_meta.${functionName}()`)
}

async function openTarget(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly contract: LogicalSchemaContract
}): Promise<PostgresqlLogicalTarget> {
  const plan = buildPostgresqlSchemaPlan(input.contract)
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await openPostgresqlLogicalTarget({
        runtime: input.runtime,
        operationId: OPERATION_ID,
        sourceGenerationId: SOURCE_GENERATION_ID,
        contract: input.contract,
        plan,
      })
    } catch (error) {
      lastError = error
      if (
        !(error instanceof PostgresqlLogicalTargetError) ||
        error.code !== 'postgresql-target-lock-held'
      ) {
        throw error
      }
      await Bun.sleep(25)
    }
  }
  throw lastError
}

async function waitForTargetLockWait(runtime: PostgresqlDatabaseRuntime): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await runtime.providerPool().unsafe(`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query LIKE 'INSERT INTO "agent_workflow"."agents"%'
    `)
    if (rows.length > 0) return
    await Bun.sleep(10)
  }
  throw new Error('target copy never reached the real PostgreSQL deadlock wait')
}

async function release(connection: PostgresqlReservedConnection): Promise<void> {
  try {
    await connection.unsafe('ROLLBACK')
  } finally {
    connection.release()
  }
}

describe('RFC-349 real PostgreSQL target fault/resume matrix', () => {
  realTest(
    'disconnect, timeout, deadlock, constraint and storage faults roll back row plus receipt before exact resume',
    async () => {
      const contract = buildLogicalSchemaContract()
      const table = contract.tables.find((candidate) => candidate.id === 'agents')
      if (table === undefined) throw new Error('RFC-349 contract has no agents table')

      const targetRuntime = createPostgresqlDatabaseRuntime({
        config: databaseConfig(1_000),
        generationId: 'dbg_real_target_faults_01',
      })
      const adminRuntime = createPostgresqlDatabaseRuntime({
        config: databaseConfig(30_000),
        generationId: 'dbg_real_target_faults_admin_01',
      })
      let target: PostgresqlLogicalTarget | null = null

      try {
        await adminRuntime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await adminRuntime
          .providerPool()
          .unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        target = await openTarget({ runtime: targetRuntime, contract })
        await target.prepare(Date.now())

        const disconnect = agentChunk({
          contract,
          table,
          chunkIndex: 0,
          id: 'agt_fault_disconnect',
          name: 'disconnect-fault',
        })
        await installTrigger(adminRuntime, {
          functionName: 'rfc349_fault_disconnect',
          body: 'PERFORM pg_terminate_backend(pg_backend_pid());',
        })
        const disconnectError = await captureFailure(
          target.copyChunk(table, disconnect, Date.now()),
        )
        expect(classifyDatabaseMigrationFailure(disconnectError, 'copying')).toMatchObject({
          category: 'copy-transient',
          retryable: true,
        })
        await removeTrigger(adminRuntime, 'rfc349_fault_disconnect')
        await assertRolledBack(adminRuntime, disconnect)
        await target.close().catch(() => undefined)
        target = await openTarget({ runtime: targetRuntime, contract })
        await target.prepare(Date.now())
        await retryAndAssertCommitted(target, adminRuntime, table, disconnect)

        const timeout = agentChunk({
          contract,
          table,
          chunkIndex: 1,
          id: 'agt_fault_timeout',
          name: 'timeout-fault',
        })
        await installTrigger(adminRuntime, {
          functionName: 'rfc349_fault_timeout',
          body: `
            IF NEW.id = 'agt_fault_timeout' THEN
              PERFORM pg_sleep(5);
            END IF;
          `,
        })
        const timeoutError = await captureFailure(target.copyChunk(table, timeout, Date.now()))
        expect(errorCodes(timeoutError)).toContain('57014')
        expect(classifyDatabaseMigrationFailure(timeoutError, 'copying')).toMatchObject({
          category: 'copy-transient',
          retryable: true,
        })
        await removeTrigger(adminRuntime, 'rfc349_fault_timeout')
        await assertRolledBack(adminRuntime, timeout)
        await retryAndAssertCommitted(target, adminRuntime, table, timeout)

        await adminRuntime.providerPool().unsafe(`
          CREATE TABLE agent_workflow_meta.rfc349_fault_locks (
            id integer PRIMARY KEY,
            value integer NOT NULL
          )
        `)
        await adminRuntime
          .providerPool()
          .unsafe('INSERT INTO agent_workflow_meta.rfc349_fault_locks VALUES (1, 0), (2, 0)')
        const deadlock = agentChunk({
          contract,
          table,
          chunkIndex: 2,
          id: 'agt_fault_deadlock',
          name: 'deadlock-fault',
        })
        await installTrigger(adminRuntime, {
          functionName: 'rfc349_fault_deadlock',
          body: `
            IF NEW.id = 'agt_fault_deadlock' THEN
              PERFORM set_config('deadlock_timeout', '100ms', true);
              UPDATE agent_workflow_meta.rfc349_fault_locks SET value = value + 1 WHERE id = 1;
              UPDATE agent_workflow_meta.rfc349_fault_locks SET value = value + 1 WHERE id = 2;
            END IF;
          `,
        })
        const blocker = await adminRuntime.providerPool().reserve()
        await blocker.unsafe("SET deadlock_timeout = '10s'")
        await blocker.unsafe('BEGIN')
        await blocker.unsafe(
          'UPDATE agent_workflow_meta.rfc349_fault_locks SET value = value + 1 WHERE id = 2',
        )
        let deadlockError: unknown
        try {
          const deadlockCopy = target.copyChunk(table, deadlock, Date.now())
          await waitForTargetLockWait(adminRuntime)
          const competingUpdate = (async () =>
            await blocker.unsafe(
              'UPDATE agent_workflow_meta.rfc349_fault_locks SET value = value + 1 WHERE id = 1',
            ))()
          deadlockError = await captureFailure(deadlockCopy)
          await competingUpdate
        } finally {
          await release(blocker)
        }
        expect(errorCodes(deadlockError)).toContain('40P01')
        expect(classifyDatabaseMigrationFailure(deadlockError, 'copying')).toMatchObject({
          category: 'copy-transient',
          retryable: true,
        })
        await removeTrigger(adminRuntime, 'rfc349_fault_deadlock')
        await assertRolledBack(adminRuntime, deadlock)
        await retryAndAssertCommitted(target, adminRuntime, table, deadlock)

        const constraint = agentChunk({
          contract,
          table,
          chunkIndex: 3,
          id: 'agt_fault_constraint',
          name: 'constraint-fault',
        })
        await adminRuntime.providerPool().unsafe(`
          ALTER TABLE ${TARGET_TABLE}
          ADD CONSTRAINT rfc349_fault_constraint CHECK (name <> 'constraint-fault')
        `)
        const constraintError = await captureFailure(
          target.copyChunk(table, constraint, Date.now()),
        )
        expect(errorCodes(constraintError)).toContain('23514')
        expect(classifyDatabaseMigrationFailure(constraintError, 'copying')).toMatchObject({
          category: 'copy-permanent',
          retryable: false,
        })
        await adminRuntime
          .providerPool()
          .unsafe(`ALTER TABLE ${TARGET_TABLE} DROP CONSTRAINT rfc349_fault_constraint`)
        await assertRolledBack(adminRuntime, constraint)
        await retryAndAssertCommitted(target, adminRuntime, table, constraint)

        const storage = agentChunk({
          contract,
          table,
          chunkIndex: 4,
          id: 'agt_fault_storage',
          name: 'storage-fault',
        })
        await installTrigger(adminRuntime, {
          functionName: 'rfc349_fault_storage',
          body: `
            IF NEW.id = 'agt_fault_storage' THEN
              RAISE EXCEPTION 'RFC-349 injected storage failure' USING ERRCODE = '53100';
            END IF;
          `,
        })
        const storageError = await captureFailure(target.copyChunk(table, storage, Date.now()))
        expect(errorCodes(storageError)).toContain('53100')
        expect(classifyDatabaseMigrationFailure(storageError, 'copying')).toMatchObject({
          category: 'copy-permanent',
          retryable: false,
        })
        await removeTrigger(adminRuntime, 'rfc349_fault_storage')
        await assertRolledBack(adminRuntime, storage)
        await retryAndAssertCommitted(target, adminRuntime, table, storage)
      } finally {
        if (target !== null) await target.close().catch(() => undefined)
        await adminRuntime.providerPool().unsafe('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
        await adminRuntime
          .providerPool()
          .unsafe('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
        await targetRuntime.close()
        await adminRuntime.close()
      }
    },
    180_000,
  )
})
