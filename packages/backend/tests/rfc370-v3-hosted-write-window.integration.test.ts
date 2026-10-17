// RFC-370 v3 V7 (design/RFC-370-crewstation-hosted-deployment/redesign-v2-20261014.md §9)
// on a real PostgreSQL. Regression intent — each case is one review finding:
//
// - Every lease renewal used to take the exclusive write-window lock and every
//   fenced write `FOR UPDATE` on the single control row, so renewals stalled all
//   writes, fenced writes serialized, and a long transaction pushed a renewal
//   past expiry (a healthy holder then crash-exited). Now fenced writes hold the
//   row with KEY SHARE, a renewal waits for none of them, and only a takeover
//   (FOR UPDATE) or a freeze (exclusive window lock) drains them.
// - The write guard ran per statement; it now runs once per transaction.
// - Every write compared the database's schema digest with the binary's, so any
//   schema-changing release made the previous release's writes fail (and its
//   restart refused). There is no digest fence now, and a serving instance
//   verifies an expand-only successor schema while still refusing real drift.
//
// Uses the ephemeral CI PostgreSQL URL only. No local CS database participates.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { migrateForDeployment } from '@/cli/deployment'
import { workflows } from '@/db/schema'
import { prepareCrewStationDatabase } from '@/modules/system-operations/composition/crewstationDeployment'
import { createHostedDatabaseWriteBarrier } from '@/modules/system-operations/infrastructure/crewstation/databaseWriteBarrier'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { errorHandler } from '@/util/errors'
import { resolvePostgresqlTestUrlEnv, resolveTestProviders } from './helpers/eachProvider'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 'waiting' when `operation` is still blocked after `ms` (a lock it should wait on). */
async function stillWaiting(operation: Promise<unknown>, ms = 400): Promise<'done' | 'waiting'> {
  return await Promise.race([
    operation.then(() => 'done' as const),
    Bun.sleep(ms).then(() => 'waiting' as const),
  ])
}

const OWNER = { epoch: 1, instanceId: 'owner', leaseId: 'lease' }

if (resolveTestProviders(process.env).includes('postgresql')) {
  const urlEnv = resolvePostgresqlTestUrlEnv(process.env)
  const environment = { project: 'rfc370-write-window', service: 'aw' }
  const env = () => {
    if (!urlEnv || !process.env[urlEnv]) throw new Error('real PostgreSQL URL required')
    return {
      AW_DEPLOYMENT_MODE: 'crewstation',
      CS_PROJECT: environment.project,
      CS_SERVICE: environment.service,
      CS_DATABASE_URL: process.env[urlEnv]!,
    }
  }
  const raw = async (statement: string, parameters: unknown[] = []) => {
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv, poolMax: 1 }),
      generationId: 'write-window-test-raw',
    })
    try {
      return await runtime.providerPool().unsafe(statement, parameters)
    } finally {
      await runtime.close()
    }
  }
  async function install() {
    await raw('DROP SCHEMA IF EXISTS agent_workflow CASCADE')
    await raw('DROP SCHEMA IF EXISTS agent_workflow_meta CASCADE')
    await migrateForDeployment(env())
    const prepared = await prepareCrewStationDatabase({ environment, schema: 'verify', env: env() })
    const control = createDatabaseHostedExecutionControl({ db: prepared.openBootstrapClient() })
    return { prepared, control }
  }
  async function activate(control: ReturnType<typeof createDatabaseHostedExecutionControl>) {
    for (const phase of ['preparing', 'active'] as const)
      await control.write({
        epoch: OWNER.epoch,
        owner: OWNER.instanceId,
        leaseId: OWNER.leaseId,
        phase,
        expiresAt: Date.now() + 60_000,
      })
  }

  test('fenced writes never wait for each other, and a renewal never waits for them', async () => {
    const { prepared, control } = await install()
    const db = prepared.openBootstrapClient()
    const session = databaseSessionFor(db)
    const holding = deferred(),
      release = deferred()
    let first: Promise<void> | undefined
    try {
      await activate(control)
      first = session.transaction(async (tx) => {
        await control.assertHeld(tx, OWNER)
        await tx.insert(workflows).values({ id: 'fenced-1', name: 'Fenced', definition: '{}' })
        holding.resolve()
        await release.promise
      })
      await holding.promise
      const second = session.transaction(async (tx) => {
        await control.assertHeld(tx, OWNER)
        await tx.insert(workflows).values({ id: 'fenced-2', name: 'Fenced', definition: '{}' })
      })
      expect(await stillWaiting(second)).toBe('done')
      const renewedUntil = Date.now() + 90_000
      const renewal = control.write({
        epoch: OWNER.epoch,
        owner: OWNER.instanceId,
        leaseId: OWNER.leaseId,
        phase: 'active',
        expiresAt: renewedUntil,
      })
      expect(await stillWaiting(renewal)).toBe('done')
      expect((await control.read())?.expiresAt).toBe(renewedUntil)
    } finally {
      release.resolve()
      await Promise.allSettled([first])
      await prepared.runtime.close()
    }
  }, 180_000)

  test('a takeover waits for an in-flight fenced write, then the old lease is refused', async () => {
    const { prepared, control } = await install()
    const session = databaseSessionFor(prepared.openBootstrapClient())
    const holding = deferred(),
      release = deferred()
    let fenced: Promise<void> | undefined
    try {
      await activate(control)
      fenced = session.transaction(async (tx) => {
        await control.assertHeld(tx, OWNER)
        holding.resolve()
        await release.promise
      })
      await holding.promise
      const takeover = control.write({
        epoch: 2,
        owner: 'successor',
        leaseId: 'successor-lease',
        phase: 'preparing',
        expiresAt: Date.now() + 60_000,
      })
      expect(await stillWaiting(takeover)).toBe('waiting')
      release.resolve()
      await fenced
      await takeover
      await expect(
        session.transaction((tx) => control.assertHeld(tx, OWNER)),
      ).rejects.toMatchObject({ code: 'execution-standby', details: { reason: 'epoch changed' } })
    } finally {
      release.resolve()
      await Promise.allSettled([fenced])
      await prepared.runtime.close()
    }
  }, 180_000)

  test('closing the window drains admitted writes, refuses later ones with a retryable 503, and a claim reopens it', async () => {
    const { prepared, control } = await install()
    const barrier = createHostedDatabaseWriteBarrier()
    const guarded = createPostgresqlDatabaseClient(prepared.runtime.runtime, {
      beforeWrite: barrier.beforeWrite,
    })
    const app = new Hono()
    app.post('/configuration', async (c) => {
      await guarded
        .update(workflows)
        .set({ name: 'Changed over HTTP' })
        .where(eq(workflows.id, 'ordinary'))
      return c.json({ ok: true })
    })
    app.get('/configuration', async (c) =>
      c.json(await guarded.select().from(workflows).where(eq(workflows.id, 'ordinary'))),
    )
    app.onError(errorHandler)
    const admitted = deferred(),
      release = deferred()
    let writing: Promise<void> | undefined, freezing: Promise<void> | undefined
    try {
      await activate(control)
      await guarded.insert(workflows).values({ id: 'ordinary', name: 'Before', definition: '{}' })
      writing = databaseSessionFor(guarded).transaction(async (tx) => {
        await tx.insert(workflows).values({ id: 'admitted', name: 'Admitted', definition: '{}' })
        admitted.resolve()
        await release.promise
      })
      await admitted.promise
      freezing = control.write({
        epoch: 2,
        owner: null,
        leaseId: null,
        phase: 'frozen',
        expiresAt: null,
        migrationOperationId: 'migration-1',
      })
      expect(await stillWaiting(freezing)).toBe('waiting')
      release.resolve()
      await writing
      await freezing
      expect(
        (await guarded.select().from(workflows).where(eq(workflows.id, 'admitted')))[0]?.name,
      ).toBe('Admitted')
      const refused = await app.request('/configuration', { method: 'POST' })
      expect(refused.status).toBe(503)
      expect(await refused.json()).toMatchObject({
        code: 'hosted-database-write-unavailable',
        details: { operationId: 'migration-1' },
      })
      // Read-only standby: reads keep working while the window is closed.
      expect((await app.request('/configuration')).status).toBe(200)
      await control.write({
        epoch: 3,
        owner: 'next',
        leaseId: 'next-lease',
        phase: 'preparing',
        expiresAt: Date.now() + 60_000,
      })
      expect((await app.request('/configuration', { method: 'POST' })).status).toBe(200)
    } finally {
      release.resolve()
      await Promise.allSettled([writing, freezing])
      await prepared.runtime.close()
    }
  }, 180_000)

  test('the write guard runs once per transaction, and per implicit transaction otherwise', async () => {
    const { prepared } = await install()
    let guards = 0
    const barrier = createHostedDatabaseWriteBarrier()
    const counted = createPostgresqlDatabaseClient(prepared.runtime.runtime, {
      async beforeWrite(tx) {
        guards += 1
        await barrier.beforeWrite(tx)
      },
    })
    try {
      await databaseSessionFor(counted).transaction(async (tx) => {
        for (const id of ['once-1', 'once-2', 'once-3'])
          await tx.insert(workflows).values({ id, name: id, definition: '{}' })
        await tx.update(workflows).set({ name: 'renamed' }).where(eq(workflows.id, 'once-1'))
      })
      expect(guards).toBe(1)
      await counted.insert(workflows).values({ id: 'alone', name: 'alone', definition: '{}' })
      expect(guards).toBe(2)
      await counted.select().from(workflows)
      expect(guards).toBe(2)
    } finally {
      await prepared.runtime.close()
    }
  }, 180_000)

  test('a release keeps writing after its successor installs a newer schema (no digest fence)', async () => {
    const { prepared } = await install()
    const guarded = createPostgresqlDatabaseClient(prepared.runtime.runtime, {
      beforeWrite: createHostedDatabaseWriteBarrier().beforeWrite,
    })
    try {
      await raw('UPDATE agent_workflow_meta.schema_contract SET contract_digest = $1', [
        'sha256:' + 'a'.repeat(64),
      ])
      await guarded.insert(workflows).values({ id: 'after-upgrade', name: 'ok', definition: '{}' })
      expect(
        (await guarded.select().from(workflows).where(eq(workflows.id, 'after-upgrade'))).length,
      ).toBe(1)
    } finally {
      await prepared.runtime.close()
    }
  }, 180_000)

  test('a serving instance verifies an expand-only successor schema and still refuses real drift', async () => {
    const first = await install()
    await first.prepared.runtime.close()
    const successor = 'sha256:' + 'b'.repeat(64)
    const receipt = `upgrade:9999_rfc370_successor:sha256:${'c'.repeat(64)}`
    const serve = () => prepareCrewStationDatabase({ environment, schema: 'verify', env: env() })
    // What the next release's migration Job leaves behind: one more recorded
    // upgrade, its contract installed and followed by the active generation,
    // and an additional table this release does not know.
    await raw('CREATE TABLE agent_workflow.rfc370_successor_probe (id TEXT PRIMARY KEY)')
    await raw(
      'INSERT INTO agent_workflow_meta.schema_migrations (baseline_id, contract_digest, plan_digest, applied_at) VALUES ($1, $2, $3, $4)',
      [receipt, successor, 'sha256:' + 'd'.repeat(64), Date.now()],
    )
    await raw(
      'UPDATE agent_workflow_meta.schema_contract SET contract_digest = $1, active_table_count = active_table_count + 1',
      [successor],
    )
    await raw(
      "UPDATE agent_workflow_meta.database_generations SET contract_digest = $1 WHERE state = 'active'",
      [successor],
    )
    const serving = await serve()
    try {
      expect(serving.describeSchemaOutcome()).toContain(
        `the database already carries the newer expand-only schema ${successor}`,
      )
      expect(serving.receipt).toMatchObject({
        contractDigest: buildLogicalSchemaContract().digest,
        successorContractDigest: successor,
      })
      await serving
        .openBootstrapClient()
        .insert(workflows)
        .values({ id: 'serving-on-successor', name: 'ok', definition: '{}' })
    } finally {
      await serving.runtime.close()
    }

    // A table this release uses is gone: not expand-only, refused.
    await raw('ALTER TABLE agent_workflow.hosted_execution_control RENAME TO rfc370_moved_away')
    await expect(serve()).rejects.toMatchObject({ code: 'postgresql-schema-drift' })
    await raw('ALTER TABLE agent_workflow.rfc370_moved_away RENAME TO hosted_execution_control')
    await expect(serve().then((value) => value.runtime.close())).resolves.toBeUndefined()

    // An unknown contract no recorded upgrade explains is drift, not a successor.
    await raw('DELETE FROM agent_workflow_meta.schema_migrations WHERE baseline_id = $1', [receipt])
    await expect(serve()).rejects.toMatchObject({ code: 'postgresql-schema-drift' })
  }, 300_000)
}
