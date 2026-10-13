import { observationProjectionCurrent } from '@/db/observationProjection'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { observationInvocations } from '@/db/schema'
import {
  incrementalObservationBootstrap,
  type ProjectionBootstrapChannel,
} from '../infrastructure/incrementalObservationBootstrap'
import type { ProjectionObservationTaskSource } from '../ports/taskObservations'
import type { HistoricalObservationSources } from '../ports/historicalObservationSources'

const component = (kind: string, id: string) => JSON.stringify([kind, id])
export function composeOriginalProjectionBootstrap(input: {
  readonly db: ProviderNeutralDatabase
  readonly generation: string
  readonly tasks: ProjectionObservationTaskSource
  readonly owners: HistoricalObservationSources['owners']
}) {
  const channels: ProjectionBootstrapChannel[] = [
    {
      id: 'indexed-details-v1',
      refresh: true,
      async page(after) {
        const rows = await input.db
            .select({ component: observationProjectionCurrent.component })
            .from(observationProjectionCurrent)
            .where(
              and(
                eq(observationProjectionCurrent.kind, 'contribution'),
                after ? gt(observationProjectionCurrent.component, after) : undefined,
                sql`${observationProjectionCurrent.component} IS NOT NULL`,
              ),
            )
            .groupBy(observationProjectionCurrent.component)
            .orderBy(asc(observationProjectionCurrent.component))
            .limit(201)
            .all(),
          items = rows.slice(0, 200)
        return {
          items: items.map((row) => ({
            identity: row.component!,
            component: row.component!,
            components: [row.component!],
          })),
          nextCursor: rows.length > 200 ? items.at(-1)!.component : null,
        }
      },
    },
    {
      id: 'task-metadata',
      async page(after) {
        const page = await input.tasks.projectionList({
          from: 0,
          to: Number.MAX_SAFE_INTEGER,
          timezone: 'UTC',
          limit: 200,
          ...(after ? { after } : {}),
        })
        return {
          ...page,
          items: page.items.map((task) => ({
            identity: task.id,
            component: component('task-metadata', task.id),
            components: [component('task-metadata', task.id)],
          })),
        }
      },
    },
    {
      id: 'accepted-invocations',
      async page(after) {
        const rows = await input.db
          .select({ id: observationInvocations.id, taskId: observationInvocations.taskId })
          .from(observationInvocations)
          .where(after === undefined ? undefined : gt(observationInvocations.id, after))
          .orderBy(asc(observationInvocations.id))
          .limit(201)
          .all()
        const items = rows.slice(0, 200)
        return {
          items: items.map((call) => ({
            identity: call.id,
            component: component('invocation', call.id),
            components: [component('invocation', call.id), component('task-metadata', call.taskId)],
          })),
          nextCursor: rows.length > 200 ? items.at(-1)!.id : null,
        }
      },
    },
    ...input.owners.map(
      (owner): ProjectionBootstrapChannel => ({
        id: 'historical-' + owner.kind,
        async page(after) {
          const page = await owner.query.owners({ limit: 200, ...(after ? { after } : {}) })
          return {
            ...page,
            items: page.items.map((row) => ({
              identity: row.ownerId,
              component: component(row.sourceKind, row.ownerId),
              components: [
                component(row.sourceKind, row.ownerId),
                ...(row.parentTaskId ? [component('task-metadata', row.parentTaskId)] : []),
                ...(row.rootSessionId ? [component('root', row.rootSessionId)] : []),
              ],
            })),
          }
        },
      }),
    ),
  ]
  return incrementalObservationBootstrap(input.db, input.generation, channels)
}
