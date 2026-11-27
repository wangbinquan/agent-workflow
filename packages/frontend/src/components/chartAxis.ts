// RFC-616 §11.2 — a readable value axis for the chart components: about four
// steps of 1, 2 or 5 times a power of ten, ending at or above the largest value.

export interface ChartAxis {
  readonly top: number
  readonly ticks: readonly number[]
}

export function niceAxis(max: number): ChartAxis {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] }
  const raw = max / 4
  const power = 10 ** Math.floor(Math.log10(raw))
  const mantissa = raw / power
  const step = (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * power
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let index = 0; index * step <= top + step * 1e-9; index++) {
    // Rounded so that 0.1 + 0.2 style sums do not print as 0.30000000000000004.
    ticks.push(Number((index * step).toPrecision(12)))
  }
  return { top: ticks.at(-1) ?? top, ticks }
}
