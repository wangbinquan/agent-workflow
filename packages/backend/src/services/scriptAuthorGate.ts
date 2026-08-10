// RFC-253 §7 — the `scripts:author` gate.
//
// A script node's body is code the daemon host will execute, so authoring one
// is the most privileged thing this product lets a user do. The gate therefore
// lives at the two PERSISTENCE PRIMITIVES rather than at the HTTP handlers:
// `insertWorkflowInTx` and `prepareWorkflowSave` are the only ways a definition
// reaches the database, and the intent builder reaches the first one DIRECTLY
// (services/intent/applyChangeset.ts), never passing through a route. A gate on
// routes alone would be silently bypassed by the next internal caller
// (design-gate P1).
//
// What is gated is the SENSITIVE PROJECTION, not the document: an author
// without the point can still move a script node, rename it, and edit unrelated
// parts of the same workflow. What they cannot do is change what the host will
// run — and that includes rewiring the node's inbound edges (which name and
// fill its `AW_PORT_*` variables) or moving it into a loop (which decides how
// many times it runs), not just the body itself.

import {
  definitionHasScriptNode,
  serializeScriptSensitiveProjectionV1,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ForbiddenError } from '@/util/errors'
import type { Actor } from '@/auth/actor'

/**
 * Who is writing, and whether the write is a user's authored content or the
 * platform moving bytes it already holds.
 */
export type ScriptAuthorPrincipal =
  | { kind: 'actor'; actor: Actor }
  /**
   * A platform-internal write of content that already passed the gate: the
   * RFC-231 copy path duplicates one stored revision verbatim, so it introduces
   * no executable content the platform did not already accept (D21). Spelled as
   * an explicit provenance value rather than "the copy route happens not to
   * call the gate", so a future caller has to state its intent.
   */
  | { kind: 'verbatim-copy' }
  | { kind: 'system'; reason: string }

function actorMayAuthorScripts(principal: ScriptAuthorPrincipal): boolean {
  switch (principal.kind) {
    case 'actor':
      return principal.actor.permissions.has('scripts:author')
    case 'verbatim-copy':
    case 'system':
      return true
  }
}

/**
 * Throw unless this write is allowed to introduce or change script content.
 *
 * `previous` is the definition currently stored (absent for a create). When the
 * sensitive projection is unchanged the write is allowed regardless of the
 * principal — that is what keeps ordinary editing open to everyone.
 */
export function assertScriptAuthorAllowed(input: {
  next: WorkflowDefinition
  previous?: WorkflowDefinition | undefined
  principal: ScriptAuthorPrincipal
}): void {
  const nextProjection = serializeScriptSensitiveProjectionV1(input.next)
  const previousProjection =
    input.previous === undefined ? null : serializeScriptSensitiveProjectionV1(input.previous)

  // Nothing script-shaped on either side: the common case, no cost.
  if (
    !definitionHasScriptNode(input.next) &&
    (input.previous === undefined || !definitionHasScriptNode(input.previous))
  ) {
    return
  }
  // Byte-identical projection ⇒ the executable surface did not move. Comparing
  // canonical STRINGS rather than hashes keeps this exact by construction and
  // leaves a diffable artifact when someone has to debug a 403.
  if (previousProjection !== null && previousProjection === nextProjection) return

  if (actorMayAuthorScripts(input.principal)) return

  throw new ForbiddenError(
    'script-author-forbidden',
    'changing a script node (its body, language, dependencies, environment or write mode, its inbound wiring, or its wrapper placement) requires the scripts:author permission',
  )
}
