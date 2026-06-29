// RFC-024 — pure helpers for the launcher's two-mode Repo source picker.
//
// Keeping these out of the route component so the body / formdata shape is
// trivially unit-testable without spinning up the route harness.

import { canonicalRepoKey, parseGitUrl, type CachedRepo } from '@agent-workflow/shared'

export type RepoSource =
  | {
      kind: 'path'
      repoPath: string
      baseBranch: string
      /**
       * RFC-068 — opt-in `git fetch --all --prune --tags` against the user's
       * local repo before the worktree is materialized. Never `pull` /
       * `merge` — only refreshes remote-tracking refs so the user can pick
       * `origin/<branch>` as a base ref. Default false to preserve legacy
       * (no-fetch) behavior. UI persists last value to localStorage.
       */
      fetchBeforeLaunch?: boolean
    }
  | { kind: 'url'; repoUrl: string; ref: string }

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
  deferredQuestionDispatch?: boolean
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
  if (source.kind === 'path') {
    const out: Record<string, unknown> = {
      workflowId: common.workflowId,
      name: common.name,
      repoPath: source.repoPath,
      baseBranch: source.baseBranch,
      inputs: common.inputs,
    }
    // RFC-068: only set when explicitly true so legacy bodies stay byte-
    // identical (`undefined` field would survive JSON serialization
    // anyway, but explicit gate keeps the wire format clean).
    if (source.fetchBeforeLaunch === true) out.fetchBeforeLaunch = true
    if (hasGitIdentity) {
      out.gitUserName = common.gitUserName
      out.gitUserEmail = common.gitUserEmail
    }
    // RFC-125: carry the deferred flag onto the wire (whitelist would drop it).
    if (common.deferredQuestionDispatch === true) out.deferredQuestionDispatch = true
    return out
  }
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
  // RFC-125: carry the deferred flag onto the wire (whitelist would drop it).
  if (common.deferredQuestionDispatch === true) out.deferredQuestionDispatch = true
  return out
}

/**
 * Same shape as `buildLaunchBody`, but stamps it into the existing multipart
 * envelope used by RFC-020 uploads. Wrapping in this helper keeps the
 * launcher's "uploads + url" combo encoded consistently. RFC-107: the backend
 * now accepts the url + uploads combo (the multipart route resolves the URL
 * into the repo cache before materializing the worktree), so this is a fully
 * supported launch path. The url body carries `repoUrl` + optional `ref`.
 */
export function buildLaunchFormDataV2(
  source: RepoSource,
  common: LaunchCommonPayload,
  uploads: Record<string, File[]>,
): FormData {
  const inputsOut: Record<string, string> = { ...common.inputs }
  for (const key of Object.keys(uploads)) {
    if (!(key in inputsOut)) inputsOut[key] = ''
  }
  const body = buildLaunchBody(source, { ...common, inputs: inputsOut })
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(body)], { type: 'application/json' }))
  for (const [key, list] of Object.entries(uploads)) {
    for (const f of list) {
      fd.append(`files[${key}][]`, f, f.name)
    }
  }
  return fd
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
 * GitPicker) should enumerate against:
 *   - path mode → `source.repoPath` verbatim (may be '' — path mode handles that).
 *   - url  mode → canonicalize `source.repoUrl` and find the cached repo with the
 *                 SAME canonical key; return its `localPath`. No match / unparseable
 *                 URL → '' (the picker falls back to a text input in url mode).
 *
 * Pure: no hooks, no side effects. Matching reuses the backend cache-key
 * canonicalization (`canonicalRepoKey`), so a hit here means the backend would
 * reuse the same cache dir at launch (modulo the pre-existing 8-char sha1
 * collision caveat). Folds within a protocol only — HTTPS and SSH URLs for the
 * same repo are different keys and will NOT cross-match (mirrors the backend's
 * separate cache dirs).
 */
export function resolveUrlRepoPath(source: RepoSource, cached: CachedRepo[]): string {
  if (source.kind === 'path') return source.repoPath
  const key = canonicalRepoKey(source.repoUrl)
  if (key === null) return ''
  const hit = cached.find((c) => canonicalRepoKey(c.url) === key)
  return hit?.localPath ?? ''
}

/**
 * RFC-066 PR-C — default `RepoSource` for a newly-added row. Defaults to
 * path mode with empty values so the user gets the same blank form they
 * already know from the single-repo launcher.
 */
export function defaultRepoSource(): RepoSource {
  return { kind: 'path', repoPath: '', baseBranch: '' }
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
 * multi-repo worktree. Mirrors `path.basename` for path mode; for URL mode,
 * pulls the trailing path segment of the repo URL (strips `.git` suffix
 * the way `git clone` does).
 */
function basenameForRepoSource(src: RepoSource): string {
  if (src.kind === 'path') {
    if (src.repoPath === '') return ''
    const parts = src.repoPath.split('/').filter((p) => p.length > 0)
    return parts.length === 0 ? '' : parts[parts.length - 1]!
  }
  // url
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
 * pre-RFC-066 fixtures. RFC-067 git identity + RFC-068 fetchBeforeLaunch
 * are handled the same way as the single-repo helper.
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
  // RFC-068: same top-level flag covers every path-mode entry. The body
  // includes it whenever ANY path-mode row opted in — the backend ignores
  // it for URL-mode entries automatically.
  const anyFetchBeforeLaunch = repos.some((r) => r.kind === 'path' && r.fetchBeforeLaunch === true)
  const out: Record<string, unknown> = {
    workflowId: common.workflowId,
    name: common.name,
    inputs: common.inputs,
    repos: repos.map((r) => {
      if (r.kind === 'path') {
        return { repoPath: r.repoPath, baseBranch: r.baseBranch }
      }
      const entry: Record<string, unknown> = { repoUrl: r.repoUrl }
      if (r.ref.trim().length > 0) entry.ref = r.ref.trim()
      return entry
    }),
  }
  if (anyFetchBeforeLaunch) out.fetchBeforeLaunch = true
  if (hasGitIdentity) {
    out.gitUserName = common.gitUserName
    out.gitUserEmail = common.gitUserEmail
  }
  // RFC-125: carry the deferred flag onto the wire (whitelist would drop it).
  if (common.deferredQuestionDispatch === true) out.deferredQuestionDispatch = true
  return out
}
