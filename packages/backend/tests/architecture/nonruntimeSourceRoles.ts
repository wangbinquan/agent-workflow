import { createHash } from 'node:crypto'
import roles from '../fixtures/rfc395-nonruntime-source-roles.json'
import type { SourceUnit } from './census'

/** Source locks prevent this inventory becoming a directory-wide dead-code waiver. */
export function nonruntimeSourceRole(unit: SourceUnit): string | undefined {
  const entry = roles.entries.find((entry) => entry.path === unit.path)
  return entry && createHash('sha256').update(unit.text).digest('hex') === entry.sha256
    ? entry.role
    : undefined
}
