import { WORKTREE_FILE_MAX_BYTES, tryParseKind } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type { PortArchive, PortArchiveItem } from '../application/ports/portArtifactContent'

export function encodePortSegment(portName: string): string {
  const sanitized = portName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
  const digest = sha256Hex(portName).slice(0, 16)
  return `${sanitized}_${digest}`
}

export function repoRelForcedPaths(
  containerPaths: readonly string[] | undefined,
  worktreeDirName: string,
): string[] {
  if (containerPaths === undefined || containerPaths.length === 0) return []
  if (worktreeDirName === '') return [...containerPaths]
  const prefix = worktreeDirName + '/'
  return containerPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}

export function parseArchiveJson(raw: string | null | undefined): PortArchive | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== 1 ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return null
    }
    return parsed as PortArchive
  } catch {
    return null
  }
}

export function truncationNotice(containerRelPath: string): string {
  return `\n\n> ⚠️ [RFC-193] content truncated at ${Math.floor(WORKTREE_FILE_MAX_BYTES / (1024 * 1024))} MiB — full file in worktree: \`${containerRelPath}\`\n`
}

export function isPathishKindString(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined) return false
  const parsed = tryParseKind(kind)
  return (
    parsed !== null &&
    (parsed.kind === 'path' || (parsed.kind === 'list' && parsed.item.kind === 'path'))
  )
}

export function missingArtifactPlaceholder(path: string | null): string {
  return `> ⚠️ RFC-079: file not found in worktree: \`${path ?? '(unknown)'}\``
}

export function subsetArchiveJson(
  upstreamArchiveJson: string | null,
  wantPaths: readonly string[],
): string | null {
  const arch = parseArchiveJson(upstreamArchiveJson)
  if (arch === null) return null
  const items: PortArchiveItem[] = []
  for (const want of wantPaths) {
    const hit =
      arch.items.find((i) => i.path === want) ?? arch.items.find((i) => i.path.endsWith('/' + want))
    if (hit !== undefined) items.push(hit)
  }
  return items.length > 0 ? JSON.stringify({ v: 1, items } satisfies PortArchive) : null
}
