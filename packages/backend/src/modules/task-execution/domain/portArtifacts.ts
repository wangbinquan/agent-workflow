import { WORKTREE_FILE_MAX_BYTES, tryParseKind } from '@agent-workflow/shared'
import { decodeLegacyPortArchive } from '@/platform/content/legacyPortArchive'
import type { PortArchive, PortArchiveItem } from '../application/ports/portArtifactContent'

export { legacyPortSegment as encodePortSegment } from '@/platform/content/legacyPortArchive'
export { repoRelForcedPaths } from '@/modules/source-control/public/queries'

export function parseArchiveJson(raw: string | null | undefined): PortArchive | null {
  return decodeLegacyPortArchive(raw)?.archive ?? null
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
