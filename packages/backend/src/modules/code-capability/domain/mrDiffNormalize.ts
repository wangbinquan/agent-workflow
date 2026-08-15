// RFC-304 §6 — `fetch-diff`: the round's anchoring baseline.
//
// The diff comes from the code host (`mr.diff`), not from a local `git diff`.
// That is deliberate: the host's own position API validates a comment against
// the diff the host computed, so a locally recomputed diff — different rename
// detection, different context width, different whitespace settings — can
// disagree about hunk boundaries and produce positions the host rejects. Taking
// the host's diff makes the anchoring baseline and the acceptance criterion the
// same artifact.
//
// The two providers answer in different shapes and, more importantly, in
// different ways of saying "there is no patch here":
//
//   GitLab   /diffs  → { old_path, new_path, diff, new_file, deleted_file, ... }
//   GitHub   /files  → { filename, previous_filename, status, patch?, ... }
//
// A file with no patch is the case that matters. It is not an error and must
// not fail the stage — an MR can legitimately contain an image, or a generated
// bundle too large for the host to diff. But it must not be treated as "no
// changes" either, because then a finding on that file would silently look like
// a finding on an unchanged file. It is recorded as an omission with a reason,
// so `resolve-positions` degrades it deliberately and the overview comment can
// say which files were not read.

/** Why a changed file carries no patch body. */
export type DiffOmission = 'none' | 'binary' | 'too-large'

export interface FileDiff {
  /** null when the file was added — it has no old side. */
  oldPath: string | null
  /** null when the file was deleted — it has no new side. */
  newPath: string | null
  /** The per-file unified-diff body (hunk headers + lines); '' when omitted. */
  patch: string
  omission: DiffOmission
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Sort key: the new side is what a reviewer sees, so it leads. */
function pathKey(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? ''
}

/**
 * GitLab `/merge_requests/{iid}/diffs` (and the `/changes` fallback's `changes[]`).
 *
 * GitLab sets BOTH `old_path` and `new_path` on added and deleted files — they
 * are equal, not null — so the `new_file` / `deleted_file` booleans are the only
 * way to tell which side genuinely exists. Reading the paths alone would give an
 * added file a phantom old side, and an old-side finding on it would anchor onto
 * a file that never existed.
 */
function normalizeGitlabEntry(raw: unknown): FileDiff | null {
  const entry = asRecord(raw)
  if (entry === null) return null

  const oldPath = asString(entry.old_path)
  const newPath = asString(entry.new_path)
  if (oldPath === '' && newPath === '') return null

  const isNew = entry.new_file === true
  const isDeleted = entry.deleted_file === true
  const patch = asString(entry.diff)

  return {
    oldPath: isNew ? null : oldPath === '' ? null : oldPath,
    newPath: isDeleted ? null : newPath === '' ? null : newPath,
    patch,
    // GitLab reports a binary file as a changed file with an empty `diff` and
    // no flag distinguishing binary from omitted, so both land on 'binary'.
    omission: patch === '' ? 'binary' : 'none',
  }
}

/**
 * GitHub `/pulls/{number}/files`.
 *
 * `patch` is absent for binary files AND for files whose diff exceeds the API's
 * size limit, with nothing in the payload naming which. The counts separate
 * them in practice: GitHub reports `additions`/`deletions` as 0 for a binary
 * file, and as real numbers for a text file it declined to render. Guessing
 * wrong only changes the wording shown to a human — both are omissions, and
 * both degrade the same way — so the heuristic is safe where it is used.
 */
function normalizeGithubEntry(raw: unknown): FileDiff | null {
  const entry = asRecord(raw)
  if (entry === null) return null

  const filename = asString(entry.filename)
  if (filename === '') return null

  const status = asString(entry.status)
  const previous = asString(entry.previous_filename)
  const patch = asString(entry.patch)

  const oldPath = status === 'added' ? null : previous !== '' ? previous : filename
  const newPath = status === 'removed' ? null : filename

  let omission: DiffOmission = 'none'
  if (patch === '') {
    const touched = asCount(entry.additions) + asCount(entry.deletions)
    omission = touched === 0 ? 'binary' : 'too-large'
  }

  return { oldPath, newPath, patch, omission }
}

/**
 * Normalize a `mr.diff` response into the canonical per-file shape.
 *
 * Returns files sorted by path rather than in the host's own order. Both hosts
 * are free to reorder between calls, and `split-diff` must produce identical
 * shards for identical input (constitution R5) — sorting here is what makes a
 * re-run reproduce the previous run's sharding instead of quietly reshuffling
 * which reviewer saw which file.
 *
 * A response that is not an array yields no files: the stage then reports an
 * empty diff, which is a legitimate state, rather than throwing on a shape the
 * host changed.
 */
export function normalizeMrDiff(provider: 'gitlab' | 'github', body: unknown): FileDiff[] {
  // GitLab's deprecated `/changes` fallback nests the array under `changes`.
  const entries = Array.isArray(body)
    ? body
    : Array.isArray(asRecord(body)?.changes)
      ? (asRecord(body)?.changes as unknown[])
      : []

  const normalize = provider === 'gitlab' ? normalizeGitlabEntry : normalizeGithubEntry
  const files: FileDiff[] = []
  for (const entry of entries) {
    const file = normalize(entry)
    if (file !== null) files.push(file)
  }
  files.sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : pathKey(a) > pathKey(b) ? 1 : 0))
  return files
}

/**
 * Reassemble the per-file patches into one unified diff.
 *
 * Both hosts return a patch BODY (hunk headers and lines) with no `---`/`+++`
 * header, so the file it belongs to lives outside the text. `parseDiffHunks`
 * reads paths from the header, so the header is synthesized here rather than
 * teaching the parser a second input shape — one parser, one set of conventions,
 * one place where an off-by-one would shift every line number.
 *
 * Files with no patch contribute nothing: they have no hunks, so anything a
 * reviewer says about them degrades, which is the intended outcome.
 */
export function toUnifiedDiff(files: readonly FileDiff[]): string {
  const parts: string[] = []
  for (const file of files) {
    if (file.patch === '') continue
    // `a/` and `b/` are the prefixes `parseDiffHunks` strips back off; a path
    // that itself starts with `a/` round-trips because only the first segment
    // is removed.
    const oldSide = file.oldPath === null ? '/dev/null' : `a/${file.oldPath}`
    const newSide = file.newPath === null ? '/dev/null' : `b/${file.newPath}`
    const body = file.patch.endsWith('\n') ? file.patch : `${file.patch}\n`
    parts.push(`--- ${oldSide}\n+++ ${newSide}\n${body}`)
  }
  return parts.join('')
}

/**
 * What a `mr.diff` call produced, before it is trusted.
 *
 * Structural on purpose: the domain must not import the code-host call types,
 * so the application layer adapts `CodeHostCallOutcome` into this shape.
 */
export type DiffResponse =
  | { readonly ok: true; readonly body: string; readonly truncated: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string }

export type DiffReadResult =
  | { readonly ok: true; readonly files: FileDiff[] }
  | { readonly ok: false; readonly reason: DiffReadFailure; readonly message: string }

export type DiffReadFailure = 'call-failed' | 'truncated' | 'unparsable'

/**
 * Turn a `mr.diff` response into files, or refuse.
 *
 * The truncation branch is the one worth spelling out. The code-host client
 * bounds every response (256 KiB by default) and appends a truncation notice to
 * a body it cut MID-BYTE-STREAM — so a large MR yields JSON that is not JSON.
 * Two wrong ways to handle that: parse and throw (the round dies on an error
 * that names a syntax position, not a cause), or parse-and-fall-back-to-empty
 * (the round succeeds, reviews nothing, and posts an overview saying so in the
 * voice of a completed review).
 *
 * Both are refused here by name, so the caller can raise the cap for this call
 * — the client takes `maxResponseBytes` per invocation — and, when even that is
 * not enough, say plainly that the MR is too large to review rather than
 * pretending it was reviewed.
 */
export function readMrDiffResponse(
  provider: 'gitlab' | 'github',
  response: DiffResponse,
): DiffReadResult {
  if (!response.ok) {
    return {
      ok: false,
      reason: 'call-failed',
      message: `the code host refused the diff request (${response.code}): ${response.message}`,
    }
  }

  if (response.truncated) {
    return {
      ok: false,
      reason: 'truncated',
      message:
        'the diff response exceeded the response cap and was cut mid-body — this MR is too large to review at the current limit',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return {
      ok: false,
      reason: 'unparsable',
      message: 'the code host returned a diff body that is not JSON',
    }
  }

  return { ok: true, files: normalizeMrDiff(provider, parsed) }
}

/** The files this round could not read, for the overview comment. */
export function omittedFiles(files: readonly FileDiff[]): Array<{
  path: string
  omission: Exclude<DiffOmission, 'none'>
}> {
  const out: Array<{ path: string; omission: Exclude<DiffOmission, 'none'> }> = []
  for (const file of files) {
    if (file.omission === 'none') continue
    out.push({ path: pathKey(file), omission: file.omission })
  }
  return out
}
