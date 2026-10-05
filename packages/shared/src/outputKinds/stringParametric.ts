// RFC-060 PR-A — parametric 'string' base kind handler. Passthrough, no
// validation. Sibling to outputKinds/string.ts (which still drives the
// legacy AgentOutputKind 'string' literal in the RFC-049 HANDLERS Record);
// this module serves the same role under the new parametric registry.

import type { ParsedKind } from '../kindParser'
import type { ParametricOutputKindHandler } from './registry'

import type { ValidateResult } from './types'

const validate = (rawContent: string): ValidateResult => ({ ok: true, body: rawContent })

const handler: ParametricOutputKindHandler = {
  displayName: 'string',
  subReasons: new Set<string>(),
  matches: (p: ParsedKind) => p.kind === 'base' && p.name === 'string',
  baseNames: ['string'],
  carriesData: () => true,
  bulletSuffix: () => null,
  examplePlaceholder: () => '...',
  isReviewableBody: () => false,
  buildPromptGuidance: () => null,
  validate,
  *validationPolicy(rawContent) {
    yield* []
    return validate(rawContent)
  },
  buildRepairBlock: () => null,
}

export default handler
