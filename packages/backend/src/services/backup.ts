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
import { join, relative } from 'node:path'
import type { DbClient } from '@/db/client'
import { exportWorkflowYaml } from '@/services/workflow.yaml'
import { listWorkflows } from '@/services/workflow'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('backup')

export interface BackupOptions {
  db: DbClient
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
  let actualOutPath: string = outPath
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
      const yaml = await exportWorkflowYaml(opts.db, wf.id)
      writeFileSync(join(workflowsDest, `${wf.id}.yaml`), yaml, 'utf-8')
      contents.workflows += 1
    }

    // 5. tarball (or zip fallback on Windows without bsdtar).
    actualOutPath = await tarGz(stagingDir, outPath)
    log.info('backup created', {
      path: actualOutPath,
      workflows: contents.workflows,
      skills: contents.skills,
    })
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  }

  const sizeBytes = statSync(actualOutPath).size
  return { path: actualOutPath, sizeBytes, contents }
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

/**
 * Produce the backup archive from the staging dir.
 *
 * RFC-windows PR-4 T20: prefers the system `tar` (produces `.tar.gz`; present on
 * all POSIX + Windows 10 1803+ which ships bsdtar on PATH). When `tar` is
 * absent (old Windows / stripped Server Core), falls back to PowerShell
 * `Compress-Archive` producing a `.zip` — the backup is a one-way export with
 * no `.tar.gz`-assuming restore side, so the format divergence is acceptable
 * and the result path reflects the actual extension. Throws if neither tool
 * is available.
 *
 * Returns the actual archive path (differs from `proposedOutPath` when the
 * zip fallback fires).
 */
async function tarGz(stagingDir: string, proposedOutPath: string): Promise<string> {
  if (await hasTar()) {
    // RFC-windows PR-4 T20: GNU tar (MSYS / Git-for-Windows) parses a `C:\…` drive
    // path as a remote `host:path` ("Cannot connect to C: resolve failed"),
    // and bsdtar (Win10 native) does not. `--force-local` is GNU-only, so the
    // portable fix is to run tar with `cwd = stagingDir` and a RELATIVE out
    // path (`../<basename>`, no drive colon) — both tar flavours treat it as a
    // local file. `.` is the staging contents.
    const relOut = relative(stagingDir, proposedOutPath)
    const proc = Bun.spawn(['tar', '-czf', relOut, '.'], {
      cwd: stagingDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exit = await proc.exited
    if (exit !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`tar exited with code ${exit}: ${stderr.trim()}`)
    }
    return proposedOutPath
  }

  // Fallback: PowerShell Compress-Archive → .zip (same basename, .zip ext).
  const zipPath = proposedOutPath.replace(/\.tar\.gz$/, '.zip')
  const res = Bun.spawnSync([
    'powershell',
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path ${psQuote(join(stagingDir, '*'))} -DestinationPath ${psQuote(zipPath)} -Force`,
  ])
  if (res.exitCode !== 0) {
    const stderr = res.stderr.toString().trim()
    throw new Error(
      `backup: neither tar nor Compress-Archive succeeded (tar not on PATH; Compress-Archive: ${stderr || `exit ${res.exitCode}`}). Install bsdtar (Windows 10 1803+ ships it) or PowerShell.`,
    )
  }
  log.warn('backup: tar not found; produced .zip via Compress-Archive fallback', { zipPath })
  return zipPath
}

/** True iff `tar --version` exits cleanly (system tar present on PATH). */
async function hasTar(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['tar', '--version'], { stdout: 'pipe', stderr: 'pipe' })
    const exit = await proc.exited
    return exit === 0
  } catch {
    return false
  }
}

/** Single-quote a path for a PowerShell -Command argument (escape ' as ''). */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
