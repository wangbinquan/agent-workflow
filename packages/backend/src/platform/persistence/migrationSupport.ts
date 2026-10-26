import type { DatabaseProvider } from './databaseProviders'

const paths = [
  { sourceProvider: 'sqlite', targetProvider: 'sqlite', sourceEpoch: 1, targetEpoch: 2 },
  { sourceProvider: 'sqlite', targetProvider: 'postgresql', sourceEpoch: 1, targetEpoch: 2 },
  { sourceProvider: 'postgresql', targetProvider: 'postgresql', sourceEpoch: 1, targetEpoch: 2 },
  { sourceProvider: 'sqlite', targetProvider: 'postgresql', sourceEpoch: 2, targetEpoch: 2 },
] as const
export function supportsDatabaseMigration(input: {
  sourceProvider: DatabaseProvider
  targetProvider: DatabaseProvider
  sourceEpoch: number
  targetEpoch: number
}): boolean {
  return paths.some((path) =>
    Object.entries(path).every(([key, value]) => input[key as keyof typeof input] === value),
  )
}
/** The current same-epoch move's target type is derived from its supported pair. */
export function supportsProviderMove(
  source: DatabaseProvider,
  target: DatabaseProvider,
): target is 'postgresql' {
  return supportsDatabaseMigration({
    sourceProvider: source,
    targetProvider: target,
    sourceEpoch: 2,
    targetEpoch: 2,
  })
}
