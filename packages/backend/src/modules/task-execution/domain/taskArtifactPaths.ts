import { parseTaskPlatformInputPaths } from './taskPlatformInputPaths'

interface ArtifactArchiveItem {
  readonly path: string
  readonly linkTarget?: string
}

function archiveItems(raw: string | null): readonly ArtifactArchiveItem[] {
  if (raw === null || raw === '') return []
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value === null ||
      typeof value !== 'object' ||
      (value as { v?: unknown }).v !== 1 ||
      !Array.isArray((value as { items?: unknown }).items)
    ) {
      return []
    }
    return (value as { items: ArtifactArchiveItem[] }).items.filter(
      (item) => item !== null && typeof item === 'object' && typeof item.path === 'string',
    )
  } catch {
    return []
  }
}

export function collectTaskArtifactPaths(
  task: { readonly spaceKind: string; readonly platformInputPathsJson: string | null } | undefined,
  rows: readonly { readonly archiveJson: string | null }[],
): readonly string[] {
  const paths = new Set<string>()
  if (task?.platformInputPathsJson !== null && task?.platformInputPathsJson !== undefined) {
    if (task.spaceKind !== 'internal') {
      throw new Error('non-internal task carries a platform input path roster')
    }
    for (const path of parseTaskPlatformInputPaths(task.platformInputPathsJson)) paths.add(path)
  }
  for (const row of rows) {
    for (const item of archiveItems(row.archiveJson)) {
      paths.add(item.path)
      if (item.linkTarget !== undefined) paths.add(item.linkTarget)
    }
  }
  return [...paths]
}
