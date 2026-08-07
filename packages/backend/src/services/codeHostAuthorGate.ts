// RFC-269 §8 — the `code-host-calls:author` gate.
//
// Structurally identical to RFC-253's `scriptAuthorGate` (same reasoning, same
// placement, same principal model) — see that file's header for why the gate
// lives at the two PERSISTENCE PRIMITIVES rather than on the HTTP handlers: the
// intent builder writes definitions directly via
// `services/intent/applyChangeset.ts` and never passes through a route.
//
// What makes this node privileged is different from a script's, though: a
// script runs code on the daemon host, while a code-host call acts on GitLab /
// GitHub **as the platform's bot identity**, on any repository the
// administrator's token can reach. The platform's own resource ACLs cannot
// bound that reach — the permissions live on the code host, not here — which is
// exactly why authoring one is a capability rather than an ordinary edit.

import {
  definitionHasCodeHostCallNode,
  serializeCodeHostSensitiveProjectionV1,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { ForbiddenError } from '@/util/errors'
import type { Actor } from '@/auth/actor'

export type CodeHostAuthorPrincipal =
  | { kind: 'actor'; actor: Actor }
  /** RFC-231 copy path: duplicates one stored revision verbatim (see RFC-253 D21). */
  | { kind: 'verbatim-copy' }
  | { kind: 'system'; reason: string }

function mayAuthorCodeHostCalls(principal: CodeHostAuthorPrincipal): boolean {
  switch (principal.kind) {
    case 'actor':
      return principal.actor.permissions.has('code-host-calls:author')
    case 'verbatim-copy':
    case 'system':
      return true
  }
}

/**
 * Throw unless this write is allowed to introduce or change what the platform
 * will send to a code host.
 *
 * `previous` is the definition currently stored (absent for a create). An
 * unchanged sensitive projection is allowed regardless of principal — that is
 * what keeps ordinary editing (moving the node, renaming it, editing unrelated
 * parts of the same workflow) open to everyone.
 */
export function assertCodeHostAuthorAllowed(input: {
  next: WorkflowDefinition
  previous?: WorkflowDefinition | undefined
  principal: CodeHostAuthorPrincipal
}): void {
  if (
    !definitionHasCodeHostCallNode(input.next) &&
    (input.previous === undefined || !definitionHasCodeHostCallNode(input.previous))
  ) {
    return
  }
  const nextProjection = serializeCodeHostSensitiveProjectionV1(input.next)
  const previousProjection =
    input.previous === undefined ? null : serializeCodeHostSensitiveProjectionV1(input.previous)
  // Canonical STRING comparison rather than a hash: exact by construction, and
  // it leaves a diffable artifact when someone has to debug a 403.
  if (previousProjection !== null && previousProjection === nextProjection) return

  if (mayAuthorCodeHostCalls(input.principal)) return

  throw new ForbiddenError(
    'code-host-author-forbidden',
    'changing a code-host call node (its provider, action, parameters, custom request, destructive-method switch or timeout, its inbound wiring, or its wrapper placement) requires the code-host-calls:author permission',
  )
}
