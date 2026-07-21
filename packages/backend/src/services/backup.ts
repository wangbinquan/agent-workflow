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

export interface BackupOptions {
  db: DbClient
  /** RFC-213: what produced this backup. Drives retention (scheduled/auto are
   *  rotated; manual/pre-* are kept). Defaults to 'manual'. */
  kind?: BackupKind
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
  const outPath = join(backupsDir, `agent-workflow-${ts}.tar.gz`)
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
    sqlite.exec(`VACUUM INTO '${dbDest.replaceAll("'", "''")}'`)
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

    // 5. RFC-213 manifest — migration identity read from the just-VACUUM'd
    //    snapshot (dbDest), so restore's version gate compares like-for-like.
    const manifest: BackupManifest = {
      manifestVersion: 1,
      kind: opts.kind ?? 'manual',
      createdAt: opts.now ?? Date.now(),
      appVersion: currentAppVersion(),
      includesWorktrees: false,
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
