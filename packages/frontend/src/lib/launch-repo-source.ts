// RFC-024 — pure helpers for the launcher's Repo source picker (RFC-165:
// URL-only; the local-path mode is retired).
//
// Keeping these out of the route component so the body / formdata shape is
// trivially unit-testable without spinning up the route harness.

import { canonicalRepoKey, parseGitUrl, type CachedRepo } from '@agent-workflow/shared'

/**
 * RFC-165: URL-only — path mode retired from the wire. The `kind`
 * discriminant survives (a one-armed union) so downstream `kind === 'url'`
 * checks keep compiling; local repos ride `file:///abs/path` URLs through the
 * same cached-mirror pipeline.
 */
export type RepoSource = { kind: 'url'; repoUrl: string; ref: string }

export interface LaunchCommonPayload {
  workflowId: string
  /**
   * RFC-037: user-supplied display name. Required by the backend's
   * `StartTaskSchema`; both helpers stamp it into the outgoing body verbatim
   * (after the caller has trimmed). The schema rejects empty / overlong
   * names server-side, so the helper does not need to re-validate.
   */
  name: string
  inputs: Record<string, string>
  /**
   * RFC-067: optional per-task Git commit identity. Caller has already
   * trimmed; both must be non-empty together or both omitted (XOR enforced
   * client-side via the launcher's `gitIdentityOk` gate + server-side via
   * StartTaskSchema's superRefine). When present, the helper writes both
   * keys into the body; when undefined or blank, the helper omits both keys
   * so the wire is byte-identical to pre-RFC-067 launches.
   */
  gitUserName?: string
  gitUserEmail?: string
  /**
   * RFC-125: when true, the created task defers designer-scoped clarify answers
   * to the task-center board for manual batch-dispatch (the launch UI now always
   * sends true; the on/off toggle was removed). Both body helpers emit it onto
   * the wire when true — without this the whitelist drops it and the backend
   * falls back to `?? false`, silently making UI launches non-deferred.
   */
  /**
   * RFC-075 (workingBranch / autoCommitPush) + RFC-036 (collaboratorUserIds):
   * optional launch settings the launcher spreads onto `launchCommon`. Both body
   * helpers MUST stamp them onto the wire — the whitelist would otherwise DROP
   * them on the no-upload single-repo + multi-repo + url+upload paths (only the
   * path+uploads path's verbatim spread carried them), silently disabling these
   * features. (Confirmed dropped + fixed as an RFC-125 follow-up bug.)
   */
  workingBranch?: string
  autoCommitPush?: boolean
  collaboratorUserIds?: string[]
}

/**
 * Stamp the optional `launchCommon` "extras" that the whitelist body helpers
 * would otherwise drop. Conditional inclusion mirrors how the launcher spreads
 * them, so blank / false / empty values keep the wire byte-identical.
 */
function stampLaunchExtras(out: Record<string, unknown>, common: LaunchCommonPayload): void {
  if (typeof common.workingBranch === 'string' && common.workingBranch.length > 0)
    out.workingBranch = common.workingBranch
  if (common.autoCommitPush === true) out.autoCommitPush = true
  if (common.collaboratorUserIds !== undefined && common.collaboratorUserIds.length > 0)
    out.collaboratorUserIds = common.collaboratorUserIds
}

/**
 * Compose the JSON body for `POST /api/tasks` based on the active source
 * mode. URL mode omits `baseBranch` (the backend falls back to the cached
 * repo's default branch). Empty `ref` is dropped so the schema's
 * `min(1).optional()` doesn't reject `""`.
 */
export function buildLaunchBody(
  source: RepoSource,
  common: LaunchCommonPayload,
): Record<string, unknown> {
  // RFC-067: identity pair-check echoes superRefine. Drop both keys if
  // either side is blank — the helper never emits a half-identity wire.
  const hasGitIdentity =
    typeof common.gitUserName === 'string' &&
    common.gitUserName.length > 0 &&
    typeof common.gitUserEmail === 'string' &&
    common.gitUserEmail.length > 0
  const out: Record<string, unknown> = {
    workflowId: common.workflowId,
    name: common.name,
    repoUrl: source.repoUrl,
    inputs: common.inputs,
  }
  if (source.ref.trim().length > 0) out.ref = source.ref.trim()
  if (hasGitIdentity) {
    out.gitUserName = common.gitUserName
    out.gitUserEmail = common.gitUserEmail
  }
  stampLaunchExtras(out, common)
  return out
}

/**
 * Inline validation for the URL field. Returns:
 *   - 'empty'    — URL hasn't been typed yet (Start stays disabled).
 *   - 'invalid'  — URL doesn't parse via `parseGitUrl`. UI renders red copy.
 *   - null       — looks plausible; submission can proceed.
 */
export function validateRepoUrl(input: string): 'empty' | 'invalid' | null {
  const v = input.trim()
  if (v.length === 0) return 'empty'
  if (parseGitUrl(v) === null) return 'invalid'
  return null
}

/**
 * RFC-110 — resolve the local `repoPath` the launch-form pickers (FilesPicker /
 * GitPicker) should enumerate against: canonicalize `source.repoUrl` and find
 * the cached repo with the SAME canonical key; return its `localPath`. No
 * match / unparseable URL → '' (the picker falls back to a text input).
 *
 * Pure: no hooks, no side effects. Matching reuses the backend cache-key
 * canonicalization (`canonicalRepoKey`), so a hit here means the backend would
 * reuse the same cache dir at launch (modulo the pre-existing 8-char sha1
 * collision caveat). Folds within a protocol only — HTTPS and SSH URLs for the
 * same repo are different keys and will NOT cross-match (mirrors the backend's
 * separate cache dirs).
 */
export function resolveUrlRepoPath(source: RepoSource, cached: CachedRepo[]): string {
  const key = canonicalRepoKey(source.repoUrl)
  if (key === null) return ''
  const hit = cached.find((c) => canonicalRepoKey(c.url) === key)
  return hit?.localPath ?? ''
}

/**
 * RFC-066 PR-C — default `RepoSource` for a newly-added row: an empty URL
 * row, the same blank form the single-repo launcher renders.
 */
export function defaultRepoSource(): RepoSource {
  return { kind: 'url', repoUrl: '', ref: '' }
}

/**
 * RFC-159 (edit-config) — inverse of `buildLaunchBody` / `buildLaunchBodyMultiRepo`:
 * reconstruct the launcher's `RepoSource[]` from an already-built (or persisted)
 * StartTask launch body so the schedule edit-config form can pre-fill the repo
 * picker.
 *
 * The body is read defensively (opaque `Record<string, unknown>`) because it may
 * arrive straight off the wire (a scheduled task's stored `launchPayload`). Rules,
 * mirroring the forward builders:
 *   - `repos: [...]` → one source per entry.
 *   - `repoUrl`      → single url source (`ref` defaults to '').
 *   - nothing usable → a single default empty URL row (same as a fresh form).
 */
export function bodyToRepoSources(body: Record<string, unknown>): RepoSource[] {
  const repos = body.repos
  if (Array.isArray(repos) && repos.length > 0) {
    return repos.map((r) =>
      repoEntryToSource((typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>),
    )
  }
  if (typeof body.repoUrl === 'string' && body.repoUrl.length > 0) {
    return [
      { kind: 'url', repoUrl: body.repoUrl, ref: typeof body.ref === 'string' ? body.ref : '' },
    ]
  }
  // RFC-165: a legacy path-mode payload (only reachable on a schedule the
  // boot healer disabled) has no wire representation anymore — hand back an
  // empty URL row so the edit form renders blank for repair.
  return [defaultRepoSource()]
}

/** Map one `StartTask.repos[i]` entry back to a `RepoSource` (url-only; a
 *  legacy path row degrades to an empty URL row for repair). */
function repoEntryToSource(r: Record<string, unknown>): RepoSource {
  if (typeof r.repoUrl === 'string' && r.repoUrl.length > 0) {
    return { kind: 'url', repoUrl: r.repoUrl, ref: typeof r.ref === 'string' ? r.ref : '' }
  }
  return defaultRepoSource()
}

/**
 * RFC-066 PR-C — derive the sub-worktree basename each row will land on,
 * applying `-2` / `-3` collision suffixes the same way the backend does
 * in `services/task.ts` `resolveMultiRepoDirName`. Lets the UI show a
 * "Will mount as utils-2/" preview chip per row.
 *
 * Pure function — no side effects, no hooks. Single-repo callers (length
 * 1) get a `['']` array so the row's `previewDirName` prop renders as
 * `null` upstream (sentinel for "no preview, single-repo mode").
 *
 * For URL-mode entries with `repoUrl: ''` (placeholder), basename is
 * derived from the URL host or empty string. UI suppresses preview chips
 * with empty / falsy values.
 */
export function computePreviewDirNames(repos: RepoSource[]): string[] {
  if (repos.length <= 1) return repos.map(() => '')
  const used = new Set<string>()
  const out: string[] = []
  for (const r of repos) {
    const raw = basenameForRepoSource(r)
    if (raw === '') {
      out.push('')
      continue
    }
    let name = raw
    let suffix = 2
    while (used.has(name)) {
      name = `${raw}-${suffix}`
      suffix += 1
    }
    used.add(name)
    out.push(name)
  }
  return out
}

/**
 * Compute the basename a `RepoSource` will land under inside the parent
 * multi-repo worktree: the trailing path segment of the repo URL (strips
 * `.git` suffix the way `git clone` does).
 */
function basenameForRepoSource(src: RepoSource): string {
  const u = src.repoUrl.trim()
  if (u === '') return ''
  // Strip query / fragment / trailing slashes.
  let stripped = u.replace(/[?#].*$/, '').replace(/\/+$/, '')
  // SSH form like `git@host:owner/repo.git` → take after the last `:` or `/`.
  const lastSep = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'))
  if (lastSep >= 0) stripped = stripped.slice(lastSep + 1)
  return stripped.replace(/\.git$/i, '')
}

/**
 * RFC-066 PR-C — compose the JSON body for a multi-repo POST /api/tasks.
 * Emits the v2 `repos: [...]` shape; legacy single-repo callers (length 1)
 * should keep using `buildLaunchBody` to stay byte-baseline against
 * pre-RFC-066 fixtures. RFC-067 git identity is handled the same way as the
 * single-repo helper.
 */
export function buildLaunchBodyMultiRepo(
  repos: RepoSource[],
  common: LaunchCommonPayload,
): Record<string, unknown> {
  const hasGitIdentity =
    typeof common.gitUserName === 'string' &&
    common.gitUserName.length > 0 &&
    typeof common.gitUserEmail === 'string' &&
    common.gitUserEmail.length > 0
  const out: Record<string, unknown> = {
    workflowId: common.workflowId,
    name: common.name,
    inputs: common.inputs,
    repos: repos.map((r) => {
      const entry: Record<string, unknown> = { repoUrl: r.repoUrl }
      if (r.ref.trim().length > 0) entry.ref = r.ref.trim()
      return entry
    }),
  }
  if (hasGitIdentity) {
    out.gitUserName = common.gitUserName
    out.gitUserEmail = common.gitUserEmail
  }
  stampLaunchExtras(out, common)
  return out
}
