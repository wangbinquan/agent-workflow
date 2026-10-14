import { sql, type SQL } from 'drizzle-orm'
import type { DatabaseTransaction } from './databaseTransaction'
import { engineOf } from './databaseTransaction'
import { buildLogicalSchemaContract, type LogicalTableContract } from './schemaContract'
import { OBSERVATION_SOURCE_REVISION } from './observationSourceRevisionSchema'
import type {
  OriginalObservationChange,
  OriginalObservationChangeRouter,
} from './observationChangeContract'
import { and, eq } from 'drizzle-orm'
import { observationProjectionBindings } from '@/db/observationProjection'
import {
  originalObservationRoute,
  observationDocumentRoutePaths,
} from './observationProjectionRoutes'
import { sha256Hex } from '@/util/hash'
import { jsonPathText } from './jsonPathText'
import type { DatabaseProvider } from './databaseProviders'

const relationPrefix = { sqlite: '', postgresql: '"agent_workflow".' } satisfies Record<
  DatabaseProvider,
  string
>

const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const roots =
  /^(?:root_session_id|capture_root_session_id|opencode_session_id|runtime_session_id|parent_session_id|session_id)$/
const anchors: Readonly<Record<string, string>> = {
  tasks: 'task-metadata',
  system_agent_observation_groups: 'task-metadata',
  node_runs: 'task',
  system_agent_observation_owners: 'attempt',
  memory_distill_jobs: 'memory-distill',
  intent_turns: 'intent-turn',
  mcp_runtime_test_turns: 'mcp-runtime-test',
}
/** The platform routes original schema relations; no observing module imports
 * another owner's private persistence. All relationship packets run to EOF. */
export function originalObservationProjectionRouter(): OriginalObservationChangeRouter {
  const contract = buildLogicalSchemaContract(),
    tables = new Map(contract.tables.map((table) => [table.id, table])),
    sources = new Set<string>(OBSERVATION_SOURCE_REVISION.sources)
  function relation(tx: DatabaseTransaction, table: LogicalTableContract) {
    const provider = engineOf(tx).provider
    const physical = table.providerTables[provider]
    if (!physical || table.disposition !== 'KEEP')
      throw new Error('Original projection relation missing: ' + table.id)
    return sql.raw(relationPrefix[provider] + quoted(physical))
  }
  async function rows(
    tx: DatabaseTransaction,
    table: LogicalTableContract,
    condition: SQL,
    consume: (row: Record<string, string | null>) => Promise<void>,
  ) {
    const key = table.primaryKey.map((name) => sql.raw(quoted(name)))
    let after: readonly string[] | undefined
    while (true) {
      const continuation =
        after === undefined
          ? sql`true`
          : sql.join(
              key.map(
                (column, at) =>
                  sql`(${sql.join(
                    key.slice(0, at).map((item, index) => sql`${item} = ${after![index]}`),
                    sql` AND `,
                  )}${at ? sql` AND ` : sql``}${column} > ${after![at]})`,
              ),
              sql` OR `,
            )
      const fields = sql.join(
        table.columns.map(
          (column) =>
            sql`CAST(${sql.raw(quoted(column.name))} AS TEXT) AS ${sql.raw(quoted(column.name))}`,
        ),
        sql`, `,
      )
      const page = await tx.all<Record<string, string | null>>(
        sql`SELECT ${fields} FROM ${relation(tx, table)} WHERE (${condition}) AND (${continuation}) ORDER BY ${sql.join(key, sql`, `)} LIMIT 200`,
      )
      if (!page.length) return
      for (const row of page) await consume(row)
      after = table.primaryKey.map((name) => {
        const value = page.at(-1)![name]
        if (value === null || value === undefined)
          throw new Error('Original projection primary key missing')
        return value
      })
    }
  }
  return {
    async components(tx, change: OriginalObservationChange) {
      const original = tables.get(change.source)
      if (!original || !sources.has(change.source))
        throw new Error('Unregistered original observation source: ' + change.source)
      const result = new Set<string>(),
        seen = new Set<string>(),
        foundRoots = new Set<string>()
      let unresolved = false
      async function bindings(kind: string, identity: string) {
        let after: string | undefined,
          count = 0
        for (;;) {
          const page = await tx
            .select({
              key: observationProjectionBindings.contributionKey,
              component: observationProjectionBindings.component,
            })
            .from(observationProjectionBindings)
            .where(
              and(
                eq(observationProjectionBindings.kind, kind),
                eq(observationProjectionBindings.identity, identity),
                after === undefined
                  ? undefined
                  : sql`${observationProjectionBindings.contributionKey} > ${after}`,
              ),
            )
            .orderBy(observationProjectionBindings.contributionKey)
            .limit(200)
            .all()
          if (!page.length) return count
          for (const row of page) {
            result.add(row.component)
            count++
          }
          after = page.at(-1)!.key
        }
      }
      const pending: {
        table: LogicalTableContract
        row: Readonly<Record<string, string | null>>
        reverse: boolean
      }[] = []
      for (const row of [change.previousRoute, change.nextRoute])
        if (row)
          pending.push({
            table: original,
            row,
            reverse: [
              'users',
              'agents',
              'observation_price_versions',
              'observation_price_heads',
              'observation_platform_sources',
              'intent_sessions',
              'mcp_runtime_test_sessions',
            ].includes(change.source),
          })
      for (let at = 0; at < pending.length; at++) {
        const entry = pending[at]!,
          routed = originalObservationRoute(entry.table.id, entry.row),
          identity = JSON.stringify([
            entry.table.id,
            entry.table.primaryKey.map((name) => entry.row[name]),
            entry.reverse,
          ])
        if (seen.has(identity)) continue
        seen.add(identity)
        const anchor = anchors[entry.table.id]
        if (anchor && entry.row.id) result.add(JSON.stringify([anchor, entry.row.id]))
        if (entry.row.task_id) result.add(JSON.stringify(['task-metadata', entry.row.task_id]))
        if (entry.row.group_id) result.add(JSON.stringify(['task-metadata', entry.row.group_id]))
        if (routed.$task) result.add(JSON.stringify(['task-metadata', routed.$task]))
        if (entry.row.node_run_id) result.add(JSON.stringify(['task', entry.row.node_run_id]))
        if (routed.$attempt) result.add(JSON.stringify(['attempt', routed.$attempt]))
        const invocation =
          routed.$invocation ??
          entry.row.invocation_id ??
          (entry.table.id === 'observation_invocations' ? entry.row.id : null)
        if (invocation) result.add(JSON.stringify(['invocation', invocation]))
        if (
          entry.table.id === 'observation_platform_records' ||
          entry.table.id === 'observation_platform_sources'
        ) {
          const identity =
            entry.row.source_key ??
            (entry.table.id === 'observation_platform_sources' ? entry.row.id : null)
          const bound = identity
            ? await bindings('platform', identity)
            : routed.$platformTask && routed.$platformProject && routed.$platformSource
              ? await bindings(
                  'platform',
                  sha256Hex(
                    JSON.stringify([
                      routed.$platformSource,
                      routed.$platformProject,
                      routed.$platformTask,
                    ]),
                  ),
                )
              : 0
          if (!bound) {
            // Bootstrap has not produced derived bindings yet. Resolve the
            // original accepted authority instead of waiting for that cache.
            const sourceTable = tables.get('observation_platform_sources')!
            const callsTable = tables.get('observation_invocations')!
            let sourceObserved = false
            const routeSource = async (source: Readonly<Record<string, string | null>>) => {
              const route = originalObservationRoute(sourceTable.id, source)
              if (!route.$platformSource || !route.$platformProject || !route.$platformTask) return
              sourceObserved = true
              await rows(
                tx,
                callsTable,
                sql`(
                ${jsonPathText(tx, sql.raw('"document"'), ['authority', 'kind'])} = 'crewstation'
                AND ${jsonPathText(tx, sql.raw('"document"'), ['authority', 'sourceId'])} = ${route.$platformSource}
                AND ${jsonPathText(tx, sql.raw('"document"'), ['authority', 'projectId'])} = ${route.$platformProject}
                AND ${jsonPathText(tx, sql.raw('"document"'), ['authority', 'taskId'])} = ${route.$platformTask}
              )`,
                async (row) => {
                  pending.push({ table: callsTable, row, reverse: false })
                },
              )
            }
            if (entry.table.id === sourceTable.id) await routeSource(entry.row)
            else if (identity) await rows(tx, sourceTable, sql`"id" = ${identity}`, routeSource)
            // An observed source with no accepted execution is an empty
            // contribution. Later acceptance has its own transactional outbox.
            if (!sourceObserved) unresolved = true
          }
        }
        if (entry.table.id === 'agents' && entry.row.id) await bindings('agent', entry.row.id)
        if (entry.table.id === 'observation_price_versions' && entry.row.registration_id)
          await bindings('runtime', entry.row.registration_id)
        // Price heads govern future acceptance; changing a head cannot reprice
        // an invocation's frozen catalogue. Do not expand unrelated executions.
        if (routed.$root) foundRoots.add(routed.$root)
        for (const [name, value] of Object.entries(entry.row))
          if (value && roots.test(name)) foundRoots.add(value)
        for (const fk of entry.table.foreignKeys) {
          // Catalog/identity parents do not connect unrelated executions.
          if (
            fk.foreignTable === 'users' ||
            fk.foreignTable === 'agents' ||
            fk.foreignTable === 'tasks' ||
            fk.foreignTable === 'system_agent_observation_groups'
          )
            continue
          const parent = tables.get(fk.foreignTable)
          if (
            !parent ||
            parent.disposition !== 'KEEP' ||
            fk.columns.some((name) => !entry.row[name])
          )
            continue
          await rows(
            tx,
            parent,
            sql.join(
              fk.foreignColumns.map(
                (name, index) => sql`${sql.raw(quoted(name))} = ${entry.row[fk.columns[index]!]}`,
              ),
              sql` AND `,
            ),
            async (row) => {
              pending.push({ table: parent, row, reverse: false })
            },
          )
        }
        if (entry.reverse)
          for (const child of tables.values()) {
            if (!sources.has(child.id)) continue
            for (const fk of child.foreignKeys)
              if (
                fk.foreignTable === entry.table.id &&
                fk.foreignColumns.every((name) => entry.row[name])
              )
                await rows(
                  tx,
                  child,
                  sql.join(
                    fk.columns.map(
                      (name, index) =>
                        sql`${sql.raw(quoted(name))} = ${entry.row[fk.foreignColumns[index]!]}`,
                    ),
                    sql` AND `,
                  ),
                  async (row) => {
                    pending.push({ table: child, row, reverse: true })
                  },
                )
          }
        // Native scope overlaps form one affected component closure, rather
        // than treating each shared root record as independent additive usage.
        for (const root of [...foundRoots]) {
          const marker = 'root/' + root
          if (seen.has(marker)) continue
          seen.add(marker)
          result.add(JSON.stringify(['root', root]))
          await bindings('root', root)
          for (const table of tables.values()) {
            if (!sources.has(table.id)) continue
            const columns = table.columns.filter((column) => roots.test(column.name)),
              path =
                table.id === 'observation_usage_current' || table.id === 'observation_usage_events'
                  ? undefined
                  : observationDocumentRoutePaths(table.id).$root
            const conditions = columns.map(
              (column) => sql`${sql.raw(quoted(column.name))} = ${root}`,
            )
            if (path)
              conditions.push(sql`${jsonPathText(tx, sql.raw('"document"'), path)} = ${root}`)
            if (conditions.length)
              await rows(tx, table, sql.join(conditions, sql` OR `), async (row) => {
                pending.push({ table, row, reverse: false })
              })
          }
        }
      }
      // A deleted row is routed through its retained previous route/dependency;
      // an absent nonnumeric owner is an explicit empty contribution.
      return unresolved ? null : [...result].sort()
    },
  }
}
