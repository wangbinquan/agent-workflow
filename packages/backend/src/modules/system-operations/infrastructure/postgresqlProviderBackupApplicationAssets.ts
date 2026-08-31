// RFC-349 — PostgreSQL reads for the application-owned portion of a portable
// backup. The database adapter selects immutable rows; workflow serialization
// and worktree archiving remain provider-neutral mechanisms.

import {
  LIVE_WORKTREE_TASK_STATUSES,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { PortableBackupApplicationAssets } from '@/services/portableBackupArchive'
import { stringifyWorkflowYaml } from '@/services/workflow.yaml'
import { captureWorktreeRows, type WorktreeCaptureRow } from '@/services/worktreeBackup'

interface PostgresqlWorkflowBackupRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly definition: unknown
}

function requiredString(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') {
    throw new Error(`PostgreSQL backup row has invalid ${field}`)
  }
  return value
}

function workflowRow(row: Readonly<Record<string, unknown>>): PostgresqlWorkflowBackupRow {
  return {
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    description: requiredString(row, 'description'),
    definition: row.definition,
  }
}

function workflowDefinition(value: unknown) {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value
  return migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(decoded))
}

function worktreeRow(row: Readonly<Record<string, unknown>>): WorktreeCaptureRow {
  const baseCommit = row.baseCommit
  if (baseCommit !== null && typeof baseCommit !== 'string') {
    throw new Error('PostgreSQL backup row has invalid baseCommit')
  }
  return {
    id: requiredString(row, 'id'),
    worktreePath: requiredString(row, 'worktreePath'),
    branch: requiredString(row, 'branch'),
    repoPath: requiredString(row, 'repoPath'),
    baseCommit,
  }
}

const LIVE_STATUS_PLACEHOLDERS = LIVE_WORKTREE_TASK_STATUSES.map(
  (_status, index) => `$${index + 1}`,
).join(', ')

/**
 * Build the provider-specific row reader used by the portable backup shell.
 * Queries are schema-qualified and read only live PostgreSQL state; retained
 * SQLite files are never consulted after cutover.
 */
export function createPostgresqlProviderBackupApplicationAssets(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly maxWorktreeBytes?: number
}): PortableBackupApplicationAssets {
  return Object.freeze({
    async exportWorkflows(destination: string) {
      const rows = await input.runtime
        .providerPool()
        .unsafe(
          'SELECT "id", "name", "description", "definition" ' +
            'FROM "agent_workflow"."workflows" ORDER BY "id"',
        )
      for (const raw of rows) {
        const workflow = workflowRow(raw)
        writeFileSync(
          join(destination, `${workflow.id}.yaml`),
          stringifyWorkflowYaml({
            ...workflow,
            definition: workflowDefinition(workflow.definition),
          }),
          'utf-8',
        )
      }
      return rows.length
    },
    async captureWorktrees(stagingDirectory: string) {
      const rows = await input.runtime
        .providerPool()
        .unsafe(
          'SELECT "id", "worktree_path" AS "worktreePath", "branch", ' +
            '"repo_path" AS "repoPath", "base_commit" AS "baseCommit" ' +
            'FROM "agent_workflow"."tasks" ' +
            `WHERE "status" IN (${LIVE_STATUS_PLACEHOLDERS}) ORDER BY "id"`,
          LIVE_WORKTREE_TASK_STATUSES,
        )
      await captureWorktreeRows(
        rows.map(worktreeRow),
        stagingDirectory,
        input.maxWorktreeBytes === undefined ? undefined : { maxBytes: input.maxWorktreeBytes },
      )
    },
  })
}
