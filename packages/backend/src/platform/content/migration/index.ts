import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { CONTENT_CATALOG, contentCatalogLookup } from './catalog'
import { contentBaseRow, contentSourceTables } from './specs'
import { contentTaskLookups } from './receipts'
import { convertContentReference } from './convert'
import { publicationRow } from './publications'
import { contentResourceTasksLookup } from './resourceClosure'

function contentRule(table: string): ConversionRule {
  const target = table === 'hosted_object_publications' ? 'content_publications' : table
  return {
    ref: {
      id: `content/${table}`,
      version: 2,
    },
    owner: 'platform/content',
    claims: [table],
    produces: [
      { table: target },
      { table: 'content_objects' },
      { table: 'content_bytes' },
      ...(table === 'hosted_task_archive_entries'
        ? [{ table: 'hosted_task_archive_entry_parts' }]
        : []),
    ],
    lookups: [CONTENT_CATALOG, ...contentTaskLookups],
    unit: { kind: 'source-chunk', table },
    async convert(unit, ctx) {
      for (const row of unit.rows.get(table)!) {
        const decoded = ctx.lookup(CONTENT_CATALOG).get(row.encodedKey)
        if (!decoded || decoded.error) {
          ctx.out.block(
            rowBlock('v2-content-source-invalid', row, {
              message: decoded?.error ?? 'content catalog row missing',
            }),
          )
          continue
        }
        const values: Record<string, TargetRow[string]> = { ...contentBaseRow(row) }
        const parts: TargetRow[] = []
        let blocked = false
        for (const slot of decoded.slots) {
          const result = await convertContentReference(slot, row, ctx)
          blocked ||= result.blocked
          if (slot.skill) values.size = slot.skill.actualSize
          if (slot.receiptOnly) continue
          if (slot.part)
            parts.push({
              path: row.values.path!,
              ordinal: slot.part.ordinal,
              part_key: slot.part.key,
              content_ref_json: result.refJson,
              content_inline_bytes: result.inline,
            })
          else if (table === 'hosted_object_publications')
            Object.assign(values, publicationRow(row, result.contentId))
          else {
            values[slot.refColumn] = result.refJson
            values[slot.bytesColumn] = result.inline
          }
        }
        if (blocked) continue
        if (table === 'collaboration_gate_artifacts')
          values.final_content_key = row.values.final_path!
        ctx.out.row(target, values, row)
        for (const part of parts) ctx.out.row('hosted_task_archive_entry_parts', part, row)
      }
    },
  }
}

export const conversion: ConversionContribution = {
  rules: contentSourceTables
    .filter((table) => table !== 'skills' && table !== 'skill_versions')
    .map(contentRule),
  lookups: [contentCatalogLookup, contentResourceTasksLookup],
  validators: [],
}

export { convertFrozenSkillContent } from './skillContent'
