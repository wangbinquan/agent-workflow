// RFC-455 — zip decoding for skill zips and resource packages: raw bytes → normalised entries (safety limits + zip-slip).
// Moved verbatim from `infrastructure/legacy/skill-zip.ts` (the skill-zip importer and the package parser in
// `application/package/parse.ts` both decode through it; the application layer may not import infrastructure). Pure: fflate,
// shared limits and `ValidationError` only.

import { Unzip, UnzipInflate, unzipSync, type UnzipFileInfo } from 'fflate'
import { SKILL_ZIP_LIMITS, type ZipEntryRef } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

// Compatibility name retained for existing backend callers/tests. Safety
// enforcement remains here; RFC-196 only moves the values to shared so the
// frontend cannot drift from them.
export const ZIP_LIMITS = SKILL_ZIP_LIMITS

type SafeZipPath = {
  path: string
  isDir: boolean
}

type ZipCentralEntry = {
  name: string
  compression: number
  originalSize: number
}

// `UnzipInflate` grows its output buffer for each compressed input chunk before
// yielding it. Keep those chunks deliberately small so even a forged ZIP whose
// central-directory size understates the real DEFLATE output can only create a
// bounded transient allocation before the actual-byte counters stop decoding.
const ZIP_STREAM_INPUT_CHUNK_BYTES = 4 * 1024

function safeZipPath(rawPath: string): SafeZipPath {
  const normalisedPath = rawPath.replace(/\\/g, '/')

  if (normalisedPath.startsWith('/')) {
    throw new ValidationError(
      'zip-traversal',
      `absolute path inside zip is not allowed: ${rawPath}`,
    )
  }
  const segments = normalisedPath.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    throw new ValidationError('zip-decode-failed', 'zip entry path is empty')
  }
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new ValidationError('zip-traversal', `path traversal segment in zip entry: ${rawPath}`)
  }
  if (segments.length > ZIP_LIMITS.depth) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `zip entry too deep (${segments.length} > ${ZIP_LIMITS.depth}): ${rawPath}`,
    )
  }

  const isDir = normalisedPath.endsWith('/')
  return {
    path: segments.join('/'),
    isDir,
  }
}

function zipDecodeError(err: unknown): ValidationError {
  if (err instanceof ValidationError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new ValidationError('zip-decode-failed', `failed to decode zip: ${message}`)
}

function centralEntryKey(entry: ZipCentralEntry): string {
  return JSON.stringify([entry.name, entry.compression, entry.originalSize])
}

/**
 * Parse and validate every central-directory record without extracting any
 * entry. `fflate` invokes `filter` before allocating the advertised output
 * buffer, so returning false for every record makes entry-count, path and
 * declared-size failures true pre-inflate checks instead of post-hoc checks.
 */
function preflightZip(buffer: Uint8Array): ZipCentralEntry[] {
  const entries: ZipCentralEntry[] = []
  const seenPaths = new Set<string>()
  let totalBytes = 0

  try {
    unzipSync(buffer, {
      filter: (entry: UnzipFileInfo) => {
        if (entries.length >= ZIP_LIMITS.entries) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `zip has more than ${ZIP_LIMITS.entries} entries`,
          )
        }
        const safePath = safeZipPath(entry.name)
        if (seenPaths.has(safePath.path)) {
          throw new ValidationError(
            'zip-decode-failed',
            `duplicate normalized zip entry path '${safePath.path}'`,
          )
        }
        seenPaths.add(safePath.path)
        if (entry.compression !== 0 && entry.compression !== 8) {
          throw new ValidationError(
            'zip-decode-failed',
            `unsupported compression type ${entry.compression} for zip entry '${entry.name}'`,
          )
        }
        if (entry.originalSize > ZIP_LIMITS.perFileBytes) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `zip entry '${entry.name}' declares ${entry.originalSize} bytes (limit ${ZIP_LIMITS.perFileBytes})`,
          )
        }
        totalBytes += entry.originalSize
        if (totalBytes > ZIP_LIMITS.totalBytes) {
          throw new ValidationError(
            'zip-limit-exceeded',
            `total uncompressed size exceeds ${ZIP_LIMITS.totalBytes} bytes`,
          )
        }
        entries.push({
          name: entry.name,
          compression: entry.compression,
          originalSize: entry.originalSize,
        })
        return false
      },
    })
  } catch (err) {
    throw zipDecodeError(err)
  }

  return entries
}

function mergeZipChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Decode a raw zip buffer into normalised entries. Throws ValidationError on
 * any structural / safety failure (zip-slip, oversized, traversal, decode
 * failure). Pure / no IO besides the fflate call.
 */
export function decodeZip(buffer: Uint8Array): ZipEntryRef[] {
  if (buffer.byteLength > ZIP_LIMITS.totalBytes) {
    throw new ValidationError(
      'zip-limit-exceeded',
      `zip body exceeds ${ZIP_LIMITS.totalBytes} bytes`,
    )
  }

  const centralEntries = preflightZip(buffer)
  const remainingCentralEntries = new Map<string, number>()
  for (const entry of centralEntries) {
    const key = centralEntryKey(entry)
    remainingCentralEntries.set(key, (remainingCentralEntries.get(key) ?? 0) + 1)
  }

  let failure: unknown
  const out: ZipEntryRef[] = []
  let totalBytes = 0
  let localEntryCount = 0

  const unzip = new Unzip((file) => {
    if (failure !== undefined) return
    localEntryCount += 1
    if (localEntryCount > ZIP_LIMITS.entries || localEntryCount > centralEntries.length) {
      failure = new ValidationError(
        'zip-limit-exceeded',
        `zip has more than ${ZIP_LIMITS.entries} entries`,
      )
      return
    }

    let safePath: SafeZipPath
    try {
      safePath = safeZipPath(file.name)
    } catch (err) {
      failure = err
      return
    }
    if (file.compression !== 0 && file.compression !== 8) {
      failure = new ValidationError(
        'zip-decode-failed',
        `unsupported compression type ${file.compression} for zip entry '${file.name}'`,
      )
      return
    }
    if (file.originalSize !== undefined && file.originalSize > ZIP_LIMITS.perFileBytes) {
      failure = new ValidationError(
        'zip-limit-exceeded',
        `zip entry '${file.name}' declares ${file.originalSize} bytes (limit ${ZIP_LIMITS.perFileBytes})`,
      )
      return
    }

    const chunks: Uint8Array[] = []
    let entryBytes = 0
    file.ondata = (err, chunk, final) => {
      if (failure !== undefined) return
      if (err) {
        failure = err
        return
      }
      if (chunk !== null && chunk.byteLength > 0) {
        const nextEntryBytes = entryBytes + chunk.byteLength
        if (nextEntryBytes > ZIP_LIMITS.perFileBytes) {
          failure = new ValidationError(
            'zip-limit-exceeded',
            `zip entry '${file.name}' exceeds ${ZIP_LIMITS.perFileBytes} bytes while inflating`,
          )
          file.terminate()
          return
        }
        const nextTotalBytes = totalBytes + chunk.byteLength
        if (nextTotalBytes > ZIP_LIMITS.totalBytes) {
          failure = new ValidationError(
            'zip-limit-exceeded',
            `total uncompressed size exceeds ${ZIP_LIMITS.totalBytes} bytes`,
          )
          file.terminate()
          return
        }
        chunks.push(chunk)
        entryBytes = nextEntryBytes
        totalBytes = nextTotalBytes
      }
      if (!final) return

      const centralKey = centralEntryKey({
        name: file.name,
        compression: file.compression,
        originalSize: entryBytes,
      })
      const remaining = remainingCentralEntries.get(centralKey) ?? 0
      if (remaining === 0) {
        failure = new ValidationError(
          'zip-decode-failed',
          `zip local header/output does not match central directory for '${file.name}'`,
        )
        return
      }
      if (remaining === 1) remainingCentralEntries.delete(centralKey)
      else remainingCentralEntries.set(centralKey, remaining - 1)

      if (safePath.path.length === 0) return
      const cached = mergeZipChunks(chunks, entryBytes)
      chunks.length = 0
      out.push({
        path: safePath.path,
        isDir: safePath.isDir,
        size: entryBytes,
        bytes: () => cached,
      })
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  try {
    for (let offset = 0; offset < buffer.byteLength; offset += ZIP_STREAM_INPUT_CHUNK_BYTES) {
      const end = Math.min(buffer.byteLength, offset + ZIP_STREAM_INPUT_CHUNK_BYTES)
      unzip.push(buffer.subarray(offset, end), end === buffer.byteLength)
      if (failure !== undefined) break
    }
  } catch (err) {
    failure ??= err
  }

  if (failure !== undefined) throw zipDecodeError(failure)
  if (localEntryCount !== centralEntries.length || remainingCentralEntries.size > 0) {
    throw new ValidationError(
      'zip-decode-failed',
      'zip local entries do not match the central directory',
    )
  }

  return out
}
