/** Keep duplicate resource names distinguishable without making names identity. */
export function resourceOptionLabel(name: string, owner?: string): string {
  const trimmed = owner?.trim()
  return trimmed ? `${name} · ${trimmed}` : name
}
