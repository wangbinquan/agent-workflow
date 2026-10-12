/** Period comparison shares one cutoff. Manual refresh or a newly committed
 * live projection advances it; merely switching seven/thirty days does not. */
export function observationPresetRange(period: 'week' | 'month' | 'all', to: number) {
  return {
    from: period === 'all' ? 0 : Math.max(0, to - (period === 'week' ? 7 : 30) * 86400000),
    to,
  }
}
