// RFC-061 PR-B — SignalKindHandler<'await-external-data'>
//
// **v1: not implemented.** design.md §4 reserves this SignalKind for
// future work (file upload, API fetch, external data integration). The
// handler exists so the SIGNAL_KIND_HANDLERS Record satisfies the closed
// SignalKind union; any actual onSuspend / applyResolution call throws
// with a clear message pointing at the design doc.
//
// To unlock this kind in a future RFC: implement the methods below,
// remove the throws, and add the corresponding NodeKindHandler dispatch
// path that emits `suspend-direct { signalKind: 'await-external-data' }`.

import type {
  SignalKindHandler,
  SuspendContext,
  ResolveContext,
  ValidationResult,
  Event,
} from '@agent-workflow/shared'

const NOT_IMPLEMENTED = 'await-external-data is reserved for a future RFC (design.md §4)'

export const awaitExternalDataSignalKindHandler: SignalKindHandler<'await-external-data'> = {
  kind: 'await-external-data',

  async onSuspend(
    _ctx: SuspendContext<'await-external-data'>,
    _body: unknown,
  ): Promise<ReadonlyArray<Event>> {
    throw new Error(NOT_IMPLEMENTED)
  },

  validateResolution(_payload: unknown): ValidationResult {
    return { valid: false, reason: NOT_IMPLEMENTED }
  },

  async applyResolution(
    _ctx: ResolveContext<'await-external-data'>,
    _payload: unknown,
  ): Promise<ReadonlyArray<Event>> {
    throw new Error(NOT_IMPLEMENTED)
  },

  effectOnLogicalRun() {
    return 'bump-iter'
  },

  renderPromptSection(_resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string {
    return ''
  },
}
