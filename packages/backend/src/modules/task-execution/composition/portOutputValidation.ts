import { runOutputValidationPolicy } from '@agent-workflow/shared'
import {
  bindPortOutputValidationEffects,
  portOutputValidationPolicy,
} from '../application/portOutputValidation'
import type {
  PortOutputContentValidation,
  PortOutputValidationContent,
  PortOutputValidationRequest,
} from '../application/ports/portOutputValidation'

export { NODE_VALIDATE_IO } from '../infrastructure/local/filePortOutputValidation'
export { createFilePortOutputValidationContent as createNativePortOutputValidationContent } from '../infrastructure/local/filePortOutputValidation'
// RFC-414: the native validation entry binds infrastructure IO, so it lives there; this export keeps its callers.
export { resolveNativePortContentDetailed } from '../infrastructure/local/filePortOutputValidation'

/** Select one complete content receiver, never filling missing methods from native IO. */
export function composePortOutputContentValidation(
  content: PortOutputValidationContent,
): PortOutputContentValidation {
  if (
    content === null ||
    typeof content !== 'object' ||
    typeof content.resolve !== 'function' ||
    typeof content.readUtf8 !== 'function'
  ) {
    throw new TypeError('Port output validation requires a complete content receiver')
  }
  const io = bindPortOutputValidationEffects(content)
  return Object.freeze({
    async resolve(request: PortOutputValidationRequest) {
      const { workspaceRef, ...opts } = request
      return await runOutputValidationPolicy(
        portOutputValidationPolicy({ ...opts, worktreePath: workspaceRef }, io),
      )
    },
  })
}
