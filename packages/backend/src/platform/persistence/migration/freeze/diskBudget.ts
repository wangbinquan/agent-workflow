import { existsSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function availableDiskBytes(path: string): number {
  let existing = resolve(path)
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error('disk-budget-path-unavailable')
    existing = parent
  }
  const stat = statfsSync(existing, { bigint: true })
  const bytes = stat.bavail * stat.bsize
  return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes)
}

export function assertDiskBudget(input: {
  readonly path: string
  readonly requiredBytes: number
}): number {
  if (!Number.isSafeInteger(input.requiredBytes) || input.requiredBytes < 0)
    throw new Error('disk-budget-invalid')
  const available = availableDiskBytes(input.path)
  if (available < input.requiredBytes) throw new Error('disk-budget-insufficient')
  return available
}
