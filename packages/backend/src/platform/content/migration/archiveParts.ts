import { z } from 'zod'
import { storedObject, hostedObjectRef } from './hostedObjects'
import type { ContentRef } from '@/platform/content/contentRef'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

const part = storedObject.extend({ key: z.string().min(1) }).strict()
export interface ArchivePart {
  readonly ordinal: number
  readonly key: string
  readonly ref: ContentRef
}

export function explodeArchiveParts(entry: SourceRow): readonly ArchivePart[] {
  if (typeof entry.values.parts_json !== 'string') throw new Error('v2-archive-parts-invalid')
  const parts = z.array(part).parse(JSON.parse(entry.values.parts_json))
  if (entry.values.kind === 'directory' && parts.length)
    throw new Error('v2-archive-directory-has-parts')
  return parts.map((value, ordinal) => ({
    ordinal,
    key: value.key,
    ref: hostedObjectRef(value.id, value.sha256, value.size),
  }))
}
