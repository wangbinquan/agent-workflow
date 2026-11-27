// RFC-616 §11.3 — turning one metric of a list of rows into heat levels and
// the legend that goes with them. Bins come from the shared rank rule, so the
// canvas, the duty map and the member table all bin the same way.
import { processRankBins } from '@agent-workflow/shared'
import type { HeatLevel } from '@/components/HeatScale'

export interface HeatColumn {
  /** One level per row; 0 = the metric does not apply to that row. */
  readonly levels: readonly (HeatLevel | 0)[]
  readonly min: number | null
  readonly max: number | null
}

export function heatColumn(values: readonly (number | null)[]): HeatColumn {
  const known = values.filter((value): value is number => value !== null)
  return {
    levels: processRankBins(values) as (HeatLevel | 0)[],
    min: known.length === 0 ? null : Math.min(...known),
    max: known.length === 0 ? null : Math.max(...known),
  }
}
