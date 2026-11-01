// Local operation artifact locations are resolved at the platform filesystem boundary.
import { join } from 'node:path'
import { epochArtifactFileName } from '../artifactFileName'

/** Logical artifact references become host file names (Windows rules: `epochArtifactFileName`). */
export function epochArtifactPath(root: string, ...references: readonly string[]): string {
  return epochArtifactPathFor(process.platform, root, ...references)
}

/** `platform` selects the file-name rules only; the separator stays the host's. */
export function epochArtifactPathFor(
  platform: NodeJS.Platform,
  root: string,
  ...references: readonly string[]
): string {
  return join(root, ...references.map((reference) => epochArtifactFileName(platform, reference)))
}

/** Hosted replay keeps logical operation-relative evidence while replacing the worker root. */
export function relocateEpochPath(path: string, operationId: string, root: string): string {
  const marker = `/${operationId}`
  const index = path.lastIndexOf(marker)
  if (index < 0 || (path[index + marker.length] && path[index + marker.length] !== '/')) return path
  return epochArtifactPath(root, path.slice(index + marker.length))
}
