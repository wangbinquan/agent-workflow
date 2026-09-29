import {
  PlatformObservationPageSchema,
  PlatformObservationSourceError,
  type PlatformObservationPage,
} from '../domain/platformObservation'
import {
  platformObservationKey,
  platformObservationRevision,
  PlatformSyncError,
  type PlatformObservationBinding,
  type PlatformSyncState,
} from '../domain/platformSync'
import type { PlatformObservationSource } from '../ports/platformObservationSource'
import type {
  PlatformObservationStore,
  PlatformObservationTransaction,
} from '../ports/platformObservationStore'

async function append(
  tx: PlatformObservationTransaction,
  generation: string,
  page: PlatformObservationPage,
) {
  for (const item of page.items) {
    const prior = await tx.get(generation, platformObservationKey(item))
    if (prior) {
      const before = platformObservationRevision(prior),
        after = platformObservationRevision(item)
      if (after < before) continue
      if (after === before) {
        if (JSON.stringify(prior) !== JSON.stringify(item))
          throw new PlatformSyncError(
            'revision-conflict',
            'Platform projection revision changed content',
          )
        continue
      }
    }
    await tx.put(generation, item)
  }
}

async function restartSnapshot(
  tx: PlatformObservationTransaction,
  state: PlatformSyncState,
): Promise<PlatformSyncState> {
  if (state.staging) await tx.discard(state.staging.generation)
  return { ...state, mode: 'snapshot', staging: null, status: 'syncing' }
}

async function apply(
  tx: PlatformObservationTransaction,
  page: PlatformObservationPage,
  now: number,
): Promise<PlatformSyncState> {
  const before = tx.state
  if (
    page.projectId !== before.binding.projectId ||
    page.taskId !== before.binding.taskId ||
    page.mode !== before.mode
  )
    throw new PlatformSyncError(
      'page-conflict',
      'Platform page does not match the requested source',
    )
  if (
    before.visibilityRevision !== null &&
    (page.visibilityRevision < before.visibilityRevision ||
      (page.visibilityRevision === before.visibilityRevision &&
        page.costVisibility !== before.costVisibility))
  )
    throw new PlatformSyncError(
      'page-conflict',
      'Platform amount visibility revision changed content',
    )
  const visibilityChanged =
    before.visibilityRevision !== null && before.visibilityRevision !== page.visibilityRevision
  let next: PlatformSyncState = {
    ...before,
    revision: before.revision + 1,
    error: null,
    checkedAt: now,
    visibilityRevision: page.visibilityRevision,
    costVisibility: page.costVisibility,
    costsReady: visibilityChanged ? false : before.costsReady,
    gaps: page.gaps,
    schemaVersion: page.schemaVersion,
  }
  // An incremental cursor cannot prove history for a different wire version.
  // Keep the published generation until a fresh snapshot is complete.
  if (
    (page.mode === 'incremental' && page.schemaVersion !== before.schemaVersion) ||
    (before.staging !== null && page.schemaVersion !== before.staging.schemaVersion)
  )
    return restartSnapshot(tx, { ...next, costsReady: false })
  if (
    (visibilityChanged && (page.mode === 'incremental' || before.staging !== null)) ||
    (page.mode === 'incremental' && page.gaps.some((g) => g.reason !== 'capture-incomplete'))
  )
    return restartSnapshot(tx, { ...next, costsReady: false })
  if (page.mode === 'incremental') {
    if (before.generation === null)
      throw new PlatformSyncError(
        'page-conflict',
        'Incremental import requires a complete snapshot',
      )
    if (page.nextCursor !== null && page.nextCursor === before.cursor)
      throw new PlatformSyncError('page-conflict', 'Platform page did not advance')
    await append(tx, before.generation, page)
    return {
      ...next,
      cursor: page.nextCursor ?? page.persistedThrough,
      status: page.nextCursor === null ? 'ready' : 'syncing',
      asOf: page.asOf,
    }
  }
  if (Date.parse(page.expiresAt) <= now)
    return restartSnapshot(tx, { ...next, error: 'snapshot-expired' })
  const staging = before.staging
  if (
    staging &&
    (staging.snapshotId !== page.snapshotId ||
      staging.through !== page.snapshotThrough ||
      staging.expiresAt !== page.expiresAt ||
      staging.asOf !== page.asOf ||
      staging.cursor === page.nextCursor)
  )
    throw new PlatformSyncError('page-conflict', 'Platform snapshot continuation changed')
  const generation = staging?.generation ?? JSON.stringify([page.snapshotId, next.revision])
  await append(tx, generation, page)
  if (page.nextCursor !== null)
    return {
      ...next,
      status: 'syncing',
      staging: {
        generation,
        snapshotId: page.snapshotId,
        cursor: page.nextCursor,
        through: page.snapshotThrough,
        expiresAt: page.expiresAt,
        asOf: page.asOf,
        schemaVersion: page.schemaVersion,
      },
    }
  if (before.generation !== null && before.generation !== generation)
    await tx.discard(before.generation)
  next = {
    ...next,
    generation,
    cursor: page.snapshotThrough,
    staging: null,
    mode: 'incremental',
    status: 'ready',
    costsReady: true,
    asOf: page.asOf,
  }
  return next
}

/** Network reads happen outside the short atomic page commit. No local price dependency. */
export function createPlatformObservationSync(input: {
  readonly source: PlatformObservationSource
  readonly store: PlatformObservationStore
  readonly now?: () => number
}) {
  const now = input.now ?? Date.now
  return async (
    binding: PlatformObservationBinding,
    options: { readonly limit?: number; readonly signal?: AbortSignal } = {},
  ) => {
    const before = await input.store.state(binding)
    const base = {
      projectId: binding.projectId,
      taskId: binding.taskId,
      limit: options.limit ?? 200,
      signal: options.signal,
      expectedSchemaVersion: before.staging?.schemaVersion ?? before.schemaVersion,
    }
    try {
      const raw = await input.source.read(
        before.mode === 'incremental'
          ? {
              ...base,
              mode: 'incremental',
              ...(before.cursor === null ? {} : { after: before.cursor }),
            }
          : {
              ...base,
              mode: 'snapshot',
              ...(before.staging === null
                ? {}
                : { snapshotId: before.staging.snapshotId, cursor: before.staging.cursor }),
            },
      )
      options.signal?.throwIfAborted()
      const parsed = PlatformObservationPageSchema.safeParse(raw)
      if (!parsed.success)
        throw new PlatformObservationSourceError(
          'invalid-response',
          'Invalid platform observation page',
        )
      return await input.store.change(binding, async (tx) => {
        if (tx.state.revision !== before.revision)
          return { outcome: 'concurrent' as const, state: tx.state }
        const state = await apply(tx, parsed.data, now())
        await tx.save(state)
        return { outcome: 'updated' as const, state }
      })
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      // A failed atomic commit is rolled back before recording its diagnostic.
      const code =
        error instanceof PlatformObservationSourceError || error instanceof PlatformSyncError
          ? error.code
          : 'unavailable'
      return input.store.change(binding, async (tx) => {
        if (tx.state.revision !== before.revision)
          return { outcome: 'concurrent' as const, state: tx.state }
        let state: PlatformSyncState = {
          ...tx.state,
          revision: tx.state.revision + 1,
          checkedAt: now(),
          status: 'failed',
          error: code,
          costsReady: code === 'access-unavailable' ? false : tx.state.costsReady,
        }
        if (
          code === 'snapshot-required' ||
          code === 'access-unavailable' ||
          (code === 'source-not-found' && tx.state.staging !== null)
        )
          state = await restartSnapshot(tx, state)
        if (code === 'access-unavailable') state = { ...state, status: 'failed' }
        await tx.save(state)
        return { outcome: 'failed' as const, state }
      })
    }
  }
}
