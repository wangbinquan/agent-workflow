import { z } from 'zod'
import type { NativeUsageAdmission } from '@/modules/task-execution/public/types'

const admission = z
  .object({
    registrationId: z.string().min(1).max(512),
    configurationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()

/** No population limit: page/packet sizes are unrelated to installation selection. */
export function nativeUsageAdmissions(value: string | undefined): readonly NativeUsageAdmission[] {
  if (value === undefined || value === '') return Object.freeze([])
  const parsed = z.array(admission).parse(JSON.parse(value)),
    keys = new Set<string>()
  for (const item of parsed) {
    const key = JSON.stringify([item.registrationId, item.configurationRevision])
    if (keys.has(key)) throw new Error('Duplicate native observation admission')
    keys.add(key)
    Object.freeze(item)
  }
  return Object.freeze(parsed)
}
