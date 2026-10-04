// RFC-370: original upload declarations, limits and validation; no content effects.
import { findDuplicateUploadTarget, type UploadOnConflict } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

/** Hard defaults; routes override via config when caller wires settings. */
export const DEFAULT_UPLOAD_LIMITS = {
  perFile: 50 * 1024 * 1024, // 50 MiB
  perRequest: 200 * 1024 * 1024, // 200 MiB
  perCount: 20,
} as const

export interface UploadLimits {
  perFile: number
  perRequest: number
  perCount: number
}

/** Per-input declaration extracted from the workflow definition. */
export interface UploadInputDef {
  /** Input key matches portName per RFC-004. */
  key: string
  /** Repo-relative directory under the worktree. Validated upstream. */
  targetDir: string
  /** Optional whitelist of extension tokens (`.pdf`) or MIME globs (`image/*`). */
  accept?: readonly string[]
  /** Per-input override; clamped against `limits.perFile`. */
  maxFileSize?: number
  minCount?: number
  maxCount?: number
  /**
   * RFC-262 — same-name collision policy inside `targetDir`. Absent ⇒
   * `'rename'`, i.e. RFC-020's original behavior byte for byte.
   */
  onConflict?: UploadOnConflict
}

/** One incoming file after the route handler has read its bytes. */
export interface UploadFile {
  inputKey: string
  filename: string
  /** Client-declared mime; we never trust it for accept matching. */
  declaredMime: string
  bytes: Uint8Array
}

/**
 * Sniff a file's magic bytes and return a normalized MIME, or empty string
 * when we cannot identify it. Intentionally narrow: covers the common
 * upload payloads (PDF, images, plain text, ZIP). Anything else returns ''
 * and accept matching falls back to extension only.
 */
export function sniffMime(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  const b = bytes
  // %PDF-
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'
  // PNG
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png'
  }
  // JPEG (FF D8 FF)
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // GIF87a / GIF89a
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  // ZIP (PK\x03\x04)
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'application/zip'
  // Looks-like-text heuristic: ASCII / UTF-8 with no NUL in the first KiB.
  const sample = b.subarray(0, Math.min(b.length, 1024))
  let printable = 0
  for (const byte of sample) {
    if (byte === 0) return ''
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      printable++
    }
  }
  if (printable / sample.length > 0.85) return 'text/plain'
  return ''
}

/**
 * Match an `accept` whitelist entry against a filename and a sniffed MIME.
 * Returns true if any token matches by extension (`.pdf`) or MIME (`image/*`,
 * `text/plain`). Empty/undefined whitelist always matches.
 */
export function acceptMatches(
  accept: readonly string[] | undefined,
  filename: string,
  mime: string,
): boolean {
  if (accept === undefined || accept.length === 0) return true
  const ext = (filename.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
  for (const tokRaw of accept) {
    const tok = tokRaw.trim().toLowerCase()
    if (tok === '') continue
    if (tok.startsWith('.')) {
      if (ext === tok) return true
      continue
    }
    if (tok.endsWith('/*')) {
      const prefix = tok.slice(0, -1) // 'image/'
      if (mime !== '' && mime.toLowerCase().startsWith(prefix)) return true
      continue
    }
    if (mime !== '' && mime.toLowerCase() === tok) return true
  }
  return false
}

/**
 * Pre-flight validation for an upload plan: per-count, per-request total size,
 * per-file size (clamped by `def.maxFileSize`), the `accept` whitelist
 * (extension OR sniffed MIME), and per-input min/max count. Throws a
 * `ValidationError` on the first violation and writes NOTHING — it needs no
 * worktree, only the declared inputs + the incoming file bytes.
 *
 * RFC-107 (Codex impl-gate): split out of `applyUploadsToWorktree` so the
 * multipart route can reject a bad upload BEFORE it resolves/clones the repo
 * or materializes a worktree. Without this, a valid `repoUrl` + an oversized /
 * wrong-MIME / wrong-count upload would clone the repo and leave an orphan
 * worktree on disk before failing. `applyUploadsToWorktree` re-runs it as its
 * own pre-write guard so direct callers stay safe regardless of route ordering.
 */
export function validateUploadPlan(args: {
  defs: ReadonlyMap<string, UploadInputDef>
  files: readonly UploadFile[]
  limits: UploadLimits
}): void {
  const { defs, files, limits } = args
  if (files.length > limits.perCount) {
    throw new ValidationError(
      'upload-too-many-files',
      `upload count ${files.length} exceeds limit ${limits.perCount}`,
    )
  }
  let totalBytes = 0
  for (const f of files) totalBytes += f.bytes.byteLength
  if (totalBytes > limits.perRequest) {
    throw new ValidationError(
      'upload-too-large',
      `total upload size ${totalBytes} exceeds limit ${limits.perRequest}`,
    )
  }

  for (const f of files) {
    const def = defs.get(f.inputKey)
    if (def === undefined) {
      throw new ValidationError(
        'upload-unknown-input',
        `no upload-kind input declared for key '${f.inputKey}'`,
      )
    }
    const perFileCap = Math.min(limits.perFile, def.maxFileSize ?? limits.perFile)
    if (f.bytes.byteLength > perFileCap) {
      throw new ValidationError(
        'upload-file-too-large',
        `file '${f.filename}' size ${f.bytes.byteLength} exceeds cap ${perFileCap} for input '${f.inputKey}'`,
      )
    }
    const sniffed = sniffMime(f.bytes)
    if (!acceptMatches(def.accept, f.filename, sniffed)) {
      throw new ValidationError(
        'upload-mime-rejected',
        `file '${f.filename}' (sniffed mime '${sniffed || 'unknown'}') is not in the accept list for input '${f.inputKey}'`,
      )
    }
  }

  // RFC-262 (D4): two files in ONE submit that would land on the same path.
  // In `overwrite` mode the second write destroys the first silently; in
  // `rename` mode they survive under different names, but the user asked for a
  // single uniform rule — tell them to rename and resubmit rather than guessing
  // which same-named file they meant. Checked here (not at write time) so it
  // fires BEFORE the repo is resolved/cloned and the worktree materialized —
  // same ordering guarantee RFC-107 established for the size/accept checks.
  const dup = findDuplicateUploadTarget(
    files.map((f, i) => ({
      inputKey: f.inputKey,
      filename: f.filename,
      // Every declared key exists: the loop above already threw on unknowns.
      targetDir: defs.get(f.inputKey)?.targetDir ?? '',
      // Mirror the writer's 1-based counter so two nameless parts get distinct
      // `upload-<n>.bin` fallbacks here exactly as they will on disk.
      fallbackIndex: i + 1,
    })),
  )
  if (dup !== null) {
    throw new ValidationError(
      'upload-duplicate-filename',
      `two uploaded files would land on the same path '${dup.key}': '${dup.first.filename}' (input '${dup.first.inputKey}') and '${dup.second.filename}' (input '${dup.second.inputKey}'); rename one and resubmit`,
      {
        landingKey: dup.key,
        first: dup.first,
        second: dup.second,
      },
    )
  }

  // Per-input min/maxCount enforcement
  const countsByKey = new Map<string, number>()
  for (const f of files) {
    countsByKey.set(f.inputKey, (countsByKey.get(f.inputKey) ?? 0) + 1)
  }
  for (const def of defs.values()) {
    const n = countsByKey.get(def.key) ?? 0
    if (def.minCount !== undefined && n < def.minCount) {
      throw new ValidationError(
        'upload-min-count',
        `input '${def.key}' needs at least ${def.minCount} file(s); got ${n}`,
      )
    }
    if (def.maxCount !== undefined && n > def.maxCount) {
      throw new ValidationError(
        'upload-max-count',
        `input '${def.key}' allows at most ${def.maxCount} file(s); got ${n}`,
      )
    }
  }
}
