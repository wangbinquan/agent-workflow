import { join } from 'node:path'
import { isSingleRootRepository } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from '../contentRef'

export interface PortArchiveItem {
  path: string
  file: string | null
  size: number
  truncated: boolean
  linkTarget?: string
}
export interface PortArchive {
  v: 1
  items: PortArchiveItem[]
}

/** Keep the original JSON alongside its roster: whitespace and extra keys are durable. */
export function decodePortArchive(
  raw: string | null | undefined,
): { readonly raw: string; readonly archive: PortArchive } | null {
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
    return { raw, archive: parsed as PortArchive }
  } catch {
    return null
  }
}
export function encodePortArchive(
  value: NonNullable<ReturnType<typeof decodePortArchive>>,
): string {
  return value.raw
}
export function copyPortArchive(raw: string | null): string | null {
  // A copy preserves every byte, including malformed historical payloads.
  return raw
}
export function decodePortArchiveFile(
  file: string,
  storage: 'local-file' | 'object' = 'local-file',
): ContentRef<string> {
  // items[].size is the source size, not the bytes after the truncation notice.
  return legacyContentRef('port-archive-file', storage, file)
}
export function portSegment(portName: string): string {
  return `${portName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)}_${sha256Hex(portName).slice(0, 16)}`
}
export function portArchiveTaskRoot(taskId: string): string {
  return join('runs', taskId, 'ports')
}
export function portArchiveRoot(taskId: string, nodeRunId: string): string {
  return join(portArchiveTaskRoot(taskId), nodeRunId)
}
export function portArchivePath(
  taskId: string,
  nodeRunId: string,
  portName: string,
  index: number,
  extension: string,
): string {
  return join(
    portArchiveRoot(taskId, nodeRunId),
    portSegment(portName),
    `item_${index}${extension}`,
  )
}
export function containerPath(mountPath: string, path: string): string {
  return mountPath === '' ? path : join(mountPath, path)
}
export function portFallbackMount(mountPaths: readonly string[]): string {
  return isSingleRootRepository([...mountPaths]) ? '' : (mountPaths[0] ?? '')
}

export function hostedPortArchivePath(
  taskId: string,
  nodeRunId: string,
  portName: string,
  index: number,
  extension: string,
): string {
  return `${portArchiveRoot(taskId, nodeRunId).replace(/\\/g, '/')}/${portSegment(portName)}/item_${index}${extension}`
}
export function portArchiveTask(reference: string): string | null {
  return /^runs\/([^/]+)\/ports\//.exec(reference)?.[1] ?? null
}
