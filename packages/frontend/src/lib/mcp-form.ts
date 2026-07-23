// RFC-028 T9 — pure helpers for the /mcps form. Keeping the
// parse/serialize logic out of the React tree lets us unit-test the
// nasty bits (KEY=VALUE list editor, type-discriminated payload assembly,
// validation messages) without rendering the page.

import type { CreateMcp, Mcp, McpOAuthConfig } from '@agent-workflow/shared'
import { CreateMcpSchema } from '@agent-workflow/shared'

/**
 * Form-state shape mirrors the UI widgets, not the wire payload. Bridges:
 *   command          — single string, space-separated; we tokenize on submit.
 *   envText/headers  — `KEY=VALUE\n…` textareas; parsed line-by-line.
 *   timeoutMs        — string for empty support; parsed to number on submit.
 *
 * The discriminator `type` lives at the top level so the renderer can switch
 * the body region.
 */
export interface McpFormState {
  name: string
  description: string
  type: 'local' | 'remote'
  enabled: boolean
  // local-only
  command: string
  envText: string
  // remote-only
  url: string
  headersText: string
  oauthMode: 'auto' | 'disabled'
  /**
   * Carry-through for the saved oauth config object (clientId/secret/scope/
   * redirectUri). The current UI only toggles `auto` vs `disabled`, so without
   * preserving this on the form state we'd silently overwrite the stored
   * object with `undefined` on every PUT — re-running `opencode mcp auth`
   * would be the only recovery. Round-tripped on the edit page; for
   * `oauthMode === 'disabled'` (or when the user truly wants to clear it)
   * the value is ignored.
   */
  oauthConfig?: McpOAuthConfig
  // shared
  timeoutMsText: string
}

export const EMPTY_LOCAL_FORM: McpFormState = {
  name: '',
  description: '',
  type: 'local',
  enabled: true,
  command: '',
  envText: '',
  url: '',
  headersText: '',
  oauthMode: 'auto',
  timeoutMsText: '',
}

/** Tokenize a command-line string into argv (split on whitespace; collapses
 *  runs of spaces; trims surrounding whitespace). The opencode `McpLocalConfig`
 *  expects an array of strings (`command: string[]`); the form takes a single
 *  line for ergonomics, and this is where we bridge. */
export function tokenizeCommand(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
}

/** Parse a `KEY=VALUE` textarea into `Record<string,string>`. Empty lines
 *  and lines lacking `=` are silently dropped (the form shows a hint that the
 *  format is KEY=VALUE; we keep parse permissive to avoid red-marking the
 *  field on every keystroke). */
export function parseKvLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1)
    if (k.length === 0) continue
    out[k] = v
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** Serialise a `Record<string,string>` back to a `KEY=VALUE\n…` textarea
 *  for the edit-existing path. Stable key order keeps the textarea diff-able. */
export function kvToLines(rec: Record<string, string> | undefined): string {
  if (rec === undefined) return ''
  return Object.entries(rec)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/**
 * Build the API payload from form state. Returns `{ ok: true, payload }` on
 * success, `{ ok: false, errors }` with per-field error keys i18n can
 * translate. The caller passes the i18n `t()` function for the final
 * messages; here we emit raw keys so this stays test-friendly.
 */
export function buildCreatePayload(
  form: McpFormState,
): { ok: true; payload: CreateMcp } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (form.name.length === 0) errors.name = 'mcps.errors.nameRequired'
  if (form.type === 'local' && tokenizeCommand(form.command).length === 0) {
    errors.command = 'mcps.errors.commandRequired'
  }
  if (form.type === 'remote') {
    if (form.url.length === 0) errors.url = 'mcps.errors.urlRequired'
    else if (!form.url.startsWith('http://') && !form.url.startsWith('https://')) {
      errors.url = 'mcps.errors.urlScheme'
    }
  }
  const timeoutMs = parseTimeoutMs(form.timeoutMsText)
  if (timeoutMs === 'invalid') errors.timeoutMs = 'mcps.errors.timeoutInvalid'

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const baseCommon = {
    name: form.name,
    description: form.description,
    enabled: form.enabled,
  } as const

  const payload =
    form.type === 'local'
      ? ({
          ...baseCommon,
          type: 'local',
          config: {
            command: tokenizeCommand(form.command),
            ...(parseKvLines(form.envText) !== undefined
              ? { env: parseKvLines(form.envText)! }
              : {}),
            ...(timeoutMs !== undefined && timeoutMs !== 'invalid' ? { timeoutMs } : {}),
          },
        } as const)
      : ({
          ...baseCommon,
          type: 'remote',
          config: {
            url: form.url,
            ...(parseKvLines(form.headersText) !== undefined
              ? { headers: parseKvLines(form.headersText)! }
              : {}),
            ...(form.oauthMode === 'disabled'
              ? { oauth: false as const }
              : form.oauthConfig !== undefined
                ? { oauth: form.oauthConfig }
                : {}),
            ...(timeoutMs !== undefined && timeoutMs !== 'invalid' ? { timeoutMs } : {}),
          },
        } as const)

  // Final canonical validation via the shared schema — catches any wire-shape
  // drift between form-builder and schema (e.g. a future schema tightening
  // that the form forgot to mirror). This is the same schema the server uses.
  const parsed = CreateMcpSchema.safeParse(payload)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      fieldErrors[path || '_'] = issue.message
    }
    return { ok: false, errors: fieldErrors }
  }
  return { ok: true, payload: parsed.data }
}

function parseTimeoutMs(text: string): number | undefined | 'invalid' {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 'invalid'
  return n
}

/**
 * Inverse of buildCreatePayload: turn an existing Mcp row into form state for
 * the /mcps/$id edit page. Stable; covered by mcp-form.test.ts so the edit
 * page never silently mis-renders a stored row.
 */
export function mcpToForm(m: Mcp): McpFormState {
  if (m.type === 'local') {
    return {
      name: m.name,
      description: m.description,
      type: 'local',
      enabled: m.enabled,
      command: m.config.command.join(' '),
      envText: kvToLines(m.config.env),
      url: '',
      headersText: '',
      oauthMode: 'auto',
      timeoutMsText: m.config.timeoutMs?.toString() ?? '',
    }
  }
  return {
    name: m.name,
    description: m.description,
    type: 'remote',
    enabled: m.enabled,
    command: '',
    envText: '',
    url: m.config.url,
    headersText: kvToLines(m.config.headers),
    oauthMode: m.config.oauth === false ? 'disabled' : 'auto',
    // Preserve the saved oauth config object so a no-op edit + Save doesn't
    // wipe it. The current UI has no widget for the inner fields; this is
    // a pure passthrough.
    ...(m.config.oauth !== undefined && m.config.oauth !== false
      ? { oauthConfig: m.config.oauth }
      : {}),
    timeoutMsText: m.config.timeoutMs?.toString() ?? '',
  }
}
