import { appendHostedSuccessor } from './helpers/epoch2HostedSuccessor'
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
import { patchWorkflowFixture, readWorkflowFixtures, workflowFixture } from './helpers/model'
import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { migrateForDeployment } from '@/bootstrap/deployment'
import {
  crewStationControlClient,
  prepareCrewStationDatabase,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { createHostedDatabaseWriteBarrier } from '@/modules/system-operations/infrastructure/crewstation/databaseWriteBarrier'
import { createDatabaseHostedExecutionControl } from '@/modules/system-operations/infrastructure/hostedExecutionControl'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
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
    const prepared = await prepareCrewStationDatabase({
      contract: logicalSchemaContract,
      environment,
      schema: 'verify',
      env: env(),
    })
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
        await workflowFixture(tx, { id: 'fenced-1', name: 'Fenced', definition: '{}' })
        holding.resolve()
        await release.promise
      })
      await holding.promise
      const second = session.transaction(async (tx) => {
        await control.assertHeld(tx, OWNER)
        await workflowFixture(tx, { id: 'fenced-2', name: 'Fenced', definition: '{}' })
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
      await patchWorkflowFixture(guarded, { id: 'ordinary' }, { name: 'Changed over HTTP' })
      return c.json({ ok: true })
    })
    app.get('/configuration', async (c) => {
      return c.json(await readWorkflowFixtures(guarded, { id: 'ordinary' }))
    })
    app.onError(errorHandler)
    const admitted = deferred(),
      release = deferred()
    let writing: Promise<void> | undefined, freezing: Promise<void> | undefined
    try {
      await activate(control)
      await workflowFixture(guarded, { id: 'ordinary', name: 'Before', definition: '{}' })
      writing = databaseSessionFor(guarded).transaction(async (tx) => {
        await workflowFixture(tx, { id: 'admitted', name: 'Admitted', definition: '{}' })
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
      expect((await readWorkflowFixtures(guarded, { id: 'admitted' }))[0]?.name).toBe('Admitted')
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

  // CrewStation RFC-044 T9 acceptance (2026-10-29): the epoch-2 migration candidate boots on the target
  // generation while the platform keeps the operation unopened. Its boot convergence set the first-write
  // marker, and rollback before opening was refused with reverse-migration-required. Neither boot
  // convergence nor the execution-control row it reports the freeze through counts; only writes made
  // once the instance enforces the write window are the generation's first live write.
  test('boot convergence and the freeze report do not count as the first live write; enforced writes do', async () => {
    const { prepared } = await install()
    const barrier = createHostedDatabaseWriteBarrier({ enforcing: false })
    const db = createPostgresqlDatabaseClient(prepared.runtime.runtime, {
      beforeWrite: barrier.beforeWrite,
      countsAsLiveWrite: barrier.isEnforcing,
    })
    const marker = async () =>
      (
        await raw(
          'SELECT first_live_write_at FROM agent_workflow_meta.first_write WHERE generation_id = $1',
          [prepared.runtime.runtime.generationId],
        )
      )[0]?.first_live_write_at ?? null
    try {
      expect(await marker()).toBeNull()
      await databaseSessionFor(db).transaction((tx) =>
        workflowFixture(tx, { id: 'converged-at-boot', name: 'Boot', definition: '{}' }),
      )
      expect(barrier.isEnforcing()).toBe(false)
      expect(await marker()).toBeNull()
      await createDatabaseHostedExecutionControl({
        db: crewStationControlClient(prepared.runtime.runtime),
      }).write({
        epoch: 1,
        owner: null,
        phase: 'frozen',
        leaseId: null,
        expiresAt: null,
        migrationOperationId: 'dbm_e2_write_window_freeze',
      })
      expect(await marker()).toBeNull()
      // Opening: the platform hands execution to the instance at a newer epoch.
      await createDatabaseHostedExecutionControl({
        db: crewStationControlClient(prepared.runtime.runtime),
      }).write({
        epoch: 2,
        owner: 'next',
        leaseId: 'next-lease',
        phase: 'preparing',
        expiresAt: Date.now() + 60_000,
      })
      expect(await marker()).toBeNull()
      barrier.enforce()
      await databaseSessionFor(db).transaction((tx) =>
        workflowFixture(tx, { id: 'first-live-write', name: 'Live', definition: '{}' }),
      )
      expect(await marker()).not.toBeNull()
    } finally {
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
          await workflowFixture(tx, { id, name: id, definition: '{}' })
        await patchWorkflowFixture(tx, { id: 'once-1' }, { name: 'renamed' })
      })
      expect(guards).toBe(1)
      await workflowFixture(counted, { id: 'alone', name: 'alone', definition: '{}' })
      expect(guards).toBe(2)
      await readWorkflowFixtures(counted)
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
      await raw(
        "UPDATE agent_workflow_meta.generations SET contract_digest = $1 WHERE state = 'active'",
        ['sha256:' + 'a'.repeat(64)],
      )
      await workflowFixture(guarded, { id: 'after-upgrade', name: 'ok', definition: '{}' })
      expect((await readWorkflowFixtures(guarded, { id: 'after-upgrade' })).length).toBe(1)
    } finally {
      await prepared.runtime.close()
    }
  }, 180_000)

  test('a serving instance verifies an expand-only successor schema and still refuses real drift', async () => {
    const first = await install()
    await first.prepared.runtime.close()
    const runtime = createPostgresqlDatabaseRuntime({
      config: PostgresqlDatabaseConfigSchema.parse({ provider: 'postgresql', urlEnv }),
      generationId: 'dbg_successor_fixture',
    })
    let successor
    try {
      successor = await appendHostedSuccessor(runtime, process.env[urlEnv!]!)
    } finally {
      await runtime.close()
    }
    const serve = () =>
      prepareCrewStationDatabase({
        contract: logicalSchemaContract,
        environment,
        schema: 'verify',
        env: env(),
      })
    const serving = await serve()
    try {
      expect(serving.describeSchemaOutcome()).toContain('PostgreSQL schema verified')
      expect(serving.describeSchemaOutcome()).toContain(
        `the database already carries the newer expand-only schema ${successor.contract.contract.digest}`,
      )
      expect(serving.receipt).toMatchObject({
        contractDigest: successor.contract.contract.digest,
        planDigest: successor.postgresql.digest,
      })
      await workflowFixture(serving.openBootstrapClient(), {
        id: 'serving-on-successor',
        name: 'ok',
        definition: '{}',
      })
    } finally {
      await serving.runtime.close()
    }

    // A table this release uses is gone: not expand-only, refused. RFC-395 schema-history admission
    // reports it as physical drift (start / migrate print the RFC-275 guidance for it).
    await raw('ALTER TABLE agent_workflow.hosted_execution_control RENAME TO rfc370_moved_away')
    await expect(serve()).rejects.toMatchObject({ code: 'physical-drift' })
    await raw('ALTER TABLE agent_workflow.rfc370_moved_away RENAME TO hosted_execution_control')
    await expect(serve().then((value) => value.runtime.close())).resolves.toBeUndefined()

    // An unknown contract no recorded upgrade explains is drift, not a successor.
    await raw('DELETE FROM agent_workflow_meta.schema_history WHERE version = $1', [
      successor.contract.version,
    ])
    await expect(serve()).rejects.toMatchObject({ code: 'physical-drift' })
  }, 300_000)
}
