type DisplayValues<T> = Omit<T, 'retryIndex' | 'scopePath'> &
  ('retryIndex' extends keyof T ? { readonly retryIndex: number } : object) &
  ('scopePath' extends keyof T ? { readonly scopePath: string } : object)

/** AD-12: missing target facts are recovered from evidence, never invented for display. */
export function projectNodeRunDisplayValues<T extends object>(
  values: T,
  source: Readonly<Record<string, unknown>> | null,
  runId: string,
): DisplayValues<T> {
  const restored: Record<string, unknown> = Object.fromEntries(Object.entries(values))
  if (source !== null) {
    for (const [field, value] of Object.entries(restored)) {
      // seq is the approved backfilled order; identity/selection metadata is internal.
      if (value !== null || ['seq', 'slot', 'role', 'attemptIndex'].includes(field)) continue
      const column =
        field === 'retryIndex'
          ? 'retry_index'
          : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
      if (Object.hasOwn(source, column)) restored[field] = source[column]
    }
  }
  if (
    Object.hasOwn(values, 'retryIndex') &&
    (typeof restored.retryIndex !== 'number' ||
      !Number.isSafeInteger(restored.retryIndex) ||
      restored.retryIndex < 0)
  )
    throw new Error(`node-run-display-evidence-invalid:${runId}:retry_index`)
  if (Object.hasOwn(values, 'scopePath') && typeof restored.scopePath !== 'string')
    throw new Error(`node-run-display-evidence-invalid:${runId}:scope_path`)
  return restored as DisplayValues<T>
}
