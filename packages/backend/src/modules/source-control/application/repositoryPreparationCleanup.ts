import { ConflictError, NotFoundError } from '@/util/errors'
import type { RepositoryPreparationOperationRef } from '../public/types'
import type { RepositoryPreparationJournal } from './ports/repositoryPreparationJournal'

export interface RepositoryPreparationCleanupEffects {
  /** Task-owned binding/attempt check: must reject an admitted or replaced owner. */
  assertCurrent(): Promise<void>
  cleanup(input: {
    readonly planJson: string | null
    readonly diagnosticsJson: string | null
  }): Promise<{ readonly complete: boolean; readonly receiptJson: string }>
}

/** A Task compensation call, never a background lease or autonomous SC worker. */
export async function cleanupRepositoryWorkspace(input: {
  readonly operation: RepositoryPreparationOperationRef
  readonly journal: RepositoryPreparationJournal
  readonly effects: RepositoryPreparationCleanupEffects
  readonly now: () => number
}): Promise<{ readonly complete: boolean; readonly receiptJson: string }> {
  const { journal, effects } = input
  await effects.assertCurrent()
  let row = await journal.operation(input.operation)
  if (row === null)
    throw new NotFoundError('repository-preparation-not-found', 'preparation operation not found')
  const diagnostics = row.diagnosticsJson === null ? null : JSON.parse(row.diagnosticsJson)
  const saved =
    diagnostics?.kind === 'repository-cleanup-v1'
      ? (diagnostics as {
          kind: 'repository-cleanup-v1'
          preparationDiagnosticsJson: string | null
          complete: boolean
          receiptJson: string
        })
      : null
  if (row.state === 'cleaned') {
    if (saved?.complete !== true) throw new Error('repository-cleanup-receipt-missing')
    return { complete: true, receiptJson: saved.receiptJson }
  }
  const preparationDiagnosticsJson =
    saved === null ? row.diagnosticsJson : saved.preparationDiagnosticsJson
  if (row.state === 'planned' || row.state === 'resolving' || row.state === 'materializing') {
    await effects.assertCurrent()
    row = await journal.advance({
      id: row.id,
      expectedVersion: row.version,
      from: row.state,
      to: 'stopped',
      now: input.now(),
    })
    if (row === null)
      throw new ConflictError('repository-preparation-version-changed', 'preparation owner changed')
  }
  if (row.state !== 'prepared' && row.state !== 'failed' && row.state !== 'stopped')
    throw new Error('repository-cleanup-state-invalid')
  await effects.assertCurrent()
  const result = await effects.cleanup({
    planJson: row.resolvedJson,
    diagnosticsJson: preparationDiagnosticsJson,
  })
  await effects.assertCurrent()
  const accepted = await journal.recordCleanup({
    id: row.id,
    expectedVersion: row.version,
    from: row.state,
    complete: result.complete,
    now: input.now(),
    diagnosticsJson: JSON.stringify({
      kind: 'repository-cleanup-v1',
      preparationDiagnosticsJson,
      ...result,
    }),
  })
  if (accepted === null)
    throw new ConflictError('repository-preparation-version-changed', 'preparation owner changed')
  await effects.assertCurrent()
  return result
}
