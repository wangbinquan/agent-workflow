import { sha256Hex } from '@/util/hash'
import type {
  CompleteCalculationContext,
  CompleteTaskCalculationVersion,
} from '../ports/completeCalculationFacts'
import type {
  CompleteObservationTaskInput,
  CompleteObservationTaskNumeric,
} from '../ports/completeObservationTask'

/** Bump for any numerical, ownership, coverage or valuation algorithm change. */
export const COMPLETE_TASK_CALCULATION_ALGORITHM = 'task-numeric-20261012-v1' as const
export const calculationNamespaceFields = [
  'attemptsNamespace',
  'invocationsNamespace',
  'allocationsNamespace',
  'originalNativeAllocationsNamespace',
  'unallocatedQualityNamespace',
  'nativeCapturesNamespace',
  'platformCapturesNamespace',
] as const
export const calculationSourceKey = (context: CompleteCalculationContext) =>
  sha256Hex(
    JSON.stringify([
      COMPLETE_TASK_CALCULATION_ALGORITHM,
      context.source,
      context.native,
      context.actorScope,
    ]),
  )
export const taskCalculationKey = (sourceKey: string, input: CompleteObservationTaskInput) =>
  sha256Hex(
    JSON.stringify([
      sourceKey,
      input.task,
      input.occurrenceVersions === undefined ? 'accepted-clock' : 'original-native-clock',
    ]),
  )
export const taskCalculationContentDigest = (
  version: Omit<CompleteTaskCalculationVersion, 'contentDigest'>,
) => sha256Hex(JSON.stringify(version))
export class CompleteCalculationInvalid extends Error {}

export function relativeTaskCalculation(
  input: CompleteObservationTaskInput,
  numeric: CompleteObservationTaskNumeric,
) {
  const relative = { ...numeric }
  for (const field of calculationNamespaceFields) {
    const namespace = numeric[field]
    if (namespace === undefined) continue
    if (!namespace.startsWith(input.namespace + '/'))
      throw new CompleteCalculationInvalid('Original numeric namespace changed')
    Object.assign(relative, { [field]: namespace.slice(input.namespace.length) })
  }
  return relative
}
export function restoreTaskCalculation(
  input: CompleteObservationTaskInput,
  numeric: CompleteObservationTaskNumeric,
) {
  const restored = { ...numeric }
  for (const field of calculationNamespaceFields) {
    const namespace = numeric[field]
    if (namespace === undefined) continue
    if (!namespace.startsWith('/'))
      throw new CompleteCalculationInvalid('Relative numeric namespace missing')
    Object.assign(restored, { [field]: input.namespace + namespace })
  }
  return restored
}
export function parseTaskCalculationVersion(
  value: unknown,
  sourceKey: string,
  cacheKey: string,
): CompleteTaskCalculationVersion {
  if (!value || typeof value !== 'object')
    throw new CompleteCalculationInvalid('Numeric calculation header missing')
  const version = value as CompleteTaskCalculationVersion
  if (
    version.algorithm !== COMPLETE_TASK_CALCULATION_ALGORITHM ||
    version.sourceKey !== sourceKey ||
    version.cacheKey !== cacheKey ||
    !/^(0|[1-9]\d*)$/.test(version.rows) ||
    !Array.isArray(version.groups) ||
    !version.numeric?.summary?.task ||
    !Array.isArray(version.numeric.sourceReceipts)
  )
    throw new CompleteCalculationInvalid('Numeric calculation identity changed')
  const { contentDigest, ...body } = version
  if (contentDigest !== taskCalculationContentDigest(body))
    throw new CompleteCalculationInvalid('Numeric calculation header content changed')
  const groups = new Set<string>()
  let rows = 0n
  for (const group of version.groups) {
    if (
      !group ||
      typeof group.namespace !== 'string' ||
      !group.namespace.startsWith('/') ||
      groups.has(group.namespace) ||
      !/^(0|[1-9]\d*)$/.test(group.rows) ||
      !/^[a-f0-9]{64}$/.test(group.digest)
    )
      throw new CompleteCalculationInvalid('Numeric calculation group changed')
    groups.add(group.namespace)
    rows += BigInt(group.rows)
  }
  const expected = new Set<string>(['/platform-states'])
  for (const field of calculationNamespaceFields) {
    const name = version.numeric[field]
    if (name === undefined && field === 'originalNativeAllocationsNamespace') continue
    if (typeof name !== 'string' || !name.startsWith('/'))
      throw new CompleteCalculationInvalid('Numeric calculation namespace missing')
    expected.add(name)
  }
  if (
    rows !== BigInt(version.rows) ||
    groups.size !== expected.size ||
    [...expected].some((namespace) => !groups.has(namespace))
  )
    throw new CompleteCalculationInvalid('Numeric calculation complete population changed')
  return version
}
