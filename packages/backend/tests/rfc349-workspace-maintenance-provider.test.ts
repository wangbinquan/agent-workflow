import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb } from '@/db/client'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { taskExecutionMaintenanceClaims, tasks, workflows } from '@/db/schema'
import { composeSqliteWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { PostgresqlWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/postgresqlWorkspaceMaintenanceStore'
import { SqliteWorkspaceMaintenanceStore } from '@/modules/source-control/infrastructure/sqliteWorkspaceMaintenanceStore'
import { SqliteTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/sqliteTerminalMaintenancePersistence'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ulid = monotonicFactory()
const cleanups: Array<() => void> = []

function rows(objects: readonly Record<string, unknown>[] = []): SqlRows {
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return []
    },
  })
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('RFC-349 Source Control workspace maintenance provider', () => {
  test('public/application surfaces expose a Promise command without database mechanisms', () => {
    const sourceRoot = resolve(import.meta.dir, '..', 'src', 'modules', 'source-control')
    for (const path of ['public/commands.ts', 'application/workspaceMaintenance.ts']) {
      const source = readFileSync(resolve(sourceRoot, path), 'utf8')
      expect(source, path).not.toMatch(/@\/db|drizzle-orm|bun:sqlite|PostgresqlDatabaseClient/)
    }
    const composition = readFileSync(
      resolve(sourceRoot, 'composition/workspaceMaintenance.ts'),
      'utf8',
    )
    expect(composition).toContain('composeSqliteWorkspaceMaintenanceCommand')
    expect(composition).toContain('composePostgresqlWorkspaceMaintenanceCommand')
    const postgresql = readFileSync(
      resolve(sourceRoot, 'infrastructure/postgresqlWorkspaceMaintenanceStore.ts'),
      'utf8',
    )
    expect(postgresql).not.toMatch(/as\s+(?:unknown\s+as\s+)?DbClient|createInMemoryDb|deasync/)
  })

  test('SQLite command preserves durable claim, filesystem cleanup and tombstone ordering', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-workspace-maintenance-'))
    cleanups.push(() => rmSync(appHome, { recursive: true, force: true }))
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    const taskId = ulid()
    const workspace = join(appHome, 'scratch', taskId)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'result.md'), 'durable workspace')
    await db.insert(workflows).values({
      id: workflowId,
      name: 'workspace maintenance fixture',
      definition: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'terminal scratch task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: workspace,
      worktreePath: workspace,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      spaceKind: 'scratch',
      startedAt: 1,
      finishedAt: 2,
    })
    const invalidated: string[] = []
    const command = composeSqliteWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance: new SqliteTerminalMaintenancePersistence(db),
      isMaterializingTask: () => false,
      invalidateWorkspacePath: (path) => invalidated.push(path),
    })

    await expect(
      command.runGcPhase({
        phase: 'worktree',
        activeTaskIds: [],
        worktreeAutoGc: { enabled: true },
        gitCloneTimeoutMs: 30_000,
        now: 10_000,
      }),
    ).resolves.toEqual({ scanned: 1, removed: 1, skipped: 0 })

    expect(existsSync(workspace)).toBeFalse()
    expect(invalidated).toEqual([workspace])
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(row.workspacePruningAt).toBe(10_000)
    expect(row.workspacePrunedAt).toBe(10_000)
    expect(
      await db
        .select({
          operation: taskExecutionMaintenanceClaims.operation,
          state: taskExecutionMaintenanceClaims.state,
        })
        .from(taskExecutionMaintenanceClaims),
    ).toEqual([{ operation: 'workspace-gc', state: 'completed' }])
  })

  test('materialization leases and collision-proof partial clone names preserve live directories', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-workspace-orphans-'))
    cleanups.push(() => rmSync(appHome, { recursive: true, force: true }))
    const db = createInMemoryDb(MIGRATIONS)
    const leasedId = 'leased-task'
    const orphanId = 'orphan-task'
    const scratchRoot = join(appHome, 'scratch')
    const leased = join(scratchRoot, leasedId)
    const orphan = join(scratchRoot, orphanId)
    mkdirSync(leased, { recursive: true })
    mkdirSync(orphan, { recursive: true })
    const old = new Date(0)
    utimesSync(leased, old, old)
    utimesSync(orphan, old, old)
    const reposRoot = join(appHome, 'repos')
    const partial = join(reposRoot, 'repo~partial~01ARZ3NDEKTSV4RRFFQ69G5FAV')
    const collision = join(reposRoot, 'repo.partial-01ARZ3NDEKTSV4RRFFQ69G5FAV')
    mkdirSync(partial, { recursive: true })
    mkdirSync(collision, { recursive: true })
    utimesSync(partial, old, old)
    utimesSync(collision, old, old)
    const command = composeSqliteWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance: new SqliteTerminalMaintenancePersistence(db),
      isMaterializingTask: (taskId) => taskId === leasedId,
      invalidateWorkspacePath() {},
    })
    const common = {
      activeTaskIds: [] as const,
      worktreeAutoGc: { enabled: true },
      gitCloneTimeoutMs: 30_000,
      now: 200_000_000,
    }

    await expect(command.runGcPhase({ ...common, phase: 'scratch' })).resolves.toEqual({
      scanned: 2,
      removed: 1,
      skipped: 1,
    })
    expect(existsSync(leased)).toBeTrue()
    expect(existsSync(orphan)).toBeFalse()

    await expect(command.runGcPhase({ ...common, phase: 'partial' })).resolves.toEqual({
      scanned: 1,
      removed: 1,
      skipped: 0,
    })
    expect(existsSync(partial)).toBeFalse()
    expect(existsSync(collision)).toBeTrue()
  })

  test('workspace recovery resumes the exact provider terminal-maintenance claim', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-workspace-recovery-'))
    cleanups.push(() => rmSync(appHome, { recursive: true, force: true }))
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    const taskId = ulid()
    const workspace = join(appHome, 'scratch', taskId)
    mkdirSync(workspace, { recursive: true })
    await db.insert(workflows).values({
      id: workflowId,
      name: 'workspace recovery fixture',
      definition: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'claimed scratch task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: workspace,
      worktreePath: workspace,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'failed',
      inputs: '{}',
      spaceKind: 'scratch',
      startedAt: 1,
      finishedAt: 2,
      workspacePruningAt: 100,
    })
    const terminalMaintenance = new SqliteTerminalMaintenancePersistence(db)
    const members = await terminalMaintenance.snapshotMembers([taskId])
    await terminalMaintenance.claim({
      rootTaskId: taskId,
      operation: 'workspace-gc',
      members,
      cleanupPlanJson: JSON.stringify({ v: 1, kind: 'workspace-prune', taskId }),
      now: 100,
    })
    const command = composeSqliteWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance,
      isMaterializingTask: () => false,
      invalidateWorkspacePath() {},
    })

    await expect(command.recover({ activeTaskIds: [], now: 1_000 })).resolves.toEqual({
      completed: 1,
      failed: 0,
      skipped: 0,
    })
    expect(existsSync(workspace)).toBeFalse()
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(row.workspacePrunedAt).toBe(1_000)
  })

  test('iso cleanup uses a transient provider claim and releases it only after I/O', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc349-iso-maintenance-'))
    cleanups.push(() => rmSync(appHome, { recursive: true, force: true }))
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    const taskId = ulid()
    const isoRoot = join(appHome, 'iso', taskId)
    mkdirSync(join(isoRoot, 'attempt-1'), { recursive: true })
    await db.insert(workflows).values({
      id: workflowId,
      name: 'iso maintenance fixture',
      definition: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'terminal remote task',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: join(appHome, 'missing-repo'),
      worktreePath: join(appHome, 'missing-worktree'),
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      spaceKind: 'remote',
      startedAt: 1,
      finishedAt: 2,
    })
    const command = composeSqliteWorkspaceMaintenanceCommand({
      db,
      appHome,
      terminalMaintenance: new SqliteTerminalMaintenancePersistence(db),
      isMaterializingTask: () => false,
      invalidateWorkspacePath() {},
    })

    await expect(
      command.runGcPhase({
        phase: 'iso',
        activeTaskIds: [],
        worktreeAutoGc: { enabled: true },
        gitCloneTimeoutMs: 30_000,
        now: 2_000,
      }),
    ).resolves.toEqual({ scanned: 1, removed: 1, skipped: 0 })
    expect(existsSync(isoRoot)).toBeFalse()
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(row.workspacePruningAt).toBeNull()
    expect(row.workspacePrunedAt).toBeNull()
  })

  test('ISO claim release cannot clear a concurrently replaced provider lease', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    const taskId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'iso lease CAS fixture',
      definition: '{}',
      createdAt: 1,
      updatedAt: 1,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'terminal task with a replaced ISO claim',
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/worktree',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      spaceKind: 'remote',
      startedAt: 1,
      finishedAt: 2,
      workspacePruningAt: 200,
    })
    const store = new SqliteWorkspaceMaintenanceStore(db)

    await expect(store.releaseIsoClaim(taskId, 100)).resolves.toBeFalse()
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workspacePruningAt).toBe(
      200,
    )
    await expect(store.releaseIsoClaim(taskId, 200)).resolves.toBeTrue()
    expect(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workspacePruningAt,
    ).toBeNull()
  })

  test('PostgreSQL store uses the provider client and fenced native writes', async () => {
    const statements: string[] = []
    const execute = (query: string): SqlRows => {
      statements.push(query)
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(query.trim())) return rows()
      if (query.includes('database_generations')) {
        return rows([{ generation_id: 'dbg_workspace_maintenance' }])
      }
      if (/^\s*select[\s\S]+from\s+"agent_workflow"\."tasks"/i.test(query)) {
        return rows([
          {
            id: 'task-pg',
            status: 'done',
            repo_path: '/repo',
            worktree_path: '/worktree',
            branch: 'agent-workflow/task-pg',
            base_branch: 'main',
            space_kind: 'remote',
            repo_count: 1,
            started_at: 1,
            finished_at: 2,
            workspace_pruning_at: null,
            workspace_prune_cause: null,
            workspace_pruned_at: null,
          },
        ])
      }
      if (/update\s+"agent_workflow"\."tasks"/i.test(query)) return rows([{ id: 'task-pg' }])
      throw new Error(`unexpected PostgreSQL workspace query: ${query}`)
    }
    const connection: PostgresqlReservedConnection = {
      unsafe: execute,
      release() {},
    }
    const pool: PostgresqlPool = {
      unsafe: execute,
      async reserve() {
        return connection
      },
      async close() {},
    }
    const runtime: PostgresqlDatabaseRuntime = {
      provider: 'postgresql',
      generationId: 'dbg_workspace_maintenance',
      providerPool: () => pool,
      async health() {
        throw new Error('not used')
      },
      async readiness() {
        throw new Error('not used')
      },
      async acquireMigrationAdvisoryLock() {
        throw new Error('not used')
      },
      async close() {},
    }
    const store = new PostgresqlWorkspaceMaintenanceStore(createPostgresqlDatabaseClient(runtime))

    await expect(store.listGcCandidates()).resolves.toEqual([
      expect.objectContaining({ id: 'task-pg', workspacePrunedAt: null }),
    ])
    await expect(store.claimWorkspace('task-pg', 100_000)).resolves.toBeTrue()
    expect(
      statements.some((statement) => statement.includes('"agent_workflow"."tasks"')),
    ).toBeTrue()
    expect(statements.map((statement) => statement.trim().toLowerCase())).toEqual([
      expect.stringMatching(/^select/),
      'begin',
      expect.stringContaining('with marked as (update "agent_workflow_meta"'),
      expect.stringContaining('select generation_id from "agent_workflow_meta"'),
      expect.stringContaining('update "agent_workflow"."tasks"'),
      'commit',
    ])
  })
})
