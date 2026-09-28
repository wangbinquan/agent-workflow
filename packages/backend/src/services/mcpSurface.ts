// RFC-247 D10 / AC-18 — the single reader for the external-surface master switch.
//
// Two things are gated by ONE flag on purpose: `POST /api/mcp` and the ability
// to mint new tokens. They are the same surface from an operator's point of
// view ("can the outside world drive this platform"), and splitting them would
// create a state — MCP closed, tokens still issuable — that answers no real
// question while doubling what an incident responder has to reason about.
//
// What the switch deliberately does NOT do: revoke or disable existing tokens
// on the REST channel. Flipping it during an incident should stop the bleeding
// (no new credentials, no MCP) without breaking automation that was never
// implicated. Killing a specific token is `DELETE /api/auth/pats/:id`; killing
// all of a user's is disabling the account.

import type { Config } from '@agent-workflow/shared'

/** Default-on: see the schema comment on `mcpSurfaceEnabled`. */
export function isMcpSurfaceEnabled(config: Pick<Config, 'mcpSurfaceEnabled'>): boolean {
  return config.mcpSurfaceEnabled ?? true
}

/** RFC-247 D16 — audit retention in days. */
export function tokenAuditRetentionDays(config: Pick<Config, 'tokenAuditRetentionDays'>): number {
  return config.tokenAuditRetentionDays ?? 90
}
