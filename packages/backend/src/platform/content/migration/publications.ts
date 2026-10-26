import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { contentBaseRow } from './specs'

export function publicationRow(row: SourceRow, contentId: string | null): TargetRow {
  return { ...contentBaseRow(row), content_id: contentId }
}
