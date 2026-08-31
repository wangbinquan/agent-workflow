// RFC-349 — `agent-workflow db ...` adapter. It calls the same
// system-operations application as Settings; only human/JSON projection and
// the offline daemon-lock boundary live here.

import { sha256Hex } from '@/util/hash'
import type { Lock } from '@/util/lock'
import { acquireLock, DaemonLockHeldError } from '@/util/lock'
import { Paths } from '@/util/paths'
import type { DatabaseMigrationCommands } from '@/modules/system-operations/public/commands'
import type { DatabaseMigrationQueries } from '@/modules/system-operations/public/queries'
import type {
  DatabaseMigrationArtifactKind,
  DatabaseMigrationLegacyTableView,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  DatabaseMigrationTargetView,
  DatabaseRuntimeOverview,
  LocalSystemOperationContext,
} from '@/modules/system-operations/public/types'

export interface LocalDatabaseMigrationOperations {
  readonly context: LocalSystemOperationContext
  readonly application: Readonly<{
    readonly commands: DatabaseMigrationCommands
    readonly queries: DatabaseMigrationQueries
  }>
}

export interface DatabaseCliResult {
  readonly status: 'ok' | 'usage-error' | 'error'
  readonly output: string
}

const USAGE =
  'usage:\n' +
  '  agent-workflow db compact\n' +
  '  agent-workflow db status [--json]\n' +
  '  agent-workflow db preflight --to postgresql --url-env NAME [pool/timeout flags] [--json]\n' +
  '  agent-workflow db migrate --to postgresql --url-env NAME --auto [pool/timeout flags] [--json]\n' +
  '  agent-workflow db migration status <operation-id> [--json]\n' +
  '  agent-workflow db migration resume|cancel|rollback|finalize <operation-id> [--json]\n' +
  '  agent-workflow db migration artifact <operation-id> logical-backup|legacy-archive|verification|receipt|rollback-receipt\n' +
  '  agent-workflow db legacy inspect <operation-id> <table> [--json]\n' +
  '  agent-workflow db legacy export <operation-id> <table> --chunk N\n'

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function integerFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = flag(argv, name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function requiredChunkFlag(argv: readonly string[]): number {
  const raw = flag(argv, '--chunk')
  if (raw === undefined) throw new Error('--chunk is required')
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('--chunk must be a non-negative integer')
  }
  return parsed
}

function targetFromArgs(argv: readonly string[]): DatabaseMigrationTargetView {
  if (flag(argv, '--to') !== 'postgresql') {
    throw new Error('--to postgresql is required (SQLite remains the default provider)')
  }
  return {
    provider: 'postgresql',
    urlEnv: flag(argv, '--url-env') ?? 'AGENT_WORKFLOW_DATABASE_URL',
    poolMax: integerFlag(argv, '--pool-max', 16, 1, 256),
    connectTimeoutMs: integerFlag(argv, '--connect-timeout-ms', 10_000, 1_000, 120_000),
    statementTimeoutMs: integerFlag(argv, '--statement-timeout-ms', 60_000, 1_000, 3_600_000),
    idleTimeoutMs: integerFlag(argv, '--idle-timeout-ms', 30_000, 1_000, 600_000),
  }
}

function idempotencyKey(target: DatabaseMigrationTargetView): string {
  return `cli:${sha256Hex(JSON.stringify(target)).slice(0, 32)}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function formatDatabaseMigrationStatus(status: DatabaseMigrationStatusView): string {
  const failure =
    status.failure === null
      ? 'none'
      : `${status.failure.category}/${status.failure.detailCode} (retryable=${status.failure.retryable})`
  return [
    `database migration ${status.operationId}:`,
    `  phase:       ${status.phase}`,
    `  target:      postgresql via $${status.target.urlEnv}`,
    `  tables:      ${status.progress.tablesCompleted}/${status.tableCounts.source} source ` +
      `(${status.tableCounts.active} active + ${status.tableCounts.archiveOnly} archive-only)`,
    `  progress:    table=${status.progress.table ?? '-'} chunk=${status.progress.chunk} ` +
      `rows=${status.progress.rowsCopied} bytes=${formatBytes(status.progress.bytesCopied)}`,
    `  cancel:      ${status.cancelEligible ? 'eligible' : 'not eligible'}`,
    `  resume:      ${status.resumeEligible ? 'eligible' : 'not eligible'}`,
    `  rollback:    ${status.rollback.eligible ? 'eligible' : 'not eligible'} (${status.rollback.reason})`,
    `  first write: ${status.firstLiveWriteAt === null ? 'none' : new Date(status.firstLiveWriteAt).toISOString()}`,
    `  failure:     ${failure}`,
  ].join('\n')
}

export function formatDatabaseRuntimeOverview(overview: DatabaseRuntimeOverview): string {
  return [
    'database runtime:',
    `  provider:     ${overview.provider}`,
    `  generation:   ${overview.generationId}`,
    `  schema:       ${overview.schemaDigest}`,
    `  fingerprint:  ${overview.databaseFingerprint ?? 'unavailable'}`,
    `  server:       ${overview.serverVersion ?? (overview.provider === 'sqlite' ? 'embedded SQLite' : 'unavailable')}`,
    `  source:       ${overview.source === null ? 'not retained' : `${formatBytes(overview.source.fileBytes)}, ${overview.source.totalRows} rows`}`,
    `  tables:       ${overview.tableCounts.source} source (${overview.tableCounts.active} active + ${overview.tableCounts.archiveOnly} archive-only)`,
  ].join('\n')
}

export function formatDatabasePreflight(preflight: DatabaseMigrationPreflightView): string {
  return [
    'PostgreSQL migration preflight: ready',
    `  target:       PostgreSQL ${preflight.serverMajor}, ${preflight.serverEncoding}, ${preflight.timezone}`,
    `  fingerprint:  ${preflight.databaseFingerprint}`,
    `  state:        ${preflight.targetState}`,
    `  target size:  ${formatBytes(preflight.databaseBytes)}`,
    `  source:       ${formatBytes(preflight.sourceBytes)}, ${preflight.sourceRows} rows`,
    `  tables:       ${preflight.tableCounts.source} source (${preflight.tableCounts.active} active + ${preflight.tableCounts.archiveOnly} archive-only)`,
  ].join('\n')
}

export function formatLegacyTableInspection(table: DatabaseMigrationLegacyTableView): string {
  return [
    `legacy archive ${table.operationId}/${table.table}:`,
    `  rows:         ${table.rowCount}`,
    `  chunks:       ${table.chunkCount}`,
    `  blob bytes:   ${formatBytes(table.blobBytes)}`,
    `  first key:    ${table.firstKey?.join(', ') ?? 'none'}`,
    `  last key:     ${table.lastKey?.join(', ') ?? 'none'}`,
    `  root digest:  ${table.rootDigest}`,
  ].join('\n')
}

async function withOfflineLock<T>(
  operation: () => Promise<T>,
  lockFactory: (path: string) => Lock,
): Promise<T> {
  let lock: Lock
  try {
    lock = lockFactory(Paths.lock)
  } catch (error) {
    if (error instanceof DaemonLockHeldError) {
      throw new Error(
        `daemon is running (pid ${error.pid}); stop it before an offline database migration`,
      )
    }
    throw error
  }
  try {
    return await operation()
  } finally {
    lock.release()
  }
}

export async function databaseCommand(
  argv: readonly string[],
  operations: LocalDatabaseMigrationOperations,
  lockFactory: (path: string) => Lock = acquireLock,
): Promise<DatabaseCliResult> {
  const json = argv.includes('--json')
  const render = (status: DatabaseMigrationStatusView): DatabaseCliResult => ({
    status: 'ok',
    output: json ? `${JSON.stringify(status)}\n` : `${formatDatabaseMigrationStatus(status)}\n`,
  })
  try {
    if (argv[0] === 'status') {
      const overview = await operations.application.queries.overview.execute(operations.context)
      return {
        status: 'ok',
        output: json
          ? `${JSON.stringify(overview)}\n`
          : `${formatDatabaseRuntimeOverview(overview)}\n`,
      }
    }
    if (argv[0] === 'preflight') {
      const receipt = await operations.application.commands.preflight.execute(operations.context, {
        target: targetFromArgs(argv),
      })
      return {
        status: 'ok',
        output: json ? `${JSON.stringify(receipt)}\n` : `${formatDatabasePreflight(receipt)}\n`,
      }
    }
    if (argv[0] === 'migrate') {
      if (!argv.includes('--auto')) {
        throw new Error(
          '--auto is required after reviewing the maintenance window, six-table archive and rollback horizon',
        )
      }
      const target = targetFromArgs(argv)
      return render(
        await withOfflineLock(
          () =>
            operations.application.commands.start.execute(operations.context, {
              idempotencyKey: idempotencyKey(target),
              target,
            }),
          lockFactory,
        ),
      )
    }
    if (argv[0] === 'migration') {
      const action = argv[1]
      const operationId = argv[2]
      if (operationId === undefined) throw new Error('database migration operation id is required')
      const input = { operationId }
      if (action === 'status') {
        return render(await operations.application.queries.get.execute(operations.context, input))
      }
      if (action === 'artifact') {
        const kind = argv[3] as DatabaseMigrationArtifactKind | undefined
        if (kind === undefined) throw new Error('database migration artifact kind is required')
        const artifact = await operations.application.queries.readArtifact.execute(
          operations.context,
          { operationId, kind },
        )
        return { status: 'ok', output: artifact.json }
      }
      if (action === 'resume') {
        return render(
          await withOfflineLock(
            () => operations.application.commands.resume.execute(operations.context, input),
            lockFactory,
          ),
        )
      }
      if (action === 'cancel') {
        return render(
          await withOfflineLock(
            () => operations.application.commands.cancel.execute(operations.context, input),
            lockFactory,
          ),
        )
      }
      if (action === 'rollback') {
        return render(
          await withOfflineLock(
            () => operations.application.commands.rollback.execute(operations.context, input),
            lockFactory,
          ),
        )
      }
      if (action === 'finalize') {
        return render(
          await withOfflineLock(
            () => operations.application.commands.finalize.execute(operations.context, input),
            lockFactory,
          ),
        )
      }
    }
    if (argv[0] === 'legacy') {
      const action = argv[1]
      const operationId = argv[2]
      const table = argv[3]
      if (operationId === undefined) throw new Error('database migration operation id is required')
      if (table === undefined) throw new Error('legacy archive table is required')
      if (action === 'inspect') {
        const inspection = await operations.application.queries.inspectLegacyTable.execute(
          operations.context,
          { operationId, table },
        )
        return {
          status: 'ok',
          output: json
            ? `${JSON.stringify(inspection)}\n`
            : `${formatLegacyTableInspection(inspection)}\n`,
        }
      }
      if (action === 'export') {
        const artifact = await operations.application.queries.readLegacyChunk.execute(
          operations.context,
          { operationId, table, chunkIndex: requiredChunkFlag(argv) },
        )
        return { status: 'ok', output: artifact.json }
      }
    }
    return { status: 'usage-error', output: USAGE }
  } catch (error) {
    return {
      status: 'error',
      output: `database command failed: ${error instanceof Error ? error.message : String(error)}\n`,
    }
  }
}
