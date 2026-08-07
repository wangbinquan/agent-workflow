// RFC-262 — upload filename naming + landing-collision detection, hoisted out
// of the backend so the launcher can refuse a duplicate BEFORE it ships up to
// 200 MiB of bytes and the daemon computes the exact same verdict on arrival.
// One walker, one rule: if these two ever disagreed, the UI would green-light a
// launch the server then 422s (or worse, silently drop a file).
//
// `sanitizeUploadFilename` moved here verbatim from
// backend/src/services/upload.ts (RFC-020); the frontend cannot import backend
// modules, and duplicating it would be exactly the divergence this file exists
// to prevent.
//
// Dependency-free leaf: no zod, no node:path (this runs in the browser).

/**
 * Drop characters that could break path resolution or shell-pipe filenames
 * downstream. Path separators / control chars / leading dots all become
 * empty; the result is then NFC-normalized so visually-equivalent filenames
 * collide as expected during dedup.
 */
export function sanitizeUploadFilename(raw: string, fallbackIndex = 0): string {
  // Defense-in-depth: callers can hand us a non-string name. A multipart part
  // with `filename=""` parses (under bun) to a File whose `.name` is `undefined`,
  // so `raw` may be undefined/null at runtime despite the `string` type. Falling
  // back here avoids `undefined.replace(...)` ("undefined is not an object").
  if (typeof raw !== 'string' || raw === '') {
    return `upload-${fallbackIndex}.bin`
  }
  const stripped = raw
    // strip path separators outright
    .replace(/[\\/]/g, '')
    // strip control / NUL
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .normalize('NFC')
  // Leading dots (`..`, `.foo`) — strip just the leading dot run to neutralize
  // `..` while keeping `.gitignore`-style names intact only when they have a
  // following extension. Simpler: collapse leading dots fully.
  const trimmed = stripped.replace(/^\.+/, '')
  if (trimmed.length === 0) {
    return `upload-${fallbackIndex}.bin`
  }
  return trimmed
}

/**
 * Normalize a repo-relative upload directory for COMPARISON purposes:
 * backslashes → `/`, collapsed separators, no `.` / trailing slash. `'.'` and
 * `''` both mean "worktree root" and normalize to `''`.
 *
 * Deliberately NOT a path resolver — `..` never reaches here (UploadInputSchema
 * and the workflow validator both reject it at write time), so this stays a
 * pure string fold that behaves identically in node and the browser.
 */
export function normalizeUploadDir(dir: string): string {
  if (typeof dir !== 'string') return ''
  const parts = dir
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
  return parts.join('/')
}

/**
 * The key two uploads collide on: same landing directory + same filename.
 *
 * Case-folded (RFC-262 D6 / capability-impact C2, decided by the user): macOS
 * and Windows filesystems are case-insensitive, so `Report.pdf` and
 * `report.pdf` are the SAME file there — in overwrite mode the second write
 * would silently destroy the first. Folding makes the verdict identical on
 * every platform instead of "Linux keeps both, macOS keeps one".
 *
 * The DIRECTORY segment folds for the same reason, not for symmetry: two
 * upload inputs declaring `Docs/` and `docs/` land in one directory on those
 * filesystems, which is the identical silent-loss path one level up.
 */
export function uploadLandingKey(targetDir: string, filename: string, fallbackIndex = 0): string {
  const dir = normalizeUploadDir(targetDir).toLowerCase()
  const name = sanitizeUploadFilename(filename, fallbackIndex).toLowerCase()
  return dir === '' ? name : `${dir}/${name}`
}

export interface UploadLandingEntry {
  inputKey: string
  filename: string
  targetDir: string
  /**
   * Index used for the `upload-<n>.bin` fallback when `filename` is empty —
   * must mirror the write side (`applyUploadsToWorktree` counts from 1 over the
   * flat file list) so two nameless files never look like a collision.
   */
  fallbackIndex: number
}

export interface UploadDuplicate {
  key: string
  first: { inputKey: string; filename: string }
  second: { inputKey: string; filename: string }
}

/**
 * First pair of entries that would land on the same path, or null.
 *
 * Detection is GLOBAL, not per-input (RFC-262 D4, user's call): two different
 * upload inputs pointed at the same `targetDir` lose a file exactly the same
 * way one input with two same-named files does.
 */
export function findDuplicateUploadTarget(
  entries: readonly UploadLandingEntry[],
): UploadDuplicate | null {
  const seen = new Map<string, { inputKey: string; filename: string }>()
  for (const e of entries) {
    const key = uploadLandingKey(e.targetDir, e.filename, e.fallbackIndex)
    const prev = seen.get(key)
    if (prev !== undefined) {
      return {
        key,
        first: prev,
        second: { inputKey: e.inputKey, filename: e.filename },
      }
    }
    seen.set(key, { inputKey: e.inputKey, filename: e.filename })
  }
  return null
}
