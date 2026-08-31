// RFC-349 — provider backup application assets must read the live PostgreSQL
// generation, keep workflow YAML portable, and feed worktree rows through the
// same filesystem archive mechanism as the SQLite compatibility entrypoint.

import { afterEach, describe, expect, test } from 'bun:test'
import { LIVE_WORKTREE_TASK_STATUSES } from '@agent-workflow/shared'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { createPostgresqlProviderBackupApplicationAssets } from '@/modules/system-operations/infrastructure/postgresqlProviderBackupApplicationAssets'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { extractTarGz } from '@/util/archive'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rfc349-postgresql-backup-assets-'))
  roots.push(root)
  return root
}

function rows(value: readonly Record<string, unknown>[]): SqlRows {
  return Object.assign(Promise.resolve(value), {
    async values() {
      return value.map((row) => Object.values(row))
    },
  })
}

describe('RFC-349 PostgreSQL provider backup application assets', () => {
  test('exports canonical workflow YAML and archives selected live worktree rows', async () => {
    const root = tempRoot()
    const workflowsDestination = join(root, 'workflows')
    const stagingDirectory = join(root, 'staging')
    const worktreePath = join(root, 'active-worktree')
    const repoPath = join(root, 'cached-repo')
    mkdirSync(workflowsDestination, { recursive: true })
    mkdirSync(worktreePath, { recursive: true })
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(worktreePath, 'tracked.txt'), 'provider-neutral archive\n')
    mkdirSync(join(worktreePath, '.git'), { recursive: true })
    writeFileSync(join(worktreePath, '.git', 'excluded'), 'must not be archived')

    const workflowId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const taskId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    const queries: Array<{ sql: string; parameters: readonly unknown[] | undefined }> = []
    const pool: PostgresqlPool = {
      async reserve() {
        throw new Error('backup assets must not reserve a provider connection')
      },
      unsafe(sql: string, parameters?: readonly unknown[]) {
        queries.push({ sql, parameters })
        if (sql.includes('"agent_workflow"."workflows"')) {
          return rows([
            {
              id: workflowId,
              name: 'Portable workflow',
              description: 'Backed up from PostgreSQL',
              definition: JSON.stringify({
                $schema_version: 1,
                inputs: [],
                nodes: [],
                edges: [],
              }),
            },
          ])
        }
        if (sql.includes('"agent_workflow"."tasks"')) {
          return rows([
            {
              id: taskId,
              worktreePath,
              branch: 'agent-workflow/backup-fixture',
              repoPath,
              baseCommit: null,
            },
          ])
        }
        throw new Error(`unexpected PostgreSQL backup query: ${sql}`)
      },
      async close() {},
    }
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_pg_backup_assets_fixture',
      providerPool: () => pool,
    } as PostgresqlDatabaseRuntime
    const assets = createPostgresqlProviderBackupApplicationAssets({ runtime })

    expect(await assets.exportWorkflows(workflowsDestination)).toBe(1)
    await assets.captureWorktrees(stagingDirectory)

    const workflowYaml = parseYaml(
      readFileSync(join(workflowsDestination, `${workflowId}.yaml`), 'utf-8'),
    ) as Record<string, unknown>
    expect(workflowYaml).toMatchObject({
      id: workflowId,
      name: 'Portable workflow',
      description: 'Backed up from PostgreSQL',
      definition: { $schema_version: 5, inputs: [], nodes: [], edges: [] },
    })
    expect(existsSync(join(stagingDirectory, 'worktrees', `${taskId}.json`))).toBe(true)
    expect(existsSync(join(stagingDirectory, 'worktrees', `${taskId}.tar.gz`))).toBe(true)

    const extracted = tempRoot()
    await extractTarGz(join(stagingDirectory, 'worktrees', `${taskId}.tar.gz`), extracted)
    expect(readFileSync(join(extracted, 'tracked.txt'), 'utf-8')).toBe('provider-neutral archive\n')
    expect(existsSync(join(extracted, '.git'))).toBe(false)

    expect(queries).toHaveLength(2)
    expect(queries[0]?.sql).toContain('FROM "agent_workflow"."workflows"')
    expect(queries[0]?.sql).toContain('ORDER BY "id"')
    expect(queries[0]?.parameters).toBeUndefined()
    expect(queries[1]?.sql).toContain('FROM "agent_workflow"."tasks"')
    expect(queries[1]?.sql).toContain('WHERE "status" IN ($1, $2')
    expect(queries[1]?.parameters).toEqual(LIVE_WORKTREE_TASK_STATUSES)
    expect(queries.map(({ sql }) => sql).join('\n')).not.toMatch(/PRAGMA|sqlite/i)
  })

  test('fails closed when a PostgreSQL workflow definition is malformed', async () => {
    const root = tempRoot()
    const workflowsDestination = join(root, 'workflows')
    mkdirSync(workflowsDestination, { recursive: true })
    const pool: PostgresqlPool = {
      async reserve() {
        throw new Error('backup assets must not reserve a provider connection')
      },
      unsafe(_sql: string, _parameters?: readonly unknown[]) {
        return rows([
          {
            id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
            name: 'Malformed workflow',
            description: '',
            definition: '{not-json',
          },
        ])
      },
      async close() {},
    }
    const runtime = {
      provider: 'postgresql',
      generationId: 'dbg_pg_backup_assets_fixture',
      providerPool: () => pool,
    } as PostgresqlDatabaseRuntime

    await expect(
      createPostgresqlProviderBackupApplicationAssets({ runtime }).exportWorkflows(
        workflowsDestination,
      ),
    ).rejects.toThrow()
    expect(existsSync(join(workflowsDestination, '01ARZ3NDEKTSV4RRFFQ69G5FAX.yaml'))).toBe(false)
  })
})
