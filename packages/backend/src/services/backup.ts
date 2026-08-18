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

import type { Database } from 'bun:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { stringifyWorkflowYaml } from '@/services/workflow.yaml'
import { listWorkflows } from '@/services/workflow'
import { captureWorktrees } from '@/services/worktreeBackup'
import { tarGz } from '@/util/archive'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

import {
  type BackupKind,
  type BackupManifest,
  currentAppVersion,
  readDbMigrationIdentity,
  writeManifest,
} from './backupManifest'

const log = createLogger('backup')

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
function vacuumIntoWorker(dbPath: string, dest: string): Promise<void> {
  const worker = new Worker(new URL('./backupVacuumWorker.ts', import.meta.url).href)
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const settle = (fn: () => void): void => {
      worker.terminate()
      fn()
    }
    worker.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
      if (event.data.ok) settle(() => resolvePromise())
      else settle(() => rejectPromise(new Error(`backup vacuum failed: ${event.data.error}`)))
    }
    worker.onerror = (event) => {
      settle(() => rejectPromise(new Error(`backup vacuum worker error: ${event.message}`)))
    }
    worker.postMessage({ dbPath, dest })
  })
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

export interface BackupResult {
  /** Absolute path to the tarball. */
  path: string
  sizeBytes: number
  /** Per-component counters returned for tests / status output. */
  contents: {
    workflows: number
    skills: number
    config: boolean
    db: boolean
  }
}

/**
 * Build a fresh tarball under `${appHome}/backups/`. Throws on I/O failure
 * and on missing `tar` binary (we shell out to the system tool).
 */
export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const appHome = opts.appHome ?? Paths.root
  const backupsDir = join(appHome, 'backups')
  mkdirSync(backupsDir, { recursive: true })

  const ts = stampForFilename(opts.now ?? Date.now())
  const stagingDir = join(backupsDir, `.staging-${ts}`)
  // RFC-213: name scheduled/auto backups by kind so retention can find + rotate
  // them; manual keeps the historical `agent-workflow-<ts>` name (protected).
  const kind = opts.kind ?? 'manual'
  const stem = kind === 'manual' ? 'agent-workflow' : kind
  const outPath = join(backupsDir, `${stem}-${ts}.tar.gz`)
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  const contents: BackupResult['contents'] = {
    workflows: 0,
    skills: 0,
    config: false,
    db: false,
  }

  try {
    // 1. SQLite via VACUUM INTO. The path must be inside a directory the
    //    daemon can write to; staging is a tmp dir we'll tar shortly.
    const sqlite = (opts.db as unknown as { $client: Database }).$client
    if (typeof sqlite?.exec !== 'function') {
      throw new Error('backup: drizzle client does not expose $client')
    }
    const dbDest = join(stagingDir, 'db.sqlite')
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
    contents.db = true

    // 2. config.json (skip if missing — first-run safety).
    const configSrc = join(appHome, 'config.json')
    if (existsSync(configSrc)) {
      cpSync(configSrc, join(stagingDir, 'config.json'))
      contents.config = true
    }

    // 3. skills/ — file system is the source of truth.
    const skillsSrc = join(appHome, 'skills')
    if (existsSync(skillsSrc)) {
      const skillsDest = join(stagingDir, 'skills')
      cpSync(skillsSrc, skillsDest, { recursive: true })
      contents.skills = countDirEntries(skillsDest)
    }

    // 4. workflows/ — one YAML per row.
    const workflowsDest = join(stagingDir, 'workflows')
    mkdirSync(workflowsDest, { recursive: true })
    const all = await listWorkflows(opts.db)
    for (const wf of all) {
      // RFC-199: listWorkflows already captured the immutable row used for
      // this export. Never re-read by id and accidentally serialize a later
      // revision under the earlier enumeration.
      const yaml = stringifyWorkflowYaml(wf)
      writeFileSync(join(workflowsDest, `${wf.id}.yaml`), yaml, 'utf-8')
      contents.workflows += 1
    }

    // 4b. RFC-213 G4a: capture non-terminal tasks' worktree working state.
    const includeWorktrees = opts.includeWorktrees === true
    if (includeWorktrees) {
      const wt = await captureWorktrees(opts.db, stagingDir)
      log.info('backup captured worktrees', {
        captured: wt.captured.length,
        skipped: wt.skipped.length,
      })
    }

    // 5. RFC-213 manifest — migration identity read from the just-VACUUM'd
    //    snapshot (dbDest), so restore's version gate compares like-for-like.
    const manifest: BackupManifest = {
      manifestVersion: 1,
      kind: opts.kind ?? 'manual',
      createdAt: opts.now ?? Date.now(),
      appVersion: currentAppVersion(),
      includesWorktrees: includeWorktrees,
      migration: readDbMigrationIdentity(dbDest) ?? { lastHash: null, lastCreatedAt: null },
    }
    writeManifest(stagingDir, manifest)

    // 6. tarball.
    await tarGz(stagingDir, outPath)
    log.info('backup created', {
      path: outPath,
      workflows: contents.workflows,
      skills: contents.skills,
    })
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  }

  const sizeBytes = statSync(outPath).size
  return { path: outPath, sizeBytes, contents }
}

function stampForFilename(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
}

function countDirEntries(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    const entries = readdirSync(cur, { withFileTypes: true })
    for (const e of entries) {
      const child = join(cur, e.name)
      if (e.isDirectory()) stack.push(child)
      else n += 1
    }
  }
  return n
}
