// The original RFC-311 cold nine-sample gate remains separate and unchanged.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider, resolveTestProviders } from './helpers/eachProvider'
import {
  taskFixture,
  taskRepoFixture,
  workflowFixture,
  type TaskFixtureSpec,
} from './helpers/model'
import { listTaskOperationsPage } from './helpers/taskListPage'
import type { RecordedStatement } from './helpers/statementRecorder'
import { collectG1PerformanceDiagnostics } from './helpers/rfc615G1Diagnostics'

interface PlanNode {
  [key: string]: unknown
  Plans?: PlanNode[]
}
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)]
}

/** EXECUTE is a utility statement, so its arguments need safe SQL literals, not $n bindings. */
function argument(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new Error('Unexpected G1 prepared-statement parameter')
}

describeEachProvider(
  'RFC-615 G1 native plans retain bounded prefix work',
  (harness) => {
    test('cold and VACUUM ANALYZE states preserve custom/generic results and fallback', async () => {
      const caseStartedAt = performance.now()
      const db = harness.db
      const binding = harness.applicationBinding
      if (binding.provider !== 'postgresql') throw new Error('Expected the explicit PG lane')
      // This file owns one disposable database. Prevent the background analyzer from
      // racing the seed so the first state really has no column statistics. The
      // original RFC-311 performance fixture and server settings remain untouched.
      const queryTables = [
        'tasks',
        'task_definitions',
        'task_launch_contexts',
        'task_workspaces',
        'task_repository_mounts',
        'lifecycle_alerts',
      ] as const
      for (const table of queryTables)
        await binding.runtime
          .providerPool()
          .unsafe(`ALTER TABLE agent_workflow.${table} SET (autovacuum_enabled = false)`)
      const { users } = tablesOf(db)
      await insertOne(db, users, {
        id: 'admin',
        username: 'admin',
        displayName: 'admin',
        role: 'admin',
        createdAt: 1,
        updatedAt: 1,
      })
      await workflowFixture(db, { id: 'r615-workflow', name: 'RFC615', definition: '{}' })
      const rows: TaskFixtureSpec[] = Array.from({ length: 500 }, (_, index) => {
        const id = `r615-task-${String(index).padStart(4, '0')}`
        return {
          id,
          name: `task ${id}`,
          workflowId: 'r615-workflow',
          workflowSnapshot: '{}',
          repoPath: '/repos/rfc615',
          repoUrl: 'https://example.invalid/rfc615.git',
          worktreePath: `/tmp/${id}`,
          baseBranch: 'main',
          branch: `rfc615/${id}`,
          inputs: '{}',
          status: index < 12 ? 'failed' : 'running',
          startedAt: 1_700_000_000_000 + index,
          finishedAt: index < 12 ? 1_700_000_001_000 + index : null,
          runningMs: 0,
          ownerUserId: 'admin',
          parentTaskId: null,
          invocationDepth: 0,
          launchOrigin: 'manual',
          branchStartedAt: 1_700_000_000_000 + index,
          rootTaskId: id,
        }
      })
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100)
        await taskFixture(db, batch)
        await taskRepoFixture(
          db,
          batch.map((row) => ({
            taskId: row.id!,
            repoIndex: 0,
            repoPath: '/repos/rfc615',
            repoUrl: 'https://example.invalid/rfc615.git',
            worktreePath: `/tmp/${row.id}`,
            branch: `rfc615/${row.id}`,
            baseBranch: 'main',
          })),
        )
      }
      const actor = buildActor({
        user: {
          id: 'admin',
          username: 'admin',
          displayName: 'admin',
          role: 'admin',
          status: 'active',
        },
        source: 'session',
      })
      const connection = await binding.runtime.providerPool().reserve()
      let originalMode: unknown
      const baselineRows = new Map<string, readonly Record<string, unknown>[]>()
      const statements = new Map<string, RecordedStatement>()
      try {
        const settings = await connection.unsafe(
          "SELECT version() AS version, current_setting('plan_cache_mode') AS mode, current_setting('jit') AS jit, pg_jit_available() AS jit_available",
        )
        originalMode = settings[0]!.mode
        console.info(`[rfc615-g1-settings] ${JSON.stringify(settings)}`)
        for (const state of ['cold', 'vacuum-analyzed'] as const) {
          if (state === 'vacuum-analyzed') await connection.unsafe('VACUUM ANALYZE')
          const statistics = await connection.unsafe(`
            SELECT s.relname, c.reltuples, c.relallvisible, s.last_analyze, s.last_autoanalyze
            FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
            WHERE s.schemaname = 'agent_workflow'
              AND s.relname IN ('tasks', 'task_definitions', 'task_launch_contexts',
                'task_workspaces', 'task_repository_mounts', 'lifecycle_alerts')
            ORDER BY s.relname
          `)
          console.info(`[rfc615-g1-statistics] ${JSON.stringify({ state, statistics })}`)
          expect(statistics).toHaveLength(queryTables.length)
          if (state === 'cold') {
            for (const row of statistics) {
              expect(row.last_analyze).toBeNull()
              expect(row.last_autoanalyze).toBeNull()
            }
            const columnStatistics = await connection.unsafe(`
              SELECT count(*)::int AS count FROM pg_stats
              WHERE schemaname = 'agent_workflow'
                AND tablename IN ('tasks', 'task_definitions', 'task_launch_contexts',
                  'task_workspaces', 'task_repository_mounts', 'lifecycle_alerts')
            `)
            expect(columnStatistics[0]!.count).toBe(0)
          } else {
            for (const row of statistics)
              expect(Number(row.reltuples)).toBe(row.relname === 'lifecycle_alerts' ? 0 : 500)
          }
          for (const status of ['running', 'failed'] as const) {
            const recording = harness.recordStatements()
            let actual: Awaited<ReturnType<typeof listTaskOperationsPage>>
            try {
              actual = await listTaskOperationsPage(db, actor, { statuses: status, limit: '5' })
            } finally {
              recording.stop()
            }
            expect(actual).toEqual(
              await listTaskOperationsPage(
                db,
                actor,
                { statuses: status, limit: '5' },
                { pipeline: 'exhaustive' },
              ),
            )
            const statement = recording.statements.find((entry) =>
              entry.sql.includes('root_prefix AS MATERIALIZED'),
            )
            expect(statement, 'the production G1 query must actually execute').toBeDefined()
            statements.set(status, statement!)
            const prepared = `rfc615_g1_${status}`
            await connection.unsafe(`PREPARE ${prepared} AS ${statement!.sql}`)
            try {
              const execute = `EXECUTE ${prepared}(${statement!.values.map(argument).join(', ')})`
              for (const mode of ['force_custom_plan', 'force_generic_plan'] as const) {
                await connection.unsafe(`SET plan_cache_mode = ${mode}`)
                const nativeRows = [...(await connection.unsafe(execute))]
                const before = baselineRows.get(status)
                if (before) expect(nativeRows).toEqual([...before])
                else baselineRows.set(status, nativeRows)
                const result = await connection.unsafe(
                  `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${execute}`,
                )
                const value = result[0]?.['QUERY PLAN']
                const documents = (typeof value === 'string' ? JSON.parse(value) : value) as {
                  Plan: PlanNode
                  Settings?: unknown
                  JIT?: unknown
                  'Planning Time'?: number
                  'Execution Time'?: number
                }[]
                expect(documents).toHaveLength(1)
                const plan = documents[0]!.Plan
                const all = nodes(plan)
                const physical = all.find((node) => node['Subplan Name'] === 'CTE physical_prefix')
                const prefix = all.find((node) => node['Subplan Name'] === 'CTE root_prefix')
                const fallback = all.find((node) => node['Subplan Name'] === 'CTE fallback_gate')
                const evidence = JSON.stringify({
                  state,
                  status,
                  mode,
                  plan,
                  settings: documents[0]!.Settings,
                  jit: documents[0]!.JIT,
                })
                expect(physical, evidence).toBeDefined()
                expect(physical!['Actual Rows'], evidence).toBe(24)
                expect(prefix, evidence).toBeDefined()
                expect(Number(prefix!['Actual Rows']), evidence).toBeLessThanOrEqual(24)
                expect(Number(prefix!['Actual Loops']), evidence).toBeLessThanOrEqual(1)
                // Membership/root are fetched together; no per-prefix scalar match probes.
                expect(
                  nodes(prefix!).filter((node) => /^SubPlan /.test(String(node['Subplan Name']))),
                  evidence,
                ).toEqual([])
                expect(
                  all.filter((node) => node['Subplan Name'] === 'CTE root_prefix_lookup'),
                  evidence,
                ).toEqual([])
                expect(fallback, evidence).toBeDefined()
                expect(Number(fallback!['Actual Rows']), evidence).toBe(
                  status === 'running' ? 0 : 1,
                )
                console.info(
                  `[rfc615-g1-plan] ${JSON.stringify({ state, status, mode, physicalRows: physical!['Actual Rows'], prefixRows: prefix!['Actual Rows'], fallbackRows: fallback!['Actual Rows'], settings: documents[0]!.Settings, jit: documents[0]!.JIT ?? null, planningMs: documents[0]!['Planning Time'], executionMs: documents[0]!['Execution Time'] })}`,
                )
              }
            } finally {
              await connection.unsafe(`DEALLOCATE ${prepared}`)
            }
          }
        }
        expect(statements.size).toBe(2)
        expect(baselineRows.size).toBe(2)
        const diagnostics = await collectG1PerformanceDiagnostics({
          database: binding.databaseConfig,
          statements: [statements.get('running')!],
          samplesMs: [],
          deadline: caseStartedAt + 180_000,
        })
        expect(diagnostics.status, JSON.stringify(diagnostics)).toBe('complete')
        expect(diagnostics.records.map((record) => (record as { kind: string }).kind)).toContain(
          'plan',
        )
      } finally {
        try {
          if (originalMode !== undefined)
            await connection.unsafe("SELECT set_config('plan_cache_mode', $1, false)", [
              originalMode,
            ])
        } finally {
          connection.release()
        }
      }
    }, 180_000)
  },
  { providers: resolveTestProviders(process.env).filter((provider) => provider === 'postgresql') },
)
