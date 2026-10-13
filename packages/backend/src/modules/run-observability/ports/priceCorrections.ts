import type { ObservationInvocationPricePolicy } from '@agent-workflow/shared'
/** Corrective selection is separate from the immutable original acceptance; only an explicit confirmed operation can create it. */
export interface ObservationPriceCorrectionStore {
  get(
    invocationId: string,
    identity?: { readonly sourceId: string; readonly recordId: string },
  ): Promise<ObservationInvocationPricePolicy | undefined>
}
