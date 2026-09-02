// P-5-02: backup service.
//
// Produces a single tar.gz under `${appHome}/backups/` that captures everything
// a user would want to restore on a fresh machine:
//
//   - db.sqlite       — consistent snapshot via `VACUUM INTO`
//   - config.json     — daemon config
//   - skills/         — full directory tree (fs is the source of truth)
//   - workflows/      — one YAML file per workflow (DB-stored, but YAML is the
//                       portable form)
//
// Explicitly NOT included: worktrees/, runs/, logs/, token. Those are local
// ephemeral / sensitive state that a restored daemon recreates on its own.
//
// `agent-workflow backup` CLI and the Settings export button both invoke
// `createBackup`.

// System Operations SQLite raw/logical backup adapter. Application code calls
// its provider-neutral coordinator; this file alone owns VACUUM INTO.

import type { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import {
  createPortableBackupArchive,
  type PortableBackupResult,
} from '@/services/portableBackupArchive'
import { exportLogicalDatabaseArtifact } from '@/platform/persistence/logicalDatabaseExport'
import { openSqliteLogicalSource } from '@/platform/persistence/sqliteLogicalSource'
import { readDatabaseGeneration } from '@/platform/persistence/generationStore'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { stringifyWorkflowYaml } from '@/services/workflow.yaml'
import { listWorkflows } from '@/services/workflow'
import { quickCheckSqlite } from './systemBackupVacuum'
import { captureWorktrees } from './systemWorktreeBackup'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

import { type BackupKind, readDbMigrationIdentity } from './systemBackupManifest'

const log = createLogger('backup')

declare const AW_COMPILED_BUILD: boolean | undefined

const BACKUP_VACUUM_WORKER_ENTRY =
  typeof AW_COMPILED_BUILD === 'boolean' && AW_COMPILED_BUILD
    ? './services/backupVacuumWorker.ts'
    : new URL('../../../services/backupVacuumWorker.ts', import.meta.url).href

/** RFC-311 — see backupVacuumWorker.ts: the copy runs off-thread so the
 *  daemon's synchronous connection keeps serving during a backup.
 *
 *  实现门 P0-1:`bun build --compile` 只打包 `mainEntry` 这一个入口,worker 文件
 *  既不是入口也不被 bundler 追踪,于是**发布版单二进制里 worker 必然
 *  ModuleNotFound**——备份能力在所有 release 上归零(dev 下 `bun run` 直接解析
 *  `.ts` 所以测试全绿,二进制 smoke 只跑 `version`)。两道修:①构建脚本把 worker
 *  加为额外入口(见 scripts/build-binary.ts 的 WORKER_ENTRIES);②这里对**任何**
 *  worker 失败都回落到同线程 VACUUM INTO——丢的只是「不冻结主线程」这个优化,
 *  绝不丢备份本身。 */
function runBackupWorker(request: unknown, label: string): Promise<void> {
  const worker = new Worker(BACKUP_VACUUM_WORKER_ENTRY)
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const settle = (fn: () => void): void => {
      worker.terminate()
      fn()
    }
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
      if (event.data.ok) settle(() => resolvePromise())
      else settle(() => rejectPromise(new Error(`backup ${label} failed: ${event.data.error}`)))
    }
    worker.onerror = (event) => {
      settle(() => rejectPromise(new Error(`backup ${label} worker error: ${event.message}`)))
    }
    worker.postMessage(request)
  })
}

function vacuumIntoWorker(dbPath: string, dest: string): Promise<void> {
  return runBackupWorker({ dbPath, dest }, 'vacuum')
}

/** RFC-311 实现门 P0-2:备份的只读快照会在库上持续 30–90 秒,而 C5 把 WAL
 *  checkpoint 循环改成了默认开——`PRAGMA wal_checkpoint(TRUNCATE)` 撞上活跃
 *  reader 时会调 busy handler 并**阻塞整个 busy_timeout(本仓 5 秒)**,而它跑在
 *  daemon 的同步主连接上,这 5 秒里全站冻结。也就是 §6.6 要消灭的那件事被本 RFC
 *  的另一半重新引入了。计数器让 checkpoint 循环在快照期间跳过这一拍。 */
let activeDbSnapshots = 0
export function isDbSnapshotInProgress(): boolean {
  return activeDbSnapshots > 0
}

/**
 * RFC-349 —— `PRAGMA quick_check` 也走 worker。
 *
 * 它要把整个多 GB 文件读一遍（本机 4.2GB 实测 4.4 秒）且 bun:sqlite 是同步的，
 * 留在主线程上就是全站冻结这么久。一次数据库迁移的安全备份原本要跑两遍
 * （临时文件一遍、改名后的目标一遍），本机全量取证实测 daemon 事件循环停顿 18.1 秒、
 * 托管 Linux 上 11.1 秒，期间 100 个客户端的 status 轮询集体超时。
 *
 * 回落规则与 `vacuumIntoOffThread` 一致（RFC-311 P0-2）：worker 起不来就在主线程上
 * 跑同一条校验——丢的只是「不冻结主线程」这个优化，**校验本身绝不能没**。
 */
export async function quickCheckOffThread(dbPath: string): Promise<{ offThread: boolean }> {
  activeDbSnapshots += 1
  try {
    await runBackupWorker({ quickCheckPath: dbPath }, 'quick-check')
    return { offThread: true }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('backup quick-check failed:'))
      throw error
    log.warn('backup quick-check worker unavailable; falling back to the main thread', {
      error: error instanceof Error ? error.message : String(error),
    })
    quickCheckSqlite({ dbPath })
    return { offThread: false }
  } finally {
    activeDbSnapshots -= 1
  }
}

export async function vacuumIntoOffThread(
  sqlite: Pick<Database, 'exec'>,
  dbPath: string,
  dest: string,
): Promise<{ offThread: boolean }> {
  activeDbSnapshots += 1
  try {
    return await vacuumIntoOffThreadInner(sqlite, dbPath, dest)
  } finally {
    activeDbSnapshots -= 1
  }
}

async function vacuumIntoOffThreadInner(
  sqlite: Pick<Database, 'exec'>,
  dbPath: string,
  dest: string,
): Promise<{ offThread: boolean }> {
  try {
    await vacuumIntoWorker(dbPath, dest)
    return { offThread: true }
  } catch (error) {
    // 回落必须是**能力等价**的:同一条 VACUUM INTO,只是跑在主连接上。
    log.warn('backup vacuum worker unavailable; falling back to the main thread', {
      error: error instanceof Error ? error.message : String(error),
    })
    sqlite.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
    return { offThread: false }
  }
}

export interface BackupOptions {
  db: DbClient
  /** RFC-213: what produced this backup. Drives retention (scheduled/auto are
   *  rotated; manual/pre-* are kept). Defaults to 'manual'. */
  kind?: BackupKind
  /** RFC-213 G4a: also capture non-terminal tasks' worktree working state
   *  (same-machine). Default false. */
  includeWorktrees?: boolean
  /** Override app home for tests. Defaults to Paths.root. */
  appHome?: string
  /** Override `now` for deterministic filenames in tests. */
  now?: number
}

export type BackupResult = PortableBackupResult

/**
 * Build a fresh tarball under `${appHome}/backups/`. Throws on I/O failure
 * and on missing `tar` binary (we shell out to the system tool).
 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const appHome = opts.appHome ?? Paths.root
  const contract = buildLogicalSchemaContract()
  const generation = readDatabaseGeneration({
    pointerPath: join(appHome, 'database-generation.json'),
    migrationsDir: join(appHome, 'database-migrations'),
    expectedSchemaDigest: contract.digest,
  })
  if (generation.payload.provider !== 'sqlite') {
    throw new Error(
      'backup: the legacy SQLite adapter cannot snapshot a live PostgreSQL generation',
    )
  }

  return await createPortableBackupArchive({
    appHome,
    kind: opts.kind,
    includeWorktrees: opts.includeWorktrees,
    now: opts.now,
    application: {
      async exportWorkflows(destination) {
        let count = 0
        for (const wf of await listWorkflows(opts.db)) {
          // RFC-199: listWorkflows already captured the immutable row used for
          // this export. Never re-read by id and serialize a later revision.
          writeFileSync(join(destination, `${wf.id}.yaml`), stringifyWorkflowYaml(wf), 'utf-8')
          count += 1
        }
        return count
      },
      async captureWorktrees(stagingDirectory) {
        const result = await captureWorktrees(opts.db, stagingDirectory)
        log.info('backup captured worktrees', {
          captured: result.captured.length,
          skipped: result.skipped.length,
        })
      },
    },
    async exportDatabase({ stagingDirectory, logicalArtifactRoot, operationId }) {
      // 1. SQLite via VACUUM INTO. The path must be inside a directory the
      //    daemon can write to; staging is a tmp dir we'll tar shortly.
      const sqlite = (opts.db as unknown as { $client: Database }).$client
      if (typeof sqlite?.exec !== 'function') {
        throw new Error('backup: drizzle client does not expose $client')
      }
      const dbDest = join(stagingDirectory, 'db.sqlite')
      // RFC-311 (audit L3-1): run the whole-file copy on a worker thread with
      // its own read-only connection so the daemon's synchronous connection —
      // and with it every HTTP/WS request — is not frozen for the multi-GB
      // read+rewrite. In-memory databases (tests) have no file to reopen, so
      // they keep the historical same-thread path.
      const dbFile =
        (sqlite.query('PRAGMA database_list;').get() as { file?: string } | null)?.file ?? ''
      if (dbFile === '') {
        sqlite.exec(`VACUUM INTO '${dbDest.replaceAll("'", "''")}'`)
      } else {
        await vacuumIntoOffThread(sqlite, dbFile, dbDest)
      }
      // RFC-349: the portable payload is read from the immutable VACUUM
      // snapshot, never from the live synchronous connection.
      const logicalSource = openSqliteLogicalSource({ path: dbDest, contract })
      let logicalBackup: Awaited<ReturnType<typeof exportLogicalDatabaseArtifact>>
      try {
        const sourceSnapshot = await logicalSource.preflight()
        logicalBackup = await exportLogicalDatabaseArtifact({
          operationId,
          sourceProvider: 'sqlite',
          sourceGenerationId: generation.payload.generationId,
          source: {
            provider: 'sqlite',
            assertUnchanged: () => logicalSource.assertUnchanged(sourceSnapshot),
            readChunk: (table, afterKey, limit) => logicalSource.readChunk(table, afterKey, limit),
          },
          expectedTableRows: sourceSnapshot.tableRows,
          contract,
          artifactRoot: logicalArtifactRoot,
          now: () => opts.now ?? Date.now(),
        })
      } finally {
        await logicalSource.close()
      }
      return {
        migration: readDbMigrationIdentity(dbDest) ?? {
          lastHash: null,
          lastCreatedAt: null,
        },
        database: {
          format: 'agent-workflow-logical-database-v1',
          provider: 'sqlite',
          sourceGenerationId: generation.payload.generationId,
          schemaDigest: contract.digest,
          logicalPath: 'database/logical',
          envelopeFileDigest: logicalBackup.envelopeFileDigest,
          rawSqlitePath: 'db.sqlite',
        },
      }
    },
  })
}
