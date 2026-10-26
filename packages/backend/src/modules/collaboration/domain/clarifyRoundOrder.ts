/** Round display and lookup order are independent of executable NodeRun selection. */
export function compareClarifyRoundRecency(
  a: { readonly createdAt: number },
  b: { readonly createdAt: number },
): number {
  return b.createdAt - a.createdAt
}
export function compareClarifyRoundInboxOrder(
  a: { readonly createdAt: number; readonly id: string },
  b: { readonly createdAt: number; readonly id: string },
): number {
  return compareClarifyRoundRecency(a, b) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}
