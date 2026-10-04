import type { TFunction } from 'i18next'

/** Preserve new/unknown original reasons instead of inferring zero or a missing Task owner. */
export function observationGapLabel(reason: string, t: TFunction): string {
  return t('runObservability.gap_' + reason, { defaultValue: reason })
}
