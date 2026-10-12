import { sha256Hex } from '@/util/hash'
import { CompleteCalculationInvalid } from './completeCalculationFacts'
import type {
  HistoricalObservationPreparationGroup,
  HistoricalObservationPreparationVersion,
} from '../ports/historicalObservationPreparation'

export const HISTORICAL_PREPARATION_ALGORITHM = 'historical-preparation-20261012-v1' as const
export const HISTORICAL_PREPARATION_GROUPS = '/@groups'
export const historicalPreparationKey = (sourceKey: string) =>
  sha256Hex(JSON.stringify([HISTORICAL_PREPARATION_ALGORITHM, sourceKey]))
export const historicalPreparationContentDigest = (
  version: Omit<HistoricalObservationPreparationVersion, 'contentDigest'>,
) => sha256Hex(JSON.stringify(version))
const count = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function parseHistoricalPreparationGroup(
  name: string,
  value: unknown,
): HistoricalObservationPreparationGroup {
  const group = value as HistoricalObservationPreparationGroup | null
  if (
    !name.startsWith('/') ||
    name === HISTORICAL_PREPARATION_GROUPS ||
    !group ||
    !count(group.rows) ||
    !digest(group.digest) ||
    (group.rows === '0' && group.digest !== sha256Hex(''))
  )
    throw new CompleteCalculationInvalid('Historical preparation group changed')
  return group
}
export function parseHistoricalPreparationVersion(
  value: unknown,
  sourceKey: string,
  cacheKey: string,
): HistoricalObservationPreparationVersion {
  const version = value as HistoricalObservationPreparationVersion | null
  if (
    !version ||
    version.algorithm !== HISTORICAL_PREPARATION_ALGORITHM ||
    version.sourceKey !== sourceKey ||
    version.cacheKey !== cacheKey ||
    !count(version.sourceRows) ||
    !count(version.groups) ||
    BigInt(version.groups) < 5n ||
    !count(version.rows) ||
    BigInt(version.rows) < BigInt(version.groups) ||
    !digest(version.groupDigest)
  )
    throw new CompleteCalculationInvalid('Historical preparation header changed')
  const { contentDigest, ...body } = version
  if (contentDigest !== historicalPreparationContentDigest(body))
    throw new CompleteCalculationInvalid('Historical preparation content changed')
  return version
}
