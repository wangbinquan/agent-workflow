export type RepositoryPreparationState =
  | 'planned'
  | 'resolving'
  | 'materializing'
  | 'prepared'
  | 'failed'
  | 'stopped'
  | 'cleaned'

const next: Readonly<Record<RepositoryPreparationState, readonly RepositoryPreparationState[]>> = {
  planned: ['resolving', 'stopped', 'failed'],
  resolving: ['materializing', 'stopped', 'failed'],
  materializing: ['prepared', 'stopped', 'failed'],
  prepared: ['cleaned'],
  stopped: ['cleaned'],
  failed: ['cleaned'],
  cleaned: [],
}

export function canAdvanceRepositoryPreparation(
  from: RepositoryPreparationState,
  to: RepositoryPreparationState,
): boolean {
  return next[from].includes(to)
}
