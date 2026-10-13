import { decodeQualifiedObservationGroup } from '../domain/qualifiedObservationIndexes'
import { decodeObservationRowCount } from '../domain/observationRowCount'
import { decodeObservationWindowCell } from '../domain/observationWindowCell'
import { and, eq } from 'drizzle-orm'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import {
  observationProjectionDescriptors,
  observationProjectionBindings,
  observationProjectionCurrent,
  observationProjectionHistory,
  observationProjectionMemberships,
} from '@/db/observationProjection'
import type { IncrementalObservationVersion } from '../ports/incrementalObservationProjection'
import type { IncrementalObservationContribution } from '../ports/incrementalObservationProjection'

/** Close only the previous visible interval. Repeated writes to a bucket in one
 * microbatch update its one new version rather than creating overlapping rows. */
export async function retainIncrementalObservationVersion(
  tx: DatabaseTransaction,
  input: {
    readonly kind: 'contribution' | 'aggregate'
    readonly key: string
    readonly component: string | null
    readonly document: unknown | null
    readonly version: IncrementalObservationVersion
  },
) {
  const { kind, key, component, version } = input
  const current = await tx
    .select({ revision: observationProjectionCurrent.revision })
    .from(observationProjectionCurrent)
    .where(
      and(eq(observationProjectionCurrent.kind, kind), eq(observationProjectionCurrent.key, key)),
    )
    .get()
  if (current && current.revision !== version.revision) {
    await tx
      .update(observationProjectionHistory)
      .set({ toRevision: version.revision })
      .where(
        and(
          eq(observationProjectionHistory.kind, kind),
          eq(observationProjectionHistory.key, key),
          eq(observationProjectionHistory.fromRevision, current.revision),
        ),
      )
      .run()
    if (kind === 'contribution')
      await tx
        .update(observationProjectionMemberships)
        .set({ toRevision: version.revision })
        .where(
          and(
            eq(observationProjectionMemberships.key, key),
            eq(observationProjectionMemberships.fromRevision, current.revision),
          ),
        )
        .run()
  }
  if (input.document === null) {
    if (kind === 'contribution')
      await tx
        .delete(observationProjectionBindings)
        .where(eq(observationProjectionBindings.contributionKey, key))
        .run()
    await tx
      .delete(observationProjectionCurrent)
      .where(
        and(eq(observationProjectionCurrent.kind, kind), eq(observationProjectionCurrent.key, key)),
      )
      .run()
    return
  }
  const document = JSON.stringify(input.document)
  const detail =
    kind === 'contribution' ? (input.document as IncrementalObservationContribution).detail : null
  const metadata = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {}
  const bucket =
    kind === 'aggregate' && key.startsWith('occurrence-scope-day/')
      ? (JSON.parse(key.slice('occurrence-scope-day/'.length)) as [
          string | null,
          string,
          number | null,
        ])
      : null
  const descriptor =
    kind === 'aggregate' && /^(row-count|qualified-group|occurrence-cell)\//.test(key)
      ? (
          await tx
            .select({ document: observationProjectionDescriptors.document })
            .from(observationProjectionDescriptors)
            .where(eq(observationProjectionDescriptors.key, key))
            .get()
        )?.document
      : undefined
  if (
    kind === 'aggregate' &&
    /^(row-count|qualified-group|occurrence-cell)\//.test(key) &&
    !descriptor
  )
    throw new Error('Qualified projection descriptor is unavailable')
  const group =
    kind === 'aggregate' && key.startsWith('qualified-group/')
      ? decodeQualifiedObservationGroup(descriptor!)
      : null
  const count =
    kind === 'aggregate' && key.startsWith('row-count/')
      ? decodeObservationRowCount(descriptor!)
      : null
  const cell =
    kind === 'aggregate' && key.startsWith('occurrence-cell/')
      ? decodeObservationWindowCell(descriptor!)
      : null
  const indexes = {
    section: group
      ? 'qualified-group/' + group[1].section
      : count
        ? 'row-count'
        : cell
          ? 'occurrence-cell'
          : bucket
            ? 'occurrence-day'
            : typeof metadata.section === 'string'
              ? metadata.section
              : null,
    originalKey: typeof metadata.key === 'string' ? metadata.key : null,
    parent: group
      ? group[1].parent
      : count
        ? count.detail.parent
        : typeof metadata.parent === 'string'
          ? metadata.parent
          : null,
    taskId: group
      ? group[1].taskId
      : count
        ? count.detail.taskId
        : cell
          ? (cell.original.task?.id ?? null)
          : bucket
            ? bucket[0]
            : typeof metadata.taskId === 'string'
              ? metadata.taskId
              : null,
    cohortAt: group
      ? group[1].cohortAt
      : count
        ? count.detail.cohortAt
        : cell
          ? cell.from
          : bucket
            ? bucket[2] === null
              ? null
              : bucket[2] * 86400000
            : typeof metadata.cohortAt === 'number'
              ? metadata.cohortAt
              : null,
  }
  const indexedComponent = group
    ? group[0]
    : count
      ? count.owner
      : cell
        ? (JSON.parse(descriptor!.slice(16)) as [null, string])[1]
        : bucket
          ? bucket[1]
          : component
  const live = {
    kind,
    key,
    component: indexedComponent,
    revision: version.revision,
    document,
    ...indexes,
  }
  await tx
    .insert(observationProjectionCurrent)
    .values(live)
    .onConflictDoUpdate({
      target: [observationProjectionCurrent.kind, observationProjectionCurrent.key],
      set: live,
    })
    .run()
  const historical = {
    kind,
    key,
    component: indexedComponent,
    fromRevision: version.revision,
    toRevision: null,
    document,
    ...indexes,
  }
  await tx
    .insert(observationProjectionHistory)
    .values(historical)
    .onConflictDoUpdate({
      target: [
        observationProjectionHistory.kind,
        observationProjectionHistory.key,
        observationProjectionHistory.fromRevision,
      ],
      set: historical,
    })
    .run()
  if (kind === 'contribution') {
    const contribution = input.document as IncrementalObservationContribution
    await tx
      .delete(observationProjectionBindings)
      .where(eq(observationProjectionBindings.contributionKey, key))
      .run()
    const bindings =
      (
        detail as {
          readonly bindings?: readonly { readonly kind: string; readonly identity: string }[]
        } | null
      )?.bindings ?? []
    for (let at = 0; at < bindings.length; at += 150)
      await tx
        .insert(observationProjectionBindings)
        .values(
          bindings.slice(at, at + 150).map((binding) => ({
            ...binding,
            contributionKey: key,
            component: contribution.component,
          })),
        )
        .onConflictDoNothing()
        .run()
    for (let at = 0; at < contribution.aggregates.length; at += 150) {
      const memberships = contribution.aggregates
        .slice(at, at + 150)
        .map((aggregate) => ({ aggregate, key, fromRevision: version.revision, toRevision: null }))
      await tx
        .insert(observationProjectionMemberships)
        .values(memberships)
        .onConflictDoNothing()
        .run()
    }
  }
}
