import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { HOST_PLACEHOLDERS, REFERENCED_WORKFLOW_IDS, survivingWorkflowReferences } from './lookups'
import { resourceDecision } from './evidence'

export const resourceGrantsRule: ConversionRule = {
  ref: { id: 'resource-catalog/host-grants', version: 2 },
  owner: 'resource-catalog',
  claims: ['resource_grants'],
  produces: [{ table: 'resource_grants' }],
  lookups: [HOST_PLACEHOLDERS, REFERENCED_WORKFLOW_IDS],
  unit: { kind: 'source-chunk', table: 'resource_grants' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('resource_grants') ?? []) {
      const id = String(row.values.resource_id)
      const host =
        row.values.resource_type === 'workflow' ? ctx.lookup(HOST_PLACEHOLDERS).get(id) : undefined
      if (!host) {
        ctx.out.row(row.table, row.values, row)
        continue
      }
      if (
        host.classification !== 'placeholder' ||
        survivingWorkflowReferences(ctx, id).length > 0
      ) {
        ctx.out.block(
          rowBlock('v2-host-grant-deletion-blocked', row, { hostId: id }, ['host-deletion']),
        )
        continue
      }
      resourceDecision(row, ctx, 'v2-host-grant-deleted', { hostId: id }, [], true)
    }
  },
}
