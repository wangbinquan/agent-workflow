// RFC-247 D9 — the single place that decides what a TOKEN may see.
//
// "Reads are always on" (D3) is what makes a token usable: a client that can
// create a workflow but cannot list agents to reference is useless. The cost is
// that every read surface is reachable by every token, including one whose
// matrix is empty. So the read path has to be the thing that hides secrets,
// not the permission matrix.
//
// WHY THIS IS ONE MODULE AND NOT A FEW `if`s AT THE CALL SITES
//
// The redaction has to hold on every channel a token can reach. There are two —
// the REST response serialiser and the WebSocket frame path — and a rule that
// lives only in the first is not a rule, it is a coincidence. `/ws/*` is
// upgraded in `Bun.serve`'s fetch handler, entirely outside `multiAuth`
// (cli/start.ts), and accepts PATs; a token that cannot read a secret over REST
// could simply subscribe for it. Both outlets call this module.
//
// WHAT IS **NOT** REDACTED, ON PURPOSE
//
// Node stdout is passed through `redactSensitiveString` here, but worktree file
// contents are not touched at all — they are the repository working tree, and
// whatever an agent wrote into `.env` reads back verbatim. That is a deliberate
// limit, not an oversight: the platform cannot classify arbitrary file bytes.
// It is stated here so the account page and the generated docs never promise
// "read-only tokens can't leak secrets", which would be false.

import { maskWorkflowScriptEnv, redactGitUrl } from '@agent-workflow/shared'
import type { Task } from '@agent-workflow/shared'
import type { ActorSource } from '@/auth/actor'
import { redactSensitiveString } from '@/util/redact'

/** The placeholder a redacted value collapses to. Keys survive; values do not. */
export const REDACTED = '***'

/**
 * Redaction applies to the token channel only. Session and daemon actors keep
 * today's behaviour byte-for-byte — a human who can already open the MCP editor
 * in the browser gains nothing from having the same bytes hidden from them, and
 * changing that would be a UX regression dressed up as security.
 */
export function shouldRedactFor(source: ActorSource): boolean {
  return source === 'pat'
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Replace every value of a string map, keeping the keys. */
function maskValues(v: unknown): unknown {
  if (!isPlainObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) out[k] = REDACTED
  return out
}

/**
 * Mask the secret-bearing fields of one MCP server record, in place-free form.
 *
 * The three fields are the ones that actually hold credentials today:
 *   config.env     — the stdio child's environment; API keys live here
 *   config.headers — remote servers put `Authorization` here
 *   config.oauth.clientSecret
 *
 * `GET /api/mcps/:id` returns all three verbatim (services/mcp.ts performs no
 * redaction of any kind), so before RFC-247 any credential-bearing read was one
 * request away for anyone who could see the resource.
 */
export function redactMcpRecord<T>(record: T): T {
  if (!isPlainObject(record)) return record
  const config = record.config
  if (!isPlainObject(config)) return record
  const nextConfig: Record<string, unknown> = { ...config }
  if ('env' in nextConfig) nextConfig.env = maskValues(nextConfig.env)
  if ('headers' in nextConfig) nextConfig.headers = maskValues(nextConfig.headers)
  if (isPlainObject(nextConfig.oauth) && 'clientSecret' in nextConfig.oauth) {
    nextConfig.oauth = { ...nextConfig.oauth, clientSecret: REDACTED }
  }
  return { ...record, config: nextConfig } as T
}

/**
 * Serialize one MCP record for a specific caller.
 *
 * THE outlet. `redactMcpRecord` above is the rule; this is where it is applied,
 * and routes call it instead of choosing for themselves — a per-route decision
 * is how five of six call sites end up redacting and the sixth does not.
 */
export function serializeMcpFor<T>(record: T, source: ActorSource): T {
  return shouldRedactFor(source) ? redactMcpRecord(record) : record
}

/**
 * Serialize one workflow RECORD for a specific caller (RFC-253 T28).
 *
 * A workflow definition became a credential carrier the day script nodes
 * landed: their `env` map holds whatever the author typed, API keys included.
 * Same rule as MCP env — keys survive, values collapse to `***` on the token
 * channel — applied through the shared `maskWorkflowScriptEnv` walker so this
 * projection and the intent-dump projection can never disagree about which
 * nodes carry secrets. Records without script nodes come back as the SAME
 * reference.
 *
 * THE CONSTRAINT IS THE POINT. `definition` is REQUIRED on T, so passing a
 * save receipt here is a compile error rather than a silent no-op: a receipt
 * keeps its definition at `snapshot.definition`, so the original permissive
 * `<T>` signature read `record.definition === undefined`, hit the
 * same-reference short circuit, and returned the receipt untouched — a call
 * site that looked wired and did nothing. Receipts go through
 * `serializeWorkflowReceiptFor` below.
 *
 * That dead call site was NOT a leak, and the distinction is worth keeping
 * straight: `prepareWorkflowSave` builds the receipt snapshot from
 * `parsed.data.snapshot` (services/workflow.ts:345) — the caller's OWN
 * submitted bytes, never the stored row — so the response echoed only what
 * the request already contained. A token cannot launder plaintext through it
 * either: it reads `***` from any GET, and submitting that back changes the
 * sensitive projection, which demands `scripts:author` — a system-domain
 * point no token carries (RFC-253 D19). This is defence in depth against the
 * day a receipt starts reflecting stored bytes.
 */
export function serializeWorkflowFor<T extends { definition: unknown }>(
  record: T,
  source: ActorSource,
): T {
  if (!shouldRedactFor(source)) return record
  const masked = maskWorkflowScriptEnv(record.definition, REDACTED)
  return masked === record.definition ? record : ({ ...record, definition: masked } as T)
}

/**
 * Serialize one save RECEIPT for a specific caller (RFC-253 T28).
 *
 * `PUT /api/workflows/:id` and the overwrite arm of the YAML import both
 * answer with a `SaveWorkflowReceipt`, whose `snapshot` carries the complete
 * definition that was just written. Same masking walker, different shape —
 * kept as its own function (rather than one helper sniffing for both) so the
 * required-property constraint on each can do the routing at compile time.
 */
export function serializeWorkflowReceiptFor<T extends { snapshot: { definition: unknown } }>(
  receipt: T,
  source: ActorSource,
): T {
  if (!shouldRedactFor(source)) return receipt
  const current = receipt.snapshot.definition
  const masked = maskWorkflowScriptEnv(current, REDACTED)
  return masked === current
    ? receipt
    : ({ ...receipt, snapshot: { ...receipt.snapshot, definition: masked } } as T)
}

/**
 * Serialize one TASK for a specific caller (RFC-253 T28).
 *
 * Launching a task freezes the workflow definition into `workflowSnapshot` so
 * the run survives later edits — which means the script-node `env` values the
 * workflow read path masks are ALSO sitting in every task response, and they
 * outlive the workflow itself (the snapshot still answers after the source
 * workflow is edited or deleted). `GET /api/tasks/:id` is `tokenAccess:
 * 'allow'`, so before this an empty-matrix PAT could read them straight out.
 *
 * Same walker, same shape rule as the workflow projections. `workflowSnapshot`
 * is REQUIRED on T for the reason `serializeWorkflowFor` requires
 * `definition`: it makes "I forgot this outlet returns a task" a compile error
 * at the one place it can be caught.
 */
export function serializeTaskFor<T extends Task>(task: T, source: ActorSource): T {
  if (!shouldRedactFor(source)) return task
  const masked = maskWorkflowScriptEnv(task.workflowSnapshot, REDACTED)
  return masked === task.workflowSnapshot ? task : ({ ...task, workflowSnapshot: masked } as T)
}

/**
 * Serialize one plugin record for a specific caller.
 *
 * `PluginSpecSchema` says so itself: the spec is "the raw spec string as the
 * user typed it", capped at a length chosen to fit "git URLs with embedded
 * tokens". So `GET /api/plugins` handed any token — including an empty-matrix
 * read-only one — the git credential of every plugin its owner can see.
 */
export function serializePluginFor<T>(record: T, source: ActorSource): T {
  if (!shouldRedactFor(source) || !isPlainObject(record)) return record
  const spec = record.spec
  if (typeof spec !== 'string') return record
  return { ...record, spec: redactSensitiveString(spec) } as T
}

/**
 * Redact one persisted node-run event before it leaves through a token.
 *
 * Node events carry whatever the agent printed. The stdout ROUTE already runs
 * `redactStdout`; these rows are the same bytes reached by a different door
 * (`/node-runs/:id/events`, the `/session` reconstruction, and the WS replay),
 * and a redaction that only covers one door is a redaction the caller routes
 * around without trying.
 */
export function redactEventPayload(payload: unknown, source: ActorSource): unknown {
  if (!shouldRedactFor(source)) return payload
  if (typeof payload === 'string') return redactSensitiveString(payload)
  // Structured payloads are re-serialized so the same string rules apply to
  // every leaf, rather than only to the ones this function happens to name.
  try {
    return JSON.parse(redactSensitiveString(JSON.stringify(payload))) as unknown
  } catch {
    return payload
  }
}

/**
 * Redact a repository URL that may embed credentials.
 *
 * NOTE (design-gate correction): the RFC's first draft listed `cached_repos.url`
 * here. That field has not been on the wire since RFC-204 removed it from
 * `CachedRepoSchema`, so the rule was a no-op and its acceptance criterion —
 * "the same data stays plaintext for a session" — had no control condition.
 * The field that IS leaking is `tasks.repo_url`: `services/task.ts` returns it
 * raw from four `rowToTask` sites while sibling paths in the same file
 * deliberately call `redactGitUrl`, and `StartTaskSchema` only rejects
 * credentials in the QUERY STRING, so `https://user:token@host/repo.git` is
 * accepted, stored and handed back.
 */
export function redactRepoUrl(url: string | null | undefined): string | null {
  // Absent and empty both collapse to null: an empty string on the wire is a
  // value the client has to special-case, and there is no repo it could name.
  if (url === null || url === undefined || url === '') return null
  return redactGitUrl(url)
}

/**
 * Redact free-form agent output. Best-effort by nature — this is a text stream,
 * not a typed field — but it uses the same helper `pluginInstaller.ts` already
 * applies to captured stderr, so the platform is at least consistent about it.
 */
export function redactStdout(text: string): string {
  return redactSensitiveString(text)
}

/**
 * Redact one error payload before it leaves the process through a token.
 *
 * Needed because opencode concatenates a failed tool call's text content and
 * throws it (mcp/catalog.ts), so an unredacted message is not merely logged —
 * it lands in the model's context and, from there, wherever that conversation
 * goes.
 */
export function redactErrorText(text: string): string {
  return redactSensitiveString(text)
}
