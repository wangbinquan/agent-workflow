import type {
  ObservationNativeScopeReference,
  ObservationUsageMeasurement,
} from '@agent-workflow/shared'

export interface NativeUsageScopeFacts {
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly depth: string
  readonly pathDigest: string
  readonly nativeSource: string
  readonly sourceGeneration: string
}
export function isNativeUsageScope(
  scope: ObservationUsageMeasurement['scope'],
): scope is ObservationNativeScopeReference {
  return scope !== undefined && 'ancestry' in scope
}
/** Page progress may advance without changing the actual semantic session identity. */
export function sameNativeUsageScope(
  a: ObservationUsageMeasurement['scope'],
  b: ObservationUsageMeasurement['scope'],
  previous?: NativeUsageScopeFacts,
  next?: NativeUsageScopeFacts,
) {
  if (!isNativeUsageScope(a) || !isNativeUsageScope(b))
    return JSON.stringify(a) === JSON.stringify(b)
  return (
    previous !== undefined &&
    next !== undefined &&
    JSON.stringify(previous) === JSON.stringify(next) &&
    (['root', 'session', 'parentSession', 'turn', 'turnIndex', 'level'] as const).every(
      (key) => a[key] === b[key],
    )
  )
}
