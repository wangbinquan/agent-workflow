import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
// Runtime completion of an already activated switch; no converter or source reader is loaded.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { pointerConfiguration } from '@/platform/persistence/databaseProviderRuntime'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  admitHistory,
  admitSqliteHistorySync,
} from '@/platform/persistence/schema/history/admission'
import { runtimeHistoryAdmission } from '@/platform/persistence/schema/history/runtime'
import {
  postgresqlHistoryConnection,
  sqliteHistoryConnection,
  parameters,
  type HistoryConnection,
} from '@/platform/persistence/schema/history/connection'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import {
  createSwitchReceipt,
  parseSwitchReceipt,
  HealthReportSchema,
  type SwitchReceipt,
} from '../../domain/epochSwitch/switchReceipt'
import { phaseIndex, reviseEpochSwitch } from '../../domain/epochSwitch/transitions'
import { createFileEpochSwitchJournal } from './fileJournal'
import { createEpochSourceRetention } from './sourceRetention'

export async function settleEpochSwitchBeforePointerReplacement(input: {
  appHome: string
  env?: Readonly<Record<string, string | undefined>>
}): Promise<void> {
  const pointerPath = join(input.appHome, 'database-generation.json')
  if (!existsSync(pointerPath)) return
  if (
    (JSON.parse(readFileSync(pointerPath, 'utf8')) as { payload?: { version?: number } }).payload
      ?.version !== 2
  )
    return
  const pointer = readGenerationPointerV2(pointerPath)
  const store = createFileEpochSwitchJournal({ root: join(input.appHome, 'database-migrations') })
  const open = (await store.list()).filter(
    (j) => !['completed', 'rolled-back', 'abandoned'].includes(j.payload.status),
  )
  if (!open.length) return
  const pending = []
  for (const journal of open) {
    const p = journal.payload
    if (
      p.activation === null &&
      phaseIndex(p.phase) < phaseIndex('activated') &&
      !(await store.readArtifact(p.operationId, 'activation-receipt.json'))
    )
      pending.push(p)
  }
  if (pending.length)
    throw new Error(
      `v3-another-operation-active: ${pending
        .map(
          (p) =>
            `${p.operationId} (${p.status}, ${p.phase}); continue with db migration plan ${p.operationId} or discard with db migration discard ${p.operationId} --confirm`,
        )
        .join('; ')}`,
    )
  if (
    open.length !== 1 ||
    open[0]!.payload.operationId !== pointer.payload.operationId ||
    open[0]!.payload.target.generationId !== pointer.payload.generationId
  )
    throw new Error('epoch-switch-pointer-unreconciled')
  const operationId = open[0]!.payload.operationId
  const lock = await store.lockOperation(operationId)
  let close: (() => void | Promise<void>) | undefined
  try {
    let journal = (await store.read(operationId))!
    if (journal.payload.status === 'completed') return
    const p = journal.payload
    if (
      !['activated', 'verified'].includes(p.phase) ||
      p.activation?.receiptDigest !== pointer.payload.manifestDigest
    )
      throw new Error('epoch-switch-pointer-unreconciled')
    if (readGenerationPointerV2(pointerPath).digest !== pointer.digest)
      throw new Error('epoch-switch-pointer-changed')
    let connection: HistoryConnection
    if (pointer.payload.database.kind === 'sqlite-file') {
      const db = new Database(resolve(input.appHome, pointer.payload.database.relativePath))
      close = () => db.close()
      admitSqliteHistorySync(db, runtimeHistoryAdmission())
      connection = sqliteHistoryConnection(db)
    } else {
      const config = PostgresqlDatabaseConfigSchema.parse(
        pointerConfiguration({ provider: 'sqlite' }, pointer),
      )
      const runtime = createPostgresqlDatabaseRuntime({
        config,
        generationId: pointer.payload.generationId,
        env: input.env,
      })
      close = () => runtime.close()
      await admitHistory(
        postgresqlHistorySession(runtime.providerPool()),
        runtimeHistoryAdmission(),
      )
      connection = postgresqlHistoryConnection(runtime.providerPool())
    }
    const marker = await connection.execute(
      `SELECT w.first_live_write_at FROM ${metaTableName(connection.provider, 'generations')} g JOIN ${metaTableName(connection.provider, 'first_write')} w ON w.generation_id = g.generation_id WHERE g.generation_id = ${parameters(connection, 1)} AND g.state = 'active'`,
      [pointer.payload.generationId],
    )
    if (marker.length !== 1) throw new Error('epoch-switch-active-generation-missing')
    if (marker[0]!.first_live_write_at === null)
      throw new Error(
        `epoch-switch-rollback-window-open: complete or roll back db migration ${operationId} before restore or provider move`,
      )
    const firstLiveWriteAt = Number(marker[0]!.first_live_write_at)
    const save = async (patch: Parameters<typeof reviseEpochSwitch>[1]) => {
      journal = await store.compareAndSwap(
        { operationId, revision: journal.payload.revision, digest: journal.digest },
        reviseEpochSwitch(journal, patch, Date.now()),
      )
    }
    const record = async (receipt: SwitchReceipt) => {
      const values = [
        receipt.payload.generationId,
        receipt.payload.kind,
        JSON.stringify(receipt),
        receipt.digest,
        receipt.payload.recordedAt,
      ]
      await connection.execute(
        `INSERT INTO ${metaTableName(connection.provider, 'switch_receipts')} (generation_id, kind, receipt_json, receipt_digest, recorded_at) VALUES (${parameters(connection, values.length)}) ON CONFLICT (generation_id, kind) DO NOTHING`,
        values,
      )
      const stored = await connection.execute(
        `SELECT receipt_digest FROM ${metaTableName(connection.provider, 'switch_receipts')} WHERE generation_id = ${parameters(connection, 2).split(', ')[0]} AND kind = ${parameters(connection, 2).split(', ')[1]}`,
        values.slice(0, 2),
      )
      if (stored.length !== 1 || stored[0]!.receipt_digest !== receipt.digest)
        throw new Error('epoch-switch-receipt-conflict')
      if (receipt.payload.kind === 'completed') {
        const [at, run] = parameters(connection, 2).split(', ')
        await connection.execute(
          `UPDATE ${metaTableName(connection.provider, 'migration_runs')} SET completed_at = ${at} WHERE run_id = ${run}`,
          [receipt.payload.recordedAt, receipt.payload.runId],
        )
      }
    }
    const write = (name: string, value: unknown) =>
      store.writeOnce(operationId, name, Buffer.from(JSON.stringify(value)))
    const verifiedBytes = await store.readArtifact(operationId, 'switch-receipt.json')
    // Catalog admission closes no acceptance requirement. Preserve the last
    // actual probe report, including a failure, without inventing a verify pass.
    const acceptanceRef = [...(p.artifacts ?? [])]
      .reverse()
      .find((ref) => ref.name.startsWith('acceptance-health-'))
    let acceptanceBytes = acceptanceRef
      ? await store.readArtifact(operationId, acceptanceRef.name)
      : null
    if (acceptanceRef && !acceptanceBytes) {
      const path = await store
        .artifacts?.(operationId)
        .get(acceptanceRef.name, acceptanceRef.digest)
      if (!path) throw new Error('epoch-switch-acceptance-evidence-missing')
      acceptanceBytes = readFileSync(path)
    }
    const admissionOnly = {
      version: 1 as const,
      checkedAt: Date.now(),
      catalogAdmitted: true,
      probes: [{ id: 'runtime-admission-only', passed: true, detail: { acceptance: 'not-run' } }],
      passed: false,
    }
    const health = acceptanceBytes
      ? HealthReportSchema.parse(JSON.parse(Buffer.from(acceptanceBytes).toString('utf8')))
      : { ...admissionOnly, digest: digestSchemaContract(admissionOnly) }
    const verified = verifiedBytes
      ? parseSwitchReceipt(Buffer.from(verifiedBytes).toString('utf8'))
      : null
    if (verified) await record(verified)
    if (journal.payload.phase === 'activated')
      await save({ phase: 'verified', status: 'running', firstLiveWriteAt })
    if (!(await store.readArtifact(operationId, 'completion-started.json')))
      await write('completion-started.json', {
        operationId,
        runId: p.run!.runId,
        generationId: pointer.payload.generationId,
        startedAt: Date.now(),
      })
    const completedBytes = await store.readArtifact(operationId, 'completion-receipt.json')
    const completed = completedBytes
      ? parseSwitchReceipt(Buffer.from(completedBytes).toString('utf8'))
      : createSwitchReceipt({
          version: 1,
          kind: 'completed',
          operationId,
          runId: p.run!.runId,
          generationId: pointer.payload.generationId,
          activationReceiptDigest: p.activation!.receiptDigest,
          pointerDigest: pointer.digest,
          firstLiveWriteAt,
          health: verified?.payload.health ?? health,
          retained: await createEpochSourceRetention({ journal: store }).retain({
            operationId,
            source: p.source.location,
          }),
          recordedAt: Date.now(),
        })
    if (!completedBytes) await write('completion-receipt.json', completed)
    await record(completed)
    await write('pointer-replacement.json', {
      operationId,
      generationId: pointer.payload.generationId,
      completionReceiptDigest: completed.digest,
      reason: 'first-write-closed-rollback-window',
      verification:
        verified || (acceptanceBytes && health.passed)
          ? 'acceptance-passed'
          : acceptanceBytes
            ? 'acceptance-failed'
            : 'admission-only',
    })
    await save({
      phase: 'completed',
      status: 'completed',
      firstLiveWriteAt,
      completion: { at: completed.payload.recordedAt, retained: completed.payload.retained },
      failure: null,
    })
  } finally {
    await close?.()
    await lock.release()
  }
}
