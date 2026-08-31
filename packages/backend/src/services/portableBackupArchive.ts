// RFC-349 — provider-neutral outer backup archive. Provider adapters write the
// versioned logical payload; this mechanism owns the existing config/skills/
// workflow/worktree envelope and never guesses a provider from file presence.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tarGz } from '@/util/archive'
import { createLogger } from '@/util/log'
import {
  type BackupKind,
  type LogicalBackupDatabaseManifest,
  type MigrationIdentity,
  currentAppVersion,
  writeManifest,
} from '@/services/backupManifest'

const log = createLogger('portableBackupArchive')

export interface PortableBackupResult {
  readonly path: string
  readonly sizeBytes: number
  readonly contents: Readonly<{
    workflows: number
    skills: number
    config: boolean
    db: boolean
  }>
}

export interface PortableBackupDatabaseReceipt {
  readonly database: LogicalBackupDatabaseManifest
  readonly migration: MigrationIdentity
}

export interface PortableBackupApplicationAssets {
  exportWorkflows(destination: string): Promise<number>
  captureWorktrees(stagingDirectory: string): Promise<void>
}

export interface PortableBackupDatabaseExportInput {
  readonly stagingDirectory: string
  readonly logicalArtifactRoot: string
  readonly operationId: string
}

export interface CreatePortableBackupArchiveOptions {
  readonly appHome: string
  readonly kind?: BackupKind
  readonly includeWorktrees?: boolean
  readonly now?: number
  readonly application: PortableBackupApplicationAssets
  readonly exportDatabase: (
    input: PortableBackupDatabaseExportInput,
  ) => Promise<PortableBackupDatabaseReceipt>
}

function stampForFilename(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
}

function countDirEntries(dir: string): number {
  if (!existsSync(dir)) return 0
  let count = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else count += 1
    }
  }
  return count
}

export async function createPortableBackupArchive(
  options: CreatePortableBackupArchiveOptions,
): Promise<PortableBackupResult> {
  const now = options.now ?? Date.now()
  const kind = options.kind ?? 'manual'
  const includeWorktrees = options.includeWorktrees === true
  const timestamp = stampForFilename(now)
  const backupsDirectory = join(options.appHome, 'backups')
  const stagingDirectory = join(backupsDirectory, `.staging-${timestamp}`)
  const stem = kind === 'manual' ? 'agent-workflow' : kind
  const outputPath = join(backupsDirectory, `${stem}-${timestamp}.tar.gz`)
  mkdirSync(backupsDirectory, { recursive: true })
  if (existsSync(stagingDirectory)) {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }
  mkdirSync(stagingDirectory, { recursive: true })

  const contents = {
    workflows: 0,
    skills: 0,
    config: false,
    db: false,
  }

  try {
    const database = await options.exportDatabase({
      stagingDirectory,
      logicalArtifactRoot: join(stagingDirectory, 'database', 'logical'),
      operationId: `dbm_backup_${timestamp}`,
    })
    contents.db = true

    const configSource = join(options.appHome, 'config.json')
    if (existsSync(configSource)) {
      cpSync(configSource, join(stagingDirectory, 'config.json'))
      contents.config = true
    }

    const skillsSource = join(options.appHome, 'skills')
    if (existsSync(skillsSource)) {
      const skillsDestination = join(stagingDirectory, 'skills')
      cpSync(skillsSource, skillsDestination, { recursive: true })
      contents.skills = countDirEntries(skillsDestination)
    }

    const workflowsDestination = join(stagingDirectory, 'workflows')
    mkdirSync(workflowsDestination, { recursive: true })
    contents.workflows = await options.application.exportWorkflows(workflowsDestination)
    if (includeWorktrees) {
      await options.application.captureWorktrees(stagingDirectory)
    }

    writeManifest(stagingDirectory, {
      manifestVersion: 2,
      kind,
      createdAt: now,
      appVersion: currentAppVersion(),
      includesWorktrees: includeWorktrees,
      migration: database.migration,
      database: database.database,
    })
    await tarGz(stagingDirectory, outputPath)
    log.info('provider-neutral backup created', {
      path: outputPath,
      provider: database.database.provider,
      workflows: contents.workflows,
      skills: contents.skills,
    })
  } finally {
    if (existsSync(stagingDirectory)) {
      rmSync(stagingDirectory, { recursive: true, force: true })
    }
  }

  return Object.freeze({
    path: outputPath,
    sizeBytes: statSync(outputPath).size,
    contents: Object.freeze(contents),
  })
}
