// RFC-020: take user-uploaded files from a multipart POST /api/tasks and
// land them inside the task's freshly-created worktree at a per-input
// `targetDir`. Returns the repo-relative paths (one list per inputKey) so
// the route handler can build the packed (newline-joined) value that the
// scheduler injects via `{{port}}` like any other `kind: 'files'` input.
//
// Pure I/O with explicit limits; no DB / no scheduler / no Hono coupling
// so we can unit-test it directly.

import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, parse as parsePath, resolve, sep } from 'node:path'
import { ValidationError } from '@/util/errors'
import { realpathInside } from '@/util/safePath'

/**
 * RFC-107 security: `assertInsideWorktree` is a LEXICAL check, but `mkdirSync` /
 * `writeFileSync` FOLLOW symlink components that already exist on disk. An
 * untrusted (URL-cloned) repo can commit a task's `targetDir` — or any ancestor
 * of it — as a symlink pointing at a daemon-writable directory OUTSIDE the
 * worktree; the lexical check passes and the upload then lands outside the
 * worktree under daemon permissions. Walk to the deepest EXISTING ancestor of
 * `targetAbs` (the leaf usually doesn't exist yet — it's about to be mkdir'd)
 * and realpath-check it against the worktree root. Throws `path-traversal` on
 * escape. Before RFC-107 a remote repo's symlink was unreachable via
 * URL+multipart because the route rejected URL uploads outright.
 */
function assertTargetDirInsideWorktree(worktreeRoot: string, targetAbs: string): void {
  let probe = targetAbs
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  // realpathInside resolves symlinks on both `worktreeRoot` and `probe` and
  // throws ValidationError('path-traversal') when probe escapes the root.
  realpathInside(worktreeRoot, probe)
}

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
}

/** One incoming file after the route handler has read its bytes. */
export interface UploadFile {
  inputKey: string
  filename: string
  /** Client-declared mime; we never trust it for accept matching. */
  declaredMime: string
  bytes: Uint8Array
}

export interface UploadPlan {
  /**
   * RFC-248 D12: 上传物的额外根前缀（相对 `worktreePath`）。多仓任务传
   * `.agent-workflow-inputs`——上传物不属于任何成员仓，落进某个仓会变成它的
   * 未跟踪改动、进审计 diff 与自动提交。单仓任务不传，路径保持 baseline。
   */
  inputsSubdir?: string
  worktreePath: string
  defs: ReadonlyMap<string, UploadInputDef>
  files: readonly UploadFile[]
  limits: UploadLimits
}

export interface UploadResult {
  /** key → repo-relative paths in the same order the files were submitted. */
  packedByKey: Map<string, string[]>
}

/**
 * Drop characters that could break path resolution or shell-pipe filenames
 * downstream. Path separators / control chars / leading dots all become
 * empty; the result is then NFC-normalized so visually-equivalent filenames
 * collide as expected during dedup.
 */
export function sanitizeFilename(raw: string, fallbackIndex = 0): string {
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
    .replace(/[\x00-]/g, '')
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
 * Existence check that does NOT follow symlinks (`lstat`, not `stat`/`existsSync`):
 * a dangling symlink, a live symlink, a file, or a dir all count as "taken".
 * RFC-107 (Codex impl-gate): the upload writer must use this — `existsSync`
 * FOLLOWS links and reports a *dangling* symlink as absent, so a committed leaf
 * symlink (e.g. `inputs/refs/x.txt -> /outside`) in an untrusted URL-cloned repo
 * would be seen as "no collision" and then `writeFileSync` would follow it and
 * create/truncate the outside target. Treating any entry as a collision makes
 * `resolveUniqueName` rename around it so the write lands on a fresh real file.
 */
function entryExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** Pick a `<stem> (n).<ext>` that does not collide with anything in `dir`. */
export function resolveUniqueName(dir: string, filename: string): string {
  if (!entryExists(resolve(dir, filename))) return filename
  const { name, ext } = parsePath(filename)
  for (let i = 1; i < 1000; i++) {
    const candidate = `${name} (${i})${ext}`
    if (!entryExists(resolve(dir, candidate))) return candidate
  }
  throw new ValidationError(
    'upload-name-clash',
    `cannot pick a non-clashing name for '${filename}' after 999 attempts`,
  )
}

/** Confirm `child` resolves to a path under `root`. Throws ValidationError. */
export function assertInsideWorktree(root: string, child: string): string {
  if (isAbsolute(child)) {
    throw new ValidationError(
      'upload-target-absolute',
      `targetDir must be repo-relative, got: ${child}`,
    )
  }
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, normalize(child))
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (target !== rootResolved && !target.startsWith(rootPrefix)) {
    throw new ValidationError('upload-target-escape', `targetDir escapes the worktree: ${child}`)
  }
  return target
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

/**
 * Write every file in `plan.files` into the worktree under its input's
 * `targetDir`, enforcing per-file / per-request / per-count limits + the
 * `accept` whitelist (extension OR sniffed MIME).
 *
 * Failure semantics: any pre-flight reject (limits, accept, traversal) throws
 * BEFORE writing anything. Once writes begin, a mid-flight failure unlinks
 * everything this call has already written and re-throws.
 */
export async function applyUploadsToWorktree(plan: UploadPlan): Promise<UploadResult> {
  const { worktreePath, defs, files, limits } = plan

  // Pre-flight checks (RFC-107: the multipart route also runs these BEFORE it
  // resolves/clones the repo; re-run here so direct callers stay guarded).
  validateUploadPlan({ defs, files, limits })

  // Writes -----------------------------------------------------------------
  const written: string[] = []
  const packedByKey = new Map<string, string[]>()
  for (const def of defs.values()) packedByKey.set(def.key, [])

  let idx = 0
  try {
    for (const f of files) {
      idx++
      const def = defs.get(f.inputKey)!
      // RFC-248 D12: 多仓任务把上传物统一落到任务根下的固定目录，不属于任何仓。
      // 单仓时 `inputsSubdir` 为空 ⇒ 路径与今天字节级一致。
      const effectiveTarget =
        plan.inputsSubdir !== undefined && plan.inputsSubdir !== ''
          ? `${plan.inputsSubdir}/${def.targetDir}`
          : def.targetDir
      const targetAbs = assertInsideWorktree(worktreePath, effectiveTarget)
      // RFC-107 security: reject a symlinked targetDir / ancestor (from an
      // untrusted URL-cloned repo) that would escape the worktree once the fs
      // calls below follow it. Runs before mkdirSync so nothing is created
      // outside the worktree; a mid-loop throw unlinks prior writes via catch.
      assertTargetDirInsideWorktree(worktreePath, targetAbs)
      mkdirSync(targetAbs, { recursive: true })

      const safeName = sanitizeFilename(f.filename, idx)
      const finalName = resolveUniqueName(targetAbs, safeName)
      const absPath = resolve(targetAbs, finalName)
      // Second-layer guard against `resolveUniqueName` returning a separator-bearing name.
      if (dirname(absPath) !== targetAbs) {
        throw new ValidationError(
          'upload-path-escape',
          `resolved upload path escapes target directory: ${absPath}`,
        )
      }
      // RFC-107 security: `wx` = O_CREAT | O_EXCL — never write THROUGH an
      // existing path. `resolveUniqueName` already renamed around any existing
      // entry (incl. symlinks, via lstat), so this only fires on a TOCTOU race
      // where a symlink appears between the name pick and the write; O_EXCL then
      // fails (EEXIST) instead of following it outside the worktree.
      writeFileSync(absPath, f.bytes, { flag: 'wx' })
      written.push(absPath)

      // Repo-relative path for packed value.
      const rel = normalize(def.targetDir).replace(/\\/g, '/')
      const packed = rel === '.' || rel === '' ? finalName : `${rel}/${finalName}`
      packedByKey.get(def.key)!.push(packed)
    }
  } catch (err) {
    for (const p of written) {
      try {
        unlinkSync(p)
      } catch {
        // best-effort cleanup; the original failure is what matters
      }
    }
    throw err
  }

  return { packedByKey }
}
