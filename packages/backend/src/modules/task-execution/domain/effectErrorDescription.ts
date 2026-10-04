/** Preserve the original printable diagnostics without replacing an arbitrary rejection. */
export function describeEffectError(error: unknown): string {
  try {
    const description = error instanceof Error ? error.message : String(error)
    return typeof description === 'string' ? description : String(description)
  } catch {
    return 'unavailable error description'
  }
}
