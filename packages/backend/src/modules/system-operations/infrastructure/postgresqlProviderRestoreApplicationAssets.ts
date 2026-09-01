// RFC-349 — application-owned filesystem assets for PostgreSQL restore.
//
// A portable archive may have been produced by another provider. Restoring its
// config must therefore retain the already-admitted PostgreSQL target profile;
// otherwise a successful logical restore could reboot onto SQLite or the
// source server. Skills and captured worktrees retain the existing restore
// semantics, while task rows are resolved from the restored PostgreSQL target.

import { ConfigSchema, type DatabaseConfig } from '@agent-workflow/shared'
import { cpSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { saveConfigRaw } from '@/config'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  reconstructWorktreeRows,
  type WorktreeReconstructionRow,
  type WorktreeReconstructionRows,
} from '@/services/worktreeBackup'
import type { PortableRestoreFilesystemAssets } from './portableDatabaseRestore'

type PostgresqlDatabaseConfig = Extract<DatabaseConfig, { provider: 'postgresql' }>
type ReconstructWorktrees = typeof reconstructWorktreeRows

function requiredString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') {
    throw new Error(`PostgreSQL restore task row has invalid ${field}`)
  }
  return value
}

function worktreeRow(
  row: Readonly<Record<string, unknown>> | undefined,
): WorktreeReconstructionRow | undefined {
  if (row === undefined) return undefined
  return Object.freeze({
    id: requiredString(row, 'id'),
    status: requiredString(row, 'status'),
    worktreePath: requiredString(row, 'worktreePath'),
    branch: requiredString(row, 'branch'),
    repoPath: requiredString(row, 'repoPath'),
  })
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function postgresqlWorktreeRows(runtime: PostgresqlDatabaseRuntime): WorktreeReconstructionRows {
  return Object.freeze({
    async findById(taskId: string) {
      const rows = await runtime
        .providerPool()
        .unsafe(
          'SELECT "id", "status", "worktree_path" AS "worktreePath", ' +
            '"branch", "repo_path" AS "repoPath" ' +
            'FROM "agent_workflow"."tasks" WHERE "id" = $1 LIMIT 1',
          [taskId],
        )
      return worktreeRow(rows[0])
    },
  })
}

export function createPostgresqlProviderRestoreApplicationAssets(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly appHome: string
  /** The already-verified target profile, never the profile stored in the backup. */
  readonly databaseConfig: PostgresqlDatabaseConfig
  /** Infrastructure test seam; production uses provider-neutral reconstruction. */
  readonly reconstructWorktrees?: ReconstructWorktrees
}): PortableRestoreFilesystemAssets {
  const reconstruct = input.reconstructWorktrees ?? reconstructWorktreeRows
  return Object.freeze({
    async apply({
      stagingDirectory,
      manifest,
    }: Parameters<PortableRestoreFilesystemAssets['apply']>[0]) {
      let config = false
      const stagedConfig = join(stagingDirectory, 'config.json')
      if (existsSync(stagedConfig)) {
        const raw = JSON.parse(readFileSync(stagedConfig, 'utf8')) as unknown
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('portable restore config must be an object')
        }
        const restored = ConfigSchema.parse({
          ...raw,
          database: input.databaseConfig,
        })
        saveConfigRaw(join(input.appHome, 'config.json'), restored)
        config = true
      }

      const stagedSkills = join(stagingDirectory, 'skills')
      const liveSkills = join(input.appHome, 'skills')
      rmSync(liveSkills, { recursive: true, force: true })
      const skills = isRealDirectory(stagedSkills)
      if (skills) cpSync(stagedSkills, liveSkills, { recursive: true })

      if (manifest.includesWorktrees) {
        await reconstruct(postgresqlWorktreeRows(input.runtime), stagingDirectory)
      }
      return Object.freeze({ config, skills })
    },
  })
}
