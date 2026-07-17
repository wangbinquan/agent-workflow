// RFC-203 T1 — the ONE error resolver for every user-facing error surface.
//
// Why (2026-07-16 audit R1/R3/R6 + 2026-07-17 inventory): 399 backend error
// codes with 21 mapped (5.3%), six byte-identical private `describeError`
// forks, `details` payloads dropped everywhere, fetch TypeErrors leaking
// "Failed to fetch" verbatim. This module gives every surface the same
// three-tier resolution:
//
//   overrides (caller-local)  →  exact `errors.<code>`  →  domain template
//   `errorDomains.<domain>`   →  global `errors.fallback`
//
// plus normalization (network TypeError → 'network-unreachable') and a
// whitelisted interpolation context taken from `ApiError.details`.
//
// `describeApiError` (i18n/index.ts) stays the string-only shell on top of
// this: exact/override matches return the localized title alone; domain /
// fallback matches keep `: <raw backend message>` appended so string-only
// surfaces (form rows, dialogs not yet on ErrorBanner) never lose the only
// diagnostic (Codex design-gate P1 — the rich path instead folds `raw` into
// a collapsible detail block, see <ErrorDetails>).

// The i18next singleton — imported from the library directly (index.ts
// configures this same default instance), so this module never imports
// './index' and no i18n↔errors cycle can form.
import i18n from 'i18next'
import { ApiError } from '@/api/client'

export type ErrorDomain =
  | 'taskQuestion'
  | 'task'
  | 'clarify'
  | 'review'
  | 'workflow'
  | 'workgroup'
  | 'skill'
  | 'agent'
  | 'mcp'
  | 'plugin'
  | 'memory'
  | 'schedule'
  | 'fusion'
  | 'runtime'
  | 'upload'
  | 'repo'
  | 'lifecycle'
  | 'auth'
  | 'misc'

/**
 * Ordered prefix → domain table (first match wins; longer/more-specific
 * prefixes MUST precede their shorter cousins, e.g. task-question before
 * task, cross-clarify before clarify). Kept as data so the unit test can
 * assert every inventoried code family lands in a domain.
 */
const DOMAIN_PREFIXES: ReadonlyArray<readonly [readonly string[], ErrorDomain]> = [
  [['task-question-', 'manual-question-'], 'taskQuestion'],
  [['cross-clarify-', 'clarify-'], 'clarify'],
  [['review-', 'doc-version-'], 'review'],
  [['workflow-', 'dw-'], 'workflow'],
  [['workgroup-'], 'workgroup'],
  [['skill-', 'zip-'], 'skill'],
  [['agent-'], 'agent'],
  [['mcp-'], 'mcp'],
  [['plugin-', 'npm-'], 'plugin'],
  [['memory-', 'distill-', 'supersede-'], 'memory'],
  [['scheduled-', 'schedule-'], 'schedule'],
  [['fusion-'], 'fusion'],
  [['runtime-', 'opencode-'], 'runtime'],
  [['upload-'], 'upload'],
  [
    [
      'repo-',
      'git-',
      'worktree-',
      'iso-',
      'path-',
      'snapshot-',
      'working-branch-',
      'batch-',
      'cached-repo-',
      'commit-tree-',
      'hash-object-',
      'merge-tree-',
      'materialize-',
      'salvage-tree-',
      'structural-',
      'row-',
    ],
    'repo',
  ],
  [
    [
      'alert-',
      'illegal-',
      'node-run-',
      'node-kind-',
      'repair-',
      'unknown-repair-',
      'workspace-',
      'live-child-',
      'wrapper-structure-',
      'scratch-',
      'call-target-',
      'multi-repo-',
      'internal-source-',
    ],
    'lifecycle',
  ],
  [
    [
      'acl-',
      'oidc-',
      'user-',
      'username-',
      'login-',
      'pat-',
      'session-',
      'identity-',
      'password-',
      'old-password-',
      'reset-',
      'members-',
      'provider-',
      'change-password-',
      'system-user-',
      'self-',
      'last-admin-',
      'owner-',
      'not-task-member',
      'invalid-collaborator',
      'forbidden',
      'unauthorized',
      'token-exchange-',
      'id-token-',
      'auth-',
    ],
    'auth',
  ],
  // `task-` LAST among t-prefixes so task-question wins above.
  [['task-'], 'task'],
]

export function domainOf(code: string): ErrorDomain {
  for (const [prefixes, domain] of DOMAIN_PREFIXES) {
    for (const p of prefixes) {
      if (p.endsWith('-') ? code.startsWith(p) : code === p || code.startsWith(p)) return domain
    }
  }
  return 'misc'
}

export interface ResolvedApiError {
  /** Localized human title — always present, never a raw backend string
   *  unless nothing better exists for a non-ApiError. */
  title: string
  /** Localized next-step hint (`errors.<code>__hint`), when authored. */
  hint?: string
  /** The raw backend/exception message for collapsible detail rendering. */
  raw?: string
  /** Normalized error code ('' when the input carried none). */
  code: string
  /** Original structured payload for <ErrorDetails>. */
  details?: unknown
  /** Which tier produced `title` — string-only shells append `raw` for the
   *  domain/fallback tiers so diagnostics survive outside ErrorBanner. */
  matched: 'override' | 'exact' | 'domain' | 'fallback'
}

export interface ResolveApiErrorOptions {
  /** Caller-local code→i18n-key map (absorbs the DISPATCH_ERROR_KEYS
   *  pattern); keys are full i18n paths, interpolated like exact matches. */
  overrides?: Record<string, string>
}

const INTERP_VALUE_MAX = 120

/** Whitelisted scalar interpolation context from `details` — strings and
 *  finite numbers only, truncated, so user-controlled long text or nested
 *  structures can never be injected into a title line. */
function interpolationContext(details: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return out
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v.length > INTERP_VALUE_MAX ? `${v.slice(0, INTERP_VALUE_MAX)}…` : v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v
    }
  }
  return out
}

export function resolveApiError(err: unknown, opts?: ResolveApiErrorOptions): ResolvedApiError {
  const t = i18n.t.bind(i18n)

  // ---- normalization -------------------------------------------------
  let code = ''
  let raw: string | undefined
  let details: unknown
  if (err instanceof ApiError) {
    code = err.code
    raw = err.message
    details = err.details
  } else if (err instanceof TypeError) {
    // fetch() network failures ("Failed to fetch" / "Load failed") — the
    // one non-ApiError shape every page can hit when the daemon is down.
    code = 'network-unreachable'
    raw = err.message
  } else if (err instanceof Error) {
    // A plain Error with no code is display-ready text by convention (the
    // widespread `new Error(t('...'))` caller-local pattern) — keep the
    // message AS the title instead of demoting it under a generic banner.
    return { title: err.message, code: '', matched: 'fallback' }
  } else if (err !== null && err !== undefined) {
    return { title: String(err), code: '', matched: 'fallback' }
  }

  const interp = { ...interpolationContext(details), code }

  // ---- three-tier lookup ---------------------------------------------
  if (code !== '') {
    const overrideKey = opts?.overrides?.[code]
    if (overrideKey !== undefined && i18n.exists(overrideKey)) {
      return {
        title: t(overrideKey, interp),
        code,
        details,
        matched: 'override',
        ...(raw !== undefined ? { raw } : {}),
      }
    }
    if (i18n.exists(`errors.${code}`)) {
      const hintKey = `errors.${code}__hint`
      return {
        title: t(`errors.${code}`, interp),
        ...(i18n.exists(hintKey) ? { hint: t(hintKey, interp) } : {}),
        code,
        details,
        matched: 'exact',
        ...(raw !== undefined ? { raw } : {}),
      }
    }
    const domainKey = `errorDomains.${domainOf(code)}`
    if (i18n.exists(domainKey)) {
      return {
        title: t(domainKey, interp),
        code,
        details,
        matched: 'domain',
        ...(raw !== undefined ? { raw } : {}),
      }
    }
  }
  return {
    title: t('errors.fallback'),
    code,
    details,
    matched: 'fallback',
    ...(raw !== undefined ? { raw } : {}),
  }
}

/**
 * Key-shadows-code label helper (the describeRecoveryKind pattern, RFC-108,
 * promoted to a shared primitive): translate `keyPrefix.code`; when the
 * bundle has no entry (backend ahead of the bundles), fall back to the raw
 * code instead of leaking the untranslated i18n key path.
 */
export function labelForCode(keyPrefix: string, code: string): string {
  const key = `${keyPrefix}.${code}`
  if (!i18n.exists(key)) return code
  return i18n.t(key)
}
