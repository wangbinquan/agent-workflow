import { ulid } from 'ulid'
import { ConflictError, NotFoundError } from '@/util/errors'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'
import type {
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  WorkspacePreparationExecutionOutcome,
} from '../public/types'
import type {
  RepositoryPreparationJournal,
  RepositoryPreparationRecord,
} from './ports/repositoryPreparationJournal'
import type { RepositoryPreparationEffects } from './ports/repositoryPreparationEffects'
import { readRepositoryPreparationFactsFromJournal } from './repositoryLaunchSnapshot'

/**
 * One operation is driven only by its current Task-owned attempt. Durable state,
 * not a process-local result cache, decides replay after a process interruption.
 */
export async function prepareRepositoryWorkspace(input: {
  readonly journal: RepositoryPreparationJournal
  readonly effects: RepositoryPreparationEffects
  readonly operation: RepositoryPreparationOperationRef
  readonly source: FrozenRepositoryPreparationRef
  readonly now: () => number
}): Promise<WorkspacePreparationExecutionOutcome> {
  const { journal, effects, now } = input
  await effects.assertCurrent()
  let row = await journal.operation(input.operation)
  if (row === null)
    throw new NotFoundError('repository-preparation-not-found', 'preparation operation not found')
  if (row.snapshotRef !== input.source)
    throw new ConflictError('repository-preparation-source-mismatch', 'operation source changed')

  async function accept(next: RepositoryPreparationRecord | null) {
    if (next === null)
      throw new ConflictError('repository-preparation-version-changed', 'preparation owner changed')
    row = next
    await effects.assertCurrent()
  }
  async function advance(
    to: 'resolving' | 'materializing' | 'prepared' | 'failed' | 'stopped',
    facts: {
      resolvedJson?: string
      receiptRef?: string
      receiptJson?: string
      failureCode?: string
      diagnosticsJson?: string
    } = {},
  ) {
    await effects.assertCurrent()
    await accept(
      await journal.advance({
        id: input.operation,
        expectedVersion: row!.version,
        from: row!.state,
        to,
        now: now(),
        ...facts,
      }),
    )
  }

  if (row.state === 'planned') await advance('resolving')
  // TypeScript cannot see the database transition made by advance; re-read the
  // durable row, which is also the point at which a restarted driver joins.
  row = (await journal.operation(input.operation))!
  await effects.assertCurrent()
  if (row.state === 'resolving') {
    const facts = await readRepositoryPreparationFactsFromJournal(journal, input.source)
    const resolved = await effects.resolveCommits(facts)
    if (resolved.kind === 'failed') {
      await advance('failed', {
        failureCode: resolved.safeCode,
        diagnosticsJson: resolved.diagnosticsJson,
      })
    } else {
      // This await must finish before any worktree mutation starts.
      await advance('materializing', { resolvedJson: resolved.planJson })
    }
  }
  row = (await journal.operation(input.operation))!
  await effects.assertCurrent()
  if (row.state === 'materializing') {
    if (row.resolvedJson === null) throw new Error('repository-preparation-commits-missing')
    const result = await effects.materialize({
      planJson: row.resolvedJson,
      evidenceJson: row.diagnosticsJson,
      async checkpoint(evidenceJson) {
        await effects.assertCurrent()
        await accept(
          await journal.checkpoint({
            id: input.operation,
            expectedVersion: row!.version,
            now: now(),
            evidenceJson,
          }),
        )
      },
    })
    if (result.kind === 'prepared') {
      await advance('prepared', {
        receiptRef: `sc:receipt:v1:${ulid()}`,
        receiptJson: result.receiptJson,
      })
    } else if (result.kind === 'stopped') {
      await advance('stopped', { diagnosticsJson: result.receiptJson })
    } else {
      await advance('failed', {
        failureCode: result.safeCode,
        diagnosticsJson: result.diagnosticsJson,
      })
    }
  }
  const terminal = (await journal.operation(input.operation))!
  await effects.assertCurrent()
  if (terminal.state === 'prepared' && terminal.receiptRef !== null)
    return { kind: 'prepared', receipt: decodeRepositoryLaunchRef('receipt', terminal.receiptRef) }
  // These references resolve to the operation's durable diagnostics/stop record.
  const id = input.operation.slice('sc:operation:v1:'.length)
  if (terminal.state === 'stopped')
    return { kind: 'stopped', receipt: decodeRepositoryLaunchRef('stopped', `sc:stopped:v1:${id}`) }
  if (terminal.state === 'failed') {
    const safeCode = terminal.failureCode
    if (
      safeCode !== 'repository-unavailable' &&
      safeCode !== 'preparation-failed' &&
      safeCode !== 'replay-unavailable'
    )
      throw new Error('repository-preparation-failure-record-invalid')
    return {
      kind: 'failed',
      safeCode,
      diagnostics: decodeRepositoryLaunchRef('diagnostics', `sc:diagnostics:v1:${id}`),
    }
  }
  throw new ConflictError(
    'repository-preparation-replay-unavailable',
    `cannot prepare operation in ${terminal.state}`,
  )
}
