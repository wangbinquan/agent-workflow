import { normalizeResourceDisplayName, RESOURCE_DISPLAY_NAME_MAX } from '@agent-workflow/shared'

/**
 * RFC-264: the base keeps the source name's own characters (Chinese included);
 * only the framework-owned parts stay ASCII. Previously this lowercased and
 * folded everything outside `[a-z0-9_-]`, so a copy of 「代码审计流水线」 came
 * out as the bare fallback `workflow-copy`.
 *
 * Leading `_` is stripped because the name rule reserves that prefix for the
 * framework's `__agent_host__` / `__workgroup_host__` rows.
 */
function normalizeCopyBase(value: string, fallback: string): string {
  const normalized = normalizeResourceDisplayName(value).replace(/^[-_]+|[-_]+$/g, '')
  if (normalized.length > 0) return normalized

  const normalizedFallback = normalizeResourceDisplayName(fallback).replace(/^[-_]+|[-_]+$/g, '')
  return normalizedFallback.length > 0 ? normalizedFallback : 'resource'
}

/**
 * Truncate by CODE POINT. `String.prototype.slice` cuts UTF-16 units and will
 * split a surrogate pair (emoji, extension-B ideographs) into a lone surrogate
 * — which the RFC-264 name rule then rejects, turning "copy" into a 500. The
 * old ASCII-only charset hid this.
 */
function truncateCodePoints(value: string, max: number): string {
  const points = [...value]
  return points.length <= max ? value : points.slice(0, max).join('')
}

function copyCandidate(base: string, sequence: bigint, fallback: string): string {
  const suffix = sequence === 1n ? '-copy' : `-copy-${sequence.toString()}`
  const maxBaseLength = RESOURCE_DISPLAY_NAME_MAX - suffix.length
  if (maxBaseLength < 1) {
    throw new Error('copy name sequence no longer fits the resource name limit')
  }

  const truncated = truncateCodePoints(base, maxBaseLength).replace(/[-_\s]+$/gu, '')
  const safeBase =
    truncated.length > 0
      ? truncated
      : truncateCodePoints(normalizeCopyBase(fallback, 'resource'), maxBaseLength).replace(
          /[-_\s]+$/gu,
          '',
        )
  if (safeBase.length === 0) {
    throw new Error('copy name base no longer fits the resource name limit')
  }
  return `${safeBase}${suffix}`
}

/**
 * RFC-231 deterministic copy naming in one owner's resource namespace.
 *
 * A copy of `foo` starts at `foo-copy`; a copy of `foo-copy` starts at
 * `foo-copy-2`; and a copy of `foo-copy-2` starts at `foo-copy-3`. RFC-264:
 * the `-copy` suffix family stays ASCII, the base keeps its own script, so
 * 「代码审计」 copies to 「代码审计-copy」.
 */
export function nextResourceCopyName(
  sourceName: string,
  occupiedOwnerNames: Iterable<string>,
  fallback: 'workflow' | 'workgroup',
): string {
  const normalized = normalizeCopyBase(sourceName, fallback)
  const match = /^(.*)-copy(?:-([2-9][0-9]*))?$/.exec(normalized)
  const base = match === null ? normalized : normalizeCopyBase(match[1] ?? '', fallback)
  let sequence = match === null ? 1n : match[2] === undefined ? 2n : BigInt(match[2]) + 1n
  const occupied = new Set(occupiedOwnerNames)

  for (;;) {
    const candidate = copyCandidate(base, sequence, fallback)
    if (!occupied.has(candidate)) return candidate
    sequence += 1n
  }
}
