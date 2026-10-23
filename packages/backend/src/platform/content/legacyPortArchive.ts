import { join } from 'node:path'
import { isSingleRootRepository } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from './contentRef'

export interface LegacyPortArchiveItem {
  path: string
  file: string | null
  size: number
  truncated: boolean
  linkTarget?: string
}
export interface LegacyPortArchive {
  v: 1
  items: LegacyPortArchiveItem[]
}

/** Keep the original JSON alongside its roster: whitespace and extra keys are durable. */
export function decodeLegacyPortArchive(
  raw: string | null | undefined,
): { readonly raw: string; readonly archive: LegacyPortArchive } | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { v?: unknown }).v !== 1 ||
      !Array.isArray((parsed as { items?: unknown }).items)
    )
      return null
    return { raw, archive: parsed as LegacyPortArchive }
  } catch {
    return null
  }
}
export function encodeLegacyPortArchive(
  value: NonNullable<ReturnType<typeof decodeLegacyPortArchive>>,
): string {
  return value.raw
}
export function copyLegacyPortArchive(raw: string | null): string | null {
  // A copy preserves every byte, including malformed historical payloads.
  return raw
}
export function decodeLegacyPortArchiveFile(
  file: string,
  storage: 'local-file' | 'object' = 'local-file',
): ContentRef<string> {
  // items[].size is the source size, not the bytes after the truncation notice.
  return legacyContentRef('port-archive-file', storage, file)
}
export function legacyPortSegment(portName: string): string {
  return `${portName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)}_${sha256Hex(portName).slice(0, 16)}`
}
export function legacyPortArchiveTaskRoot(taskId: string): string {
  return join('runs', taskId, 'ports')
}
export function legacyPortArchiveRoot(taskId: string, nodeRunId: string): string {
  return join(legacyPortArchiveTaskRoot(taskId), nodeRunId)
}
export function legacyPortArchivePath(
  taskId: string,
  nodeRunId: string,
  portName: string,
  index: number,
  extension: string,
): string {
  return join(
    legacyPortArchiveRoot(taskId, nodeRunId),
    legacyPortSegment(portName),
    `item_${index}${extension}`,
  )
}
export function legacyContainerPath(mountPath: string, path: string): string {
  return mountPath === '' ? path : join(mountPath, path)
}
export function legacyPortFallbackMount(mountPaths: readonly string[]): string {
  return isSingleRootRepository([...mountPaths]) ? '' : (mountPaths[0] ?? '')
}

export function legacyHostedPortArchivePath(
  taskId: string,
  nodeRunId: string,
  portName: string,
  index: number,
  extension: string,
): string {
  return `${legacyPortArchiveRoot(taskId, nodeRunId).replace(/\\/g, '/')}/${legacyPortSegment(portName)}/item_${index}${extension}`
}
export function legacyPortArchiveTask(reference: string): string | null {
  return /^runs\/([^/]+)\/ports\//.exec(reference)?.[1] ?? null
}
