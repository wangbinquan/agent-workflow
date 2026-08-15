// RFC-304 T31b — what the outside world may ASK this module to DO.
//
// One command in PR-5: turning a repository's capability on or off. Kept apart
// from `queries` because the split is the point of the entrypoint names — a
// caller that only reads never has to import a surface that can change things.
//
// ## Why enabling returns the readiness rather than a bare ok
//
// Enabling a capability whose prerequisites are missing is a legitimate action
// (a team configures in whatever order suits them), and it leaves the cell
// `misconfigured` rather than `ready`. If the command answered only "saved",
// the page would show a switch that is on next to a capability that will never
// run, and the person would learn that from the silence. Returning the derived
// readiness lets the answer be "on, but it still needs X".

import type { CodeMatrixRow } from '@/modules/code-capability/public/queries'

/**
 * What a cell's trigger may be configured with.
 *
 * A closed shape rather than an open bag. `Record<string, unknown>` would let a
 * caller send `skipBotAuthoredMR` (wrong case) and receive a cheerful 200 while
 * nothing changed — the silent-no-op class this RFC keeps running into. It also
 * leaks an unenforceable type through a public contract, which the RFC-294
 * surface guard rejects for exactly that reason.
 *
 * New settings are added HERE, deliberately, so a caller can discover them.
 */
export interface CodeTriggerConfig {
  /**
   * Which event types wake this cell. Absent means the capability's default;
   * an EMPTY array means none — somebody who cleared the list meant to stop it.
   */
  events?: readonly string[]
  /**
   * Decline to review merge requests opened by a machine. Default false: the
   * recorded product decision (E2) is that bot MRs are supervised by default.
   * Takes effect only alongside `botAuthors`.
   */
  skipBotAuthoredMr?: boolean
  /** The accounts this cell treats as machines. Named, never guessed. */
  botAuthors?: readonly string[]
}

export interface EnableCapabilityInput {
  repoId: string
  capability: string
  enabled: boolean
  /** Which group-layer binding runs it; required to reach `ready`. */
  bindingId?: string | null
  /** Per-cell trigger settings. Closed on purpose — see `CodeTriggerConfig`. */
  triggerConfig?: CodeTriggerConfig
  /** Who is asking — the cell is written under their authority. */
  actorUserId: string
}

export type EnableCapabilityResult =
  /** Saved. `row` carries the readiness that resulted, which may not be ready. */
  | { ok: true; row: CodeMatrixRow }
  /**
   * Refused, by name. Distinct from a misconfigured save: this one did NOT
   * write, and the caller must not show the switch as flipped.
   */
  | { ok: false; code: 'unknown-capability' | 'forbidden' | 'unknown-binding'; message: string }

export interface EnableCommand {
  enable(input: EnableCapabilityInput): Promise<EnableCapabilityResult>
}
