/** Callers keep their original JSON.parse expression and row-read error boundary. */
export function parseAgentDependencyIds(decode: () => unknown): string[] {
  try {
    const decoded: unknown = decode()
    if (!Array.isArray(decoded)) return []
    return decoded.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}
