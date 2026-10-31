export function repoRelForcedPaths(
  containerPaths: readonly string[] | undefined,
  mountPath: string,
): string[] {
  if (containerPaths === undefined || containerPaths.length === 0) return []
  if (mountPath === '') return [...containerPaths]
  const prefix = mountPath + '/'
  return containerPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}
