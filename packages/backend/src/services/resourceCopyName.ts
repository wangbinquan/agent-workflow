const COPY_NAME_MAX_LENGTH = 128

function normalizeCopyBase(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (normalized.length > 0) return normalized

  const normalizedFallback = fallback
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  return normalizedFallback.length > 0 ? normalizedFallback : 'resource'
}

function copyCandidate(base: string, sequence: bigint, fallback: string): string {
  const suffix = sequence === 1n ? '-copy' : `-copy-${sequence.toString()}`
  const maxBaseLength = COPY_NAME_MAX_LENGTH - suffix.length
  if (maxBaseLength < 1) {
    throw new Error('copy name sequence no longer fits the resource name limit')
  }

  const truncated = base.slice(0, maxBaseLength).replace(/[-_]+$/g, '')
  const safeBase =
    truncated.length > 0
      ? truncated
      : normalizeCopyBase(fallback, 'resource')
          .slice(0, maxBaseLength)
          .replace(/[-_]+$/g, '')
  if (safeBase.length === 0) {
    throw new Error('copy name base no longer fits the resource name limit')
  }
  return `${safeBase}${suffix}`
}

/**
 * RFC-231 deterministic copy naming in one owner's resource namespace.
 *
 * A copy of `foo` starts at `foo-copy`; a copy of `foo-copy` starts at
 * `foo-copy-2`; and a copy of `foo-copy-2` starts at `foo-copy-3`.
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
